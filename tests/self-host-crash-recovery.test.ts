import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { once } from 'node:events'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'
// Vitest 2.1.9 has no vi.getConfig(); read the same platform budget from the repo config.
import vitestConfig from '../vitest.config'

const exec = promisify(execFile), roots: string[] = []
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-crash-recovery-'))); roots.push(root)
  // Every Git invocation, including the manager's internal child processes,
  // inherits an empty synthetic home/config and cannot execute user hooks.
  const home = join(root, 'home'), hooks = join(root, 'empty-hooks'), config = join(root, 'gitconfig')
  await mkdir(home); await mkdir(hooks); await writeFile(config, `[core]\n hooksPath = ${JSON.stringify(hooks.replaceAll('\\', '/'))}\n[commit]\n gpgSign = false\n[tag]\n gpgSign = false\n`)
  for (const key of Object.keys(process.env)) if (/^(GIT_|PULSE_)/.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PULSE_HOME: join(home, 'pulse'), PULSE_DATA_DIR: join(root, 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' })) vi.stubEnv(key, value)
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(project)
  await git(project, 'init', '--quiet'); await git(project, 'config', 'user.name', 'Fixture'); await git(project, 'config', 'user.email', 'fixture@localhost')
  await writeFile(join(project, 'code.txt'), 'base\n'); await git(project, 'add', '.'); await git(project, 'commit', '--quiet', '-m', 'base')
  const manager = new H5WorkspaceManager(data)
  const workspace = await manager.prepare('conv', 'project', project, { isolated: true, externalValidation: true })
  await writeFile(join(workspace.cwd, 'code.txt'), 'task\n')
  return { root, project, data, manager, workspace, lock: join(project, '.git/pulse-workspace-merge.lock') }
}
afterEach(async () => { try { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) } finally { vi.unstubAllEnvs() } })

// Transpile only the three standalone source modules into this fixture. Never
// build or use repository dist, and never start H5, a provider or a real service.
async function childModule(root: string) {
  const out = join(root, 'modules'); await mkdir(join(out, 'h5'), { recursive: true })
  await writeFile(join(out, 'package.json'), '{"type":"module"}')
  for (const name of ['h5/workspaces', 'h5/dependencies', 'atomic-file']) {
    const source = await readFile(resolve(`packages/server/src/${name}.ts`), 'utf8')
    await writeFile(join(out, `${name}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
  }
  return join(out, 'h5/workspaces.js')
}

it('a real SIGKILL during verification leaves a lock and never silently retries the merge', async () => {
  const f = await fixture(), module = await childModule(f.root)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {H5WorkspaceManager} from ${JSON.stringify(module)}; const m=new H5WorkspaceManager(${JSON.stringify(f.data)}); await m.finishVerified('conv',async()=>{process.send('validating');await new Promise(()=>{});});`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(x => { throw new Error(`child exited early: ${x}`) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child marker timeout')), 15000); timer.unref() })])
    child.kill('SIGKILL'); await once(child, 'exit')
    const lock = await readFile(f.lock, 'utf8')
    expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
    expect(await f.manager.finishVerified('conv', async () => {})).toMatchObject({ status: 'conflict', error: 'WORKSPACE_MERGE_LOCKED' })
    expect(await readFile(f.lock, 'utf8')).toBe(lock)
    expect((await f.manager.get('conv'))?.status).toBe('running')
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } }
}, 25000)

it('real apply followed by failed record save is durable uncertainty and cannot be retried', async () => {
  const f = await fixture(), original = (f.manager as any).save.bind(f.manager)
  const index = await readFile(join(f.project, '.git/index'))
  ;(f.manager as any).save = async (record: any) => { if (record.status === 'merged') throw new Error('INJECT_SAVE_AFTER_APPLY'); return original(record) }
  await expect(f.manager.finishVerified('conv', async () => {})).rejects.toThrow('INJECT_SAVE_AFTER_APPLY')
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('task\n')
  expect(await readFile(join(f.project, '.git/index'))).toEqual(index)
  expect((await f.manager.get('conv'))?.mergeState).toBe('applying')
  const restarted = new H5WorkspaceManager(f.data)
  await expect(restarted.finishVerified('conv', async () => { throw new Error('MUST_NOT_VALIDATE') })).rejects.toThrow('WORKSPACE_MERGE_RESULT_UNKNOWN')
  await expect(restarted.prepare('conv', 'project', f.project)).rejects.toThrow('WORKSPACE_MERGE_RESULT_UNKNOWN')
})

it('a delayed stream finalizer cannot overwrite a merged record read by another manager', async () => {
  const f = await fixture(), delayed = new H5WorkspaceManager(f.data)
  const original = delayed.get.bind(delayed)
  let release!: () => void, reached!: () => void
  const paused = new Promise<void>(r => { reached = r }), gate = new Promise<void>(r => { release = r })
  let reads = 0
  delayed.get = async id => { const record = await original(id); if (++reads === 1) { reached(); await gate } return record }
  const late = delayed.finish('conv', true)
  await paused
  try { expect((await f.manager.finishVerified('conv', async () => {})).status).toBe('merged') }
  finally { release() }
  expect(await late).toEqual({ status: 'merged' })
  expect((await original('conv'))?.status).toBe('merged')
})

describe.each([true, false])('the synchronous final checkpoint (has patch=%s)', patch => {
  type Fixture = Awaited<ReturnType<typeof fixture>>
  // Setup (fixture creation plus the cancelled finishVerified call) is separate from
  // the retry. In the retry suite it runs in beforeEach, which uses the existing
  // platform test budget (the resolved Vitest testTimeout); in the cancellation
  // test it runs in the test body under that same per-test budget.
  async function cancelled() {
    const f = await fixture()
    if (!patch) await writeFile(join(f.workspace.cwd, 'code.txt'), 'base\n')
    const index = await readFile(join(f.project, '.git/index'))
    let called = 0
    await expect(f.manager.finishVerified('conv', async () => {}, { beforeApply: () => { called++; throw new Error('CANCEL_BEFORE_APPLY') } })).rejects.toMatchObject({ message: 'CANCEL_BEFORE_APPLY', selfHostMerge: 'not_applied' })
    expect(called).toBe(1)
    expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(join(f.project, '.git/index'))).toEqual(index)
    expect((await f.manager.get('conv'))?.mergeState).toBeUndefined()
    return { f, index }
  }

  it('prevents apply', async () => { await cancelled() })

  describe('retry after cancellation', () => {
    let f: Fixture, index: Buffer
    beforeEach(async () => { ({ f, index } = await cancelled()) }, vitestConfig.test?.testTimeout)
    it('merges and leaves the index unchanged', async () => {
      // Retry: only this finishVerified call, under its own existing platform test budget
      // (separate from the setup hook above).
      expect((await f.manager.finishVerified('conv', async () => {})).status).toBe('merged')
      expect(await readFile(join(f.project, '.git/index'))).toEqual(index)
      expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe(patch ? 'task\n' : 'base\n')
    })
  })
})

it('a lock PID write failure closes and removes only the acquired lock', async () => {
  const f = await fixture(), module = await childModule(f.root)
  // Patch a built-in in this new process only. Git still runs normally.
  const source = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.open; let closed=false;
    fs.open=async(...args)=>{const h=await original(...args); if(args[0]!==${JSON.stringify(f.lock)})return h;
      return {writeFile:async()=>{throw new Error('INJECT_LOCK_WRITE')},close:async()=>{closed=true;return h.close()}};};
    syncBuiltinESMExports(); const {H5WorkspaceManager}=await import(${JSON.stringify(module)});
    try {await new H5WorkspaceManager(${JSON.stringify(f.data)}).finishVerified('conv',async()=>{});process.exitCode=2;}
    catch(e){if(e.message!=='INJECT_LOCK_WRITE'||e.selfHostMerge!=='not_applied'||!closed)throw e;}
    try{await fs.stat(${JSON.stringify(f.lock)});throw new Error('LOCK_LEAKED')}catch(e){if(e.code!=='ENOENT')throw e;}`
  await exec(process.execPath, ['--input-type=module', '-e', source])
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
  expect((await f.manager.finishVerified('conv', async () => {})).status).toBe('merged')
})

it('SIGKILL after real apply and before saving merged preserves an unknown result across restart', async () => {
  const f = await fixture(), module = await childModule(f.root)
  const source = `import {H5WorkspaceManager} from ${JSON.stringify(module)};
    const m=new H5WorkspaceManager(${JSON.stringify(f.data)}), save=m.save.bind(m);
    m.save=async r=>{if(r.status==='merged'){process.send('applied');await new Promise(()=>{});}return save(r)};
    await m.finishVerified('conv',async()=>{});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(x => { throw new Error(`child exited early: ${x}`) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child marker timeout')), 15000); timer.unref() })])
    child.kill('SIGKILL'); await once(child, 'exit')
    expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('task\n')
    expect((await f.manager.get('conv'))?.mergeState).toBe('applying')
    await expect(f.manager.finishVerified('conv', async () => {})).rejects.toThrow('WORKSPACE_MERGE_RESULT_UNKNOWN')
    await expect(f.manager.finish('conv', false)).rejects.toThrow('WORKSPACE_MERGE_RESULT_UNKNOWN')
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } }
}, 25000)

it.each([String(process.pid), '', 'unrecognized-owner'])('never steals an active or unidentified lock (%j)', async contents => {
  const f = await fixture(), before = await readFile(join(f.data, 'workspaces/records/conv.json'), 'utf8')
  await writeFile(f.lock, contents)
  expect(await f.manager.finishVerified('conv', async () => { throw new Error('MUST_NOT_VALIDATE') })).toMatchObject({ status: 'conflict', error: 'WORKSPACE_MERGE_LOCKED' })
  expect(await readFile(f.lock, 'utf8')).toBe(contents)
  expect(await readFile(join(f.data, 'workspaces/records/conv.json'), 'utf8')).toBe(before)
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
})

it('failed cancellation-state persistence stays uncertain rather than authorizing a retry', async () => {
  const f = await fixture(), save = (f.manager as any).save.bind(f.manager)
  let cancel = false
  ;(f.manager as any).save = async (r: any) => { if (cancel) throw new Error('INJECT_CANCEL_SAVE'); return save(r) }
  const result = f.manager.finishVerified('conv', async () => {}, { beforeApply: () => { cancel = true; throw new Error('CANCEL') } })
  await expect(result).rejects.toThrow('INJECT_CANCEL_SAVE')
  await expect(result).rejects.not.toHaveProperty('selfHostMerge')
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n')
  expect((await f.manager.get('conv'))?.mergeState).toBe('applying')
  await expect(new H5WorkspaceManager(f.data).finishVerified('conv', async () => {})).rejects.toThrow('WORKSPACE_MERGE_RESULT_UNKNOWN')
})

it.each(['merged', 'applying'])('a delayed prepare cannot erase a newer %s record', async state => {
  const f = await fixture(), delayed = new H5WorkspaceManager(f.data), original = delayed.get.bind(delayed)
  let release!: () => void, reached!: () => void, reads = 0
  const paused = new Promise<void>(r => { reached = r }), gate = new Promise<void>(r => { release = r })
  delayed.get = async id => { const record = await original(id); if (++reads === 1) { reached(); await gate } return record }
  const preparing = delayed.prepare('conv', 'project', f.project)
  // Attach rejection handling before releasing the gate.
  const assertion = expect(preparing).rejects.toThrow(state === 'merged' ? 'WORKSPACE_ALREADY_FINISHED' : 'WORKSPACE_MERGE_RESULT_UNKNOWN')
  await paused
  if (state === 'applying') {
    const save = (f.manager as any).save.bind(f.manager)
    ;(f.manager as any).save = async (r: any) => { if (r.status === 'merged') throw new Error('INJECT_SAVE'); return save(r) }
  }
  try {
    if (state === 'merged') await f.manager.finishVerified('conv', async () => {})
    else await expect(f.manager.finishVerified('conv', async () => {})).rejects.toThrow('INJECT_SAVE')
  } finally { release() }
  await assertion
  expect(await original('conv')).toMatchObject(state === 'merged' ? { status: 'merged' } : { mergeState: 'applying' })
})
