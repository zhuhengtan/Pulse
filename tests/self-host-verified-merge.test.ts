import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { acceptWorkRequests } from './helpers/work-intent.js'
import { createH5EngineInvoker, freezeMany, verifyWorkspaceFrozen, selectInvoker } from '../scripts/self-host.mjs'

const exec = promisify(execFile), roots: string[] = []
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout
async function fixture() {
  // External self-host history deliberately rejects symlinked ancestors (including macOS /var aliases).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-verified-merge-'))); roots.push(root)
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(project)
  await git(project, 'init', '--quiet'); await git(project, 'config', 'user.name', 'Fixture'); await git(project, 'config', 'user.email', 'fixture@localhost'); await git(project, 'config', 'core.autocrlf', 'false')
  await writeFile(join(project, 'code.txt'), 'base\n'); await writeFile(join(project, 'user.txt'), 'base\n'); await git(project, 'add', '.'); await git(project, 'commit', '--quiet', '-m', 'baseline')
  const manager = new H5WorkspaceManager(data)
  const workspace = await manager.prepare('conv', 'project', project, { isolated: true, externalValidation: true })
  return { root, project, data, manager, workspace }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('model acceptance defers merge across restart, then validates the integrated result before applying', async () => {
  const f = await fixture(); await writeFile(join(f.workspace.cwd, 'code.txt'), 'task\n'); await writeFile(join(f.project, 'user.txt'), 'user\n')
  expect(await f.manager.finish('conv', true)).toEqual({ status: 'pending' }); await f.manager.close()
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
  const restarted = new H5WorkspaceManager(f.data)
  expect((await restarted.get('conv'))?.externalValidation).toBe(true)
  let verified = ''
  const result = await restarted.finishVerified('conv', async cwd => {
    verified = cwd; expect(resolve(cwd)).not.toBe(resolve(f.project)); expect(resolve(cwd)).not.toBe(resolve(f.workspace.cwd))
    expect(await readFile(join(cwd, 'code.txt'), 'utf8')).toBe('task\n'); expect(await readFile(join(cwd, 'user.txt'), 'utf8')).toBe('user\n')
    expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
  })
  expect(result.status).toBe('merged'); expect(verified).toContain('integrations'); expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('task\n')
  // A late stream-finalizer cannot regress completed merge state to pending.
  expect(await restarted.finish('conv', true)).toEqual({ status: 'merged' })
  const next = await restarted.prepare('conv', 'project', f.project)
  expect(next.isolated).toBe(true); expect((await restarted.get('conv'))?.externalValidation).toBe(true)
  await restarted.close()
})

it.each(['reject', 'mutate-integration', 'mutate-candidate'])('failed or unstable verification never applies (%s)', async mode => {
  const f = await fixture(); await writeFile(join(f.workspace.cwd, 'code.txt'), 'task\n')
  await expect(f.manager.finishVerified('conv', async cwd => {
    if (mode === 'reject') throw new Error('FIXED_CHECK_FAILED')
    await writeFile(join(mode === 'mutate-integration' ? cwd : f.workspace.cwd, 'code.txt'), 'unverified\n')
  })).rejects.toThrow(mode === 'reject' ? 'FIXED_CHECK_FAILED' : mode === 'mutate-integration' ? 'SELF_HOST_VALIDATION_CHANGED_SOURCE' : 'SELF_HOST_CANDIDATE_CHANGED')
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n'); expect(await f.manager.get('conv')).toBeTruthy(); await f.manager.close()
})

it('concurrent project changes are integrated and checked again; a concurrent merge is rejected', async () => {
  const f = await fixture(); await writeFile(join(f.workspace.cwd, 'code.txt'), 'task\n'); let calls = 0
  await f.manager.finishVerified('conv', async cwd => {
    calls++
    if (calls === 1) {
      const other = new H5WorkspaceManager(f.data)
      expect((await other.finishVerified('conv', async () => {})).status).toBe('conflict'); await other.close()
      await writeFile(join(f.project, 'user.txt'), 'concurrent\n')
    } else expect(await readFile(join(cwd, 'user.txt'), 'utf8')).toBe('concurrent\n')
  })
  expect(calls).toBe(2); expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('task\n'); await f.manager.close()
}, 20_000)

it('candidate copies of frozen checks cannot be substituted while originals remain unchanged', async () => {
  const f = await fixture(), file = join(f.project, 'gate.txt'); await writeFile(file, 'frozen'); const frozen = await freezeMany([file])
  await writeFile(join(f.workspace.cwd, 'gate.txt'), 'weakened')
  await expect(verifyWorkspaceFrozen(frozen, await realpath(f.project), f.workspace.cwd, 'fixture')).rejects.toThrow('候选冻结文件被改动')
  expect(await readFile(file, 'utf8')).toBe('frozen'); await f.manager.close()
})

it('old H5 services are rejected before any task is created', async () => {
  const calls: string[] = []
  const invoke = createH5EngineInvoker({ http: { request: async (url: string) => { calls.push(url); return {} } } })
  await expect(invoke({ cwd: tmpdir(), prompt: 'repair' })).rejects.toThrow('SELF_HOST_EXTERNAL_VALIDATION_UNSUPPORTED')
  expect(calls).toEqual(['/api/session/local', '/api/session'])
})

it('real H5 route explicitly isolates self-host work and does not auto-merge model output', async () => {
  const f = await fixture(); await f.manager.close()
  const host = createLocalHost({ cwd: f.project, dataDir: f.data, jarvis: { enabled: false }, approvalMode: 'auto', taskController: false,
    mockToolCalls: [{ name: 'fs.write', input: { path: 'result.txt', content: 'isolated output' } }], mockAfterToolResponse: 'Created result.txt.' })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir: f.data, host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Origin: base, Cookie: auth.headers.get('set-cookie')!, 'Content-Type': 'application/json' }
    const post = async (path: string, body: object) => { const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }); expect(r.ok, await r.clone().text()).toBe(true); return r.json() }
    expect((await fetch(base + '/api/session', { headers }).then(r => r.json())).capabilities.selfHostExternalValidation).toBe(1)
    const project = await post('/api/projects', { name: 'Fixture', cwd: f.project })
    const denied = await fetch(base + '/api/conversations', { method: 'POST', headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, selfHostExternalValidation: true }) })
    expect(denied.status).toBe(403)
    const conversation = await post('/api/conversations', { projectId: project.id, selfHostExternalValidation: true })
    const run = await post(`/api/conversations/${conversation.id}/messages`, { text: 'Create result.txt with isolated output.' })
    await vi.waitFor(async () => expect((await fetch(`${base}/api/runs/${run.runId}/state`, { headers }).then(r => r.json())).state).toBe('succeeded'), { timeout: 10_000 })
    const manager = new H5WorkspaceManager(f.data), record = await manager.get(conversation.id)
    expect(record?.externalValidation).toBe(true); expect(record?.kind).toBe('git')
    expect(await readFile(join(record!.worktreeRoot, 'result.txt'), 'utf8')).toBe('isolated output')
    await expect(readFile(join(f.project, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); await manager.close()
  } finally { await server.stop(); await host.close() }
}, 20_000)

it('H5 connection failure never downgrades isolation into direct CLI edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-self-host-no-fallback-')); roots.push(root)
  const marker = join(root, 'cli-started'), entry = join(root, 'fake.mjs')
  await writeFile(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'unsafe fallback');console.log(JSON.stringify({type:'result',status:'succeeded',taskOutcome:'accepted'}))`)
  const invoke = selectInvoker({ transport: 'h5', cliEntry: entry, http: { request: async () => { throw Object.assign(new Error('fixture offline'), { h5ConnectError: true }) } } })
  await expect(invoke({ cwd: root, dataDir: root, prompt: 'repair' })).rejects.toThrow('未回退 CLI')
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
