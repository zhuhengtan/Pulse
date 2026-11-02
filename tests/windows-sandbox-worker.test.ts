import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const scripted = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../packages/adapters/src/tools/shell.js', async original => ({ ...await original<object>(), runShell: scripted.run }))
import { WindowsShellSandbox } from '../packages/adapters/src/tools/shell-sandbox.js'
import { MockAdapter } from '@hunterzhu/pulse-adapters'
import { LocalHost } from '../packages/server/src/index.js'

const directories: string[] = [], workers: WindowsShellSandbox[] = [], hosts: LocalHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.close()))
  await Promise.all(workers.splice(0).map(worker => worker.dispose()))
  vi.restoreAllMocks(); vi.unstubAllEnvs(); scripted.run.mockReset()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-sandbox-worker-')); directories.push(root)
  const module = join(root, 'fixture.mjs'), log = join(root, 'operations.jsonl')
  await writeFile(module, `import {appendFileSync} from 'node:fs';
const record=v=>appendFileSync(${JSON.stringify(log)},JSON.stringify(v)+'\\n');let current;
export const SandboxManager={
reset(){record({op:'reset'});current=undefined},
initialize(policy){current=policy;record({op:'initialize',network:policy.network,filesystem:policy.filesystem});const f=policy.fixture;const state=new Int32Array(f.shared);Atomics.store(state,0,1);if(f.crash)process.exit(9);const end=Date.now()+(f.blockMs??0);while(Date.now()<end){};Atomics.store(state,1,1)},
wrapWithSandboxArgv(command,_shell,_config,_signal,cwd,metadata){record({op:'wrap',command,cwd,metadata});return{argv:['fixed-srt.exe','exec','--',command],env:{SAFE:'local-fixture',...(process.env.PULSE_FIXTURE_WORKER_MARKER?{marker:process.env.PULSE_FIXTURE_WORKER_MARKER}:{})}}},
annotateStderrWithSandboxFailures(id,text){record({op:'annotate',id});return text+' [fixture]'},
cleanupAfterCommand(){record({op:'cleanup'})}
};
export async function initializeShellSandbox(policy,_platform,signal,check){signal.throwIfAborted();check();SandboxManager.initialize(policy);check()}
`)
  const url = pathToFileURL(module).href, worker = new WindowsShellSandbox({ manager: url, initialization: url }); workers.push(worker)
  const state = new Int32Array(new SharedArrayBuffer(8))
  const policy = (blockMs = 0, crash = false): any => ({ network: { allowedDomains: [], strictAllowlist: true }, filesystem: { allowRead: [root], allowWrite: [root], denyRead: ['private-sentinel'], denyWrite: ['protected-sentinel'] }, fixture: { blockMs, crash, shared: state.buffer } })
  await worker.reset()
  return { root, worker, state, policy, rows: async () => (await readFile(log, 'utf8')).trim().split('\n').map(row => JSON.parse(row)) }
}
async function started(state: Int32Array) { await expect.poll(() => Atomics.load(state, 0), { timeout: 5000, interval: 5 }).toBe(1) }

it('keeps blocking native preparation off the owner loop and preserves exact policy/argv/annotations and cleanup ordering', async () => {
  const f = await fixture(), policy = f.policy(250)
  const preparation = f.worker.initialize(policy)
  await started(f.state)
  await delay(20)
  expect(Atomics.load(f.state, 1), 'owner timer must run before the worker finishes its synchronous section').toBe(0)
  await preparation
  const metadata = { commandId: 'owned-invocation', commandText: 'shell.exec' }
  expect(await f.worker.wrap('literal target', undefined, f.root, metadata)).toEqual({ argv: ['fixed-srt.exe', 'exec', '--', 'literal target'], env: { SAFE: 'local-fixture' } })
  expect(await f.worker.annotate(metadata.commandId, 'bounded stderr')).toBe('bounded stderr [fixture]')
  await f.worker.cleanup(); await f.worker.reset()
  const rows = await f.rows()
  expect(rows.map(row => row.op)).toEqual(['reset', 'initialize', 'wrap', 'annotate', 'cleanup', 'reset'])
  expect(rows[1]).toMatchObject({ network: policy.network, filesystem: policy.filesystem })
  expect(rows[2]).toMatchObject({ command: 'literal target', cwd: f.root, metadata })
})

it('observes cancellation across a blocked preparation boundary and never wraps or relaunches the cancelled command', async () => {
  const f = await fixture(), controller = new AbortController()
  const preparation = f.worker.initialize(f.policy(250), controller.signal)
  const rejection = expect(preparation).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
  await started(f.state); controller.abort(); await rejection
  await expect(f.worker.wrap('must-not-launch', controller.signal, f.root, { commandId: 'cancelled', commandText: 'shell.exec' })).rejects.toThrow()
  await f.worker.reset()
  expect((await f.rows()).map(row => row.op)).toEqual(['reset', 'initialize', 'reset'])
})

it('poisons an unknown worker lifetime without retrying preparation, restarting it or falling back to the Host thread', async () => {
  const f = await fixture()
  await expect(f.worker.initialize(f.policy(0, true))).rejects.toMatchObject({ code: 'WINDOWS_SANDBOX_WORKER_UNKNOWN' })
  await expect(f.worker.reset()).rejects.toMatchObject({ code: 'WINDOWS_SANDBOX_WORKER_UNKNOWN' })
  await expect(f.worker.wrap('no replay', undefined, f.root, { commandId: 'unknown', commandText: 'shell.exec' })).rejects.toMatchObject({ code: 'WINDOWS_SANDBOX_WORKER_UNKNOWN' })
  expect((await f.rows()).map(row => row.op)).toEqual(['reset', 'initialize'])
})

it('keeps an actual Host read within its original short Effect budget while the native service is blocked', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'local.txt'), 'local evidence\n')
  const host = new LocalHost({ cwd: f.root, dataDir: join(f.root, 'data'), provider: { provider: 'mock' }, taskController: false, taskControllerPolicy: 'legacy', jarvis: { enabled: false }, approvalMode: 'auto' }); hosts.push(host)
  const original = (host as any).runtimeFor.bind(host)
  let runtime: any, work = 0, warm = true
  ;(host as any).runtimeFor = async (...args: any[]) => {
    const value = await original(...args); runtime = value.runtime
    const tool = value.registry.get('fs.read'); tool.manifest.defaultTimeoutMs = 500
    const execute = tool.execute
    tool.execute = async (input: unknown, context: unknown) => {
      if (!warm) expect(Atomics.load(f.state, 1)).toBe(0)
      const result = await execute(input, context)
      if (!warm) expect(Atomics.load(f.state, 1)).toBe(0)
      return result
    }
    return value
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_EXTERNAL_REQUEST'))
  vi.spyOn(MockAdapter.prototype, 'executeAttempt').mockImplementation(async () => {
    if (warm || ++work > 1) return { text: 'Local fixture finished.', toolCalls: [], finishReason: 'stop' }
    return { text: '', toolCalls: [{ toolCallId: 'read', name: 'fs.read', input: { path: 'local.txt' } }], finishReason: 'tool_calls' }
  })
  const c = await host.createConversation(); const first = await host.sendMessage(c.id, { text: 'Warm local fixture.' }); for await (const _ of first.events) {}
  expect((await first.outcome()).status).toBe('succeeded')
  warm = false
  const preparation = f.worker.initialize(f.policy(5000)); await started(f.state)
  const run = await host.sendMessage(c.id, { text: 'Read local evidence.' }); for await (const _ of run.events) {}
  expect((await run.outcome()).error).toBeUndefined()
  const read = [...runtime.state.effects.values()].find((effect: any) => effect.input?.name === 'fs.read') as any
  expect(read.attemptTimeoutMs).toBe(500); expect(read.outcome.status).toBe('succeeded')
  expect(fetch).not.toHaveBeenCalled()
  await preparation; await f.worker.cleanup(); await f.worker.reset()
}, 20000)

it('ships the trusted worker as an exact built asset rather than resolving a workspace script', async () => {
  expect(await readFile(new URL('../packages/adapters/dist/tools/windows-sandbox-worker.cjs', import.meta.url))).toEqual(await readFile(new URL('../packages/adapters/src/tools/windows-sandbox-worker.cjs', import.meta.url)))
})

it('returns a maximum long poll inside the unchanged 30s Host Effect deadline, without resubmitting the process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-poll-headroom-')); directories.push(root)
  scripted.run.mockImplementation(async (_command, _args, options) => {
    await new Promise<void>(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', () => resolve(), { once: true }) })
    return { code: null, aborted: true, timedOut: false, stdout: '', stderr: '', truncated: false }
  })
  const { resolveShellIdentity } = await import('@hunterzhu/pulse-adapters')
  const identity = await resolveShellIdentity('node', ['--version'], root)
  const host = new LocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' }, taskController: false, taskControllerPolicy: 'legacy', jarvis: { enabled: false }, approvalMode: 'ask', execPolicy: { rules: [{ pattern: [identity.path, '--version'], decision: 'allow' }] } }); hosts.push(host)
  const original = (host as any).runtimeFor.bind(host)
  let runtime: any, work = 0, elapsed = 0, polled = false
  ;(host as any).runtimeFor = async (...args: any[]) => {
    const value = await original(...args); runtime = value.runtime
    const tool = value.registry.get('shell.poll'), execute = tool.execute
    tool.execute = async (input: unknown, context: unknown) => { const began = Date.now(); const result = await execute(input, context); elapsed = Date.now() - began; polled = true; return result }
    return value
  }
  vi.spyOn(MockAdapter.prototype, 'executeAttempt').mockImplementation(async params => {
    work++
    const call = (name: string, input: object) => ({ text: '', toolCalls: [{ toolCallId: 'fixture-' + work, name, input }], finishReason: 'tool_calls' as const })
    if (work === 1) return call('shell.start', { command: 'node', args: ['--version'] })
    let processId: string | undefined
    const inspect = (row: any): void => { if (Array.isArray(row)) row.forEach(inspect); else if (row && typeof row === 'object') { if (typeof row.processId === 'string') processId = row.processId; Object.values(row).forEach(inspect) } }
    params.request.blocks.filter(block => block.kind === 'results').forEach(block => inspect(block.content))
    for (const row of params.request.contextSpec.providerHistory ?? []) if (row.role === 'tool') { try { inspect(JSON.parse(row.content)) } catch {} }
    if (work === 2) return call('shell.poll', { processId, waitMs: 30_000 })
    if (work === 3) return call('ask.choice', { prompt: 'End the owned protocol fixture.', options: [{ label: 'End', value: 'end' }] })
    throw new Error('UNEXPECTED_MODEL_REPLAY')
  })
  const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Poll this one owned local process.' })
  for await (const event of run.events) {
    if (event.type !== 'waiting') continue
    const effectId = String((event.data as any).effectId)
    const group = (await run.pendingInteractions()).find(row => row.items.some(item => item.effectId === effectId))
    if (group?.kind === 'approval') await run.reply(effectId, { approved: true })
    else await run.cancel()
  }
  const poll = [...runtime.state.effects.values()].find((effect: any) => effect.input?.name === 'shell.poll') as any
  expect(polled).toBe(true); expect(poll.attemptTimeoutMs).toBe(30_000); expect(poll.outcome.status).toBe('succeeded')
  expect(elapsed).toBeGreaterThanOrEqual(28_000); expect(elapsed).toBeLessThan(30_000)
  expect(scripted.run).toHaveBeenCalledOnce(); expect(work).toBe(3)
  expect((await run.outcome()).status).toBe('cancelled')
}, 45000)


it('observes current Host environment changes between calls rather than retaining a stale worker snapshot', async () => {
  const f = await fixture(); await f.worker.initialize(f.policy())
  const metadata = { commandId: 'environment', commandText: 'shell.exec' }
  vi.stubEnv('PULSE_FIXTURE_WORKER_MARKER', 'first-local-marker')
  expect((await f.worker.wrap('first', undefined, f.root, metadata)).env.marker).toBe('first-local-marker')
  vi.stubEnv('PULSE_FIXTURE_WORKER_MARKER', 'second-local-marker')
  expect((await f.worker.wrap('second', undefined, f.root, metadata)).env.marker).toBe('second-local-marker')
  await f.worker.cleanup(); await f.worker.reset()
})


it('keeps one Windows owner and whole-command lease across module reloads', async () => {
  const first = await import('../packages/adapters/src/tools/shell-sandbox.js')
  const owner = first.windowsShellSandbox()
  vi.resetModules()
  const second = await import('../packages/adapters/src/tools/shell-sandbox.js')
  expect(second.windowsShellSandbox()).toBe(owner)
  let release!: () => void, entered = false
  const held = first.withWindowsSandboxLease(() => new Promise<void>(resolve => { release = resolve }))
  const later = second.withWindowsSandboxLease(async () => { entered = true })
  await delay(10); expect(entered).toBe(false)
  release(); await held; await later; expect(entered).toBe(true)
})
