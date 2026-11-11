import { acceptWorkRequests } from './helpers/work-intent.js'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'

const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(gitProject: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-current-workspace-')); roots.push(root)
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(project)
  const git = async (...args: string[]) => (await exec('git', args, { cwd: project })).stdout
  if (gitProject) {
    await git('init', '-q'); await git('config', 'user.name', 'Pulse Test'); await git('config', 'user.email', 'test@localhost')
    await writeFile(join(project, 'input.txt'), 'base\n'); await git('add', '.'); await git('commit', '-qm', 'fixture')
    await writeFile(join(project, 'input.txt'), 'user staged\n'); await git('add', 'input.txt')
    await writeFile(join(project, 'input.txt'), 'user unstaged\n')
  }
  await writeFile(join(project, 'untracked.txt'), 'keep me')
  return { project, data, git }
}

it.each([false, true])('defaults to the exact selected directory without needing Git (Git project: %s)', async gitProject => {
  const f = await fixture(gitProject), manager = new H5WorkspaceManager(f.data)
  const before = gitProject ? await f.git('diff', '--cached', '--binary') : ''
  const head = gitProject ? await f.git('rev-parse', 'HEAD') : ''
  const branch = gitProject ? await f.git('symbolic-ref', 'HEAD') : ''
  const savedPath = process.env.PATH
  try {
    // Default preparation/finish must work even if no git executable is installed.
    process.env.PATH = join(f.project, 'no-executables')
    const prepared = await manager.prepare('current', 'project', f.project)
    expect(prepared).toEqual({ cwd: await realpath(f.project), isolated: false })
    await writeFile(join(prepared.cwd, 'result.txt'), 'direct result')
    await manager.finish('current', false)
    expect(await readFile(join(f.project, 'result.txt'), 'utf8')).toBe('direct result')
    expect((await manager.prepare('current', 'project', f.project)).isolated).toBe(false)
    await manager.finish('current', true)
    expect(await readdir(join(f.data, 'workspaces', 'git')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))).toEqual([])
    expect(await readdir(join(f.data, 'workspaces', 'integrations')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))).toEqual([])
    expect(await readFile(join(f.project, 'untracked.txt'), 'utf8')).toBe('keep me')
  } finally { process.env.PATH = savedPath; await manager.close() }
  if (gitProject) {
    expect(await f.git('diff', '--cached', '--binary')).toBe(before)
    expect(await f.git('rev-parse', 'HEAD')).toBe(head)
    expect(await f.git('symbolic-ref', 'HEAD')).toBe(branch)
    expect(await readFile(join(f.project, 'input.txt'), 'utf8')).toBe('user unstaged\n')
    expect((await f.git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1)
  } else expect(await readdir(f.project)).not.toContain('.git')
})

it('retains unfinished isolated work across restart and stops isolating after it has been integrated', async () => {
  const f = await fixture(true), first = new H5WorkspaceManager(f.data)
  const isolated = await first.prepare('legacy', 'project', f.project, { isolated: true })
  await writeFile(join(isolated.cwd, 'retained.txt'), 'unfinished work')
  await first.finish('legacy', false); await first.close()
  const restarted = new H5WorkspaceManager(f.data)
  try {
    expect(await restarted.prepare('legacy', 'project', f.project)).toEqual(isolated)
    expect(await readFile(join(isolated.cwd, 'retained.txt'), 'utf8')).toBe('unfinished work')
    expect(await restarted.finish('legacy', true)).toMatchObject({ status: 'merged' })
    expect(await restarted.prepare('legacy', 'project', f.project)).toEqual({ cwd: await realpath(f.project), isolated: false })
  } finally { await restarted.close() }
})

it.each([false, true])('writes directly through the real H5 project task route (Git project: %s)', async gitProject => {
  const f = await fixture(gitProject)
  const host = createLocalHost({ cwd: f.project, dataDir: f.data, jarvis: { enabled: false }, approvalMode: 'auto', taskController: false,
    mockToolCalls: [{ name: 'fs.write', input: { path: 'result.txt', content: 'H5 direct result' } }], mockAfterToolResponse: 'Created result.txt.' })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir: f.data, host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const auth = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Origin: base, Cookie: auth.headers.get('set-cookie')!, 'Content-Type': 'application/json' }
    const post = async (path: string, body: object) => { const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }); expect(r.ok, await r.clone().text()).toBe(true); return r.json() }
    const project = await post('/api/projects', { name: 'Fixture', cwd: f.project })
    const conversation = await post('/api/conversations', { projectId: project.id, title: 'Direct directory task' })
    const run = await post(`/api/conversations/${conversation.id}/messages`, { text: 'Create result.txt with H5 direct result.' })
    await vi.waitFor(async () => expect((await fetch(`${base}/api/runs/${run.runId}/state`, { headers }).then(r => r.json())).state).toBe('succeeded'), { timeout: 10_000 })
    expect(await readFile(join(f.project, 'result.txt'), 'utf8')).toBe('H5 direct result')
    expect((await new H5WorkspaceManager(f.data).get(conversation.id))?.kind).toBe('shared')
    expect(await host.getConversationWorkspace(conversation.id)).toBe(await realpath(f.project))
    expect(await readdir(join(f.data, 'workspaces', 'git')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))).toEqual([])
  } finally { await server.stop(); await host.close() }
}, 20_000)
