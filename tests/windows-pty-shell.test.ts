import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const platform = process.platform
const directories: string[] = []
const sandbox = { reset: vi.fn(async () => {}), cleanupAfterCommand: vi.fn(), wrapWithSandboxArgv: vi.fn(), annotateStderrWithSandboxFailures: vi.fn((_id, text) => text) }
const initialize = vi.fn(async () => {}), spawn = vi.fn()
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
vi.doMock(adapterRequire.resolve('@anthropic-ai/sandbox-runtime'), () => ({ SandboxManager: sandbox }))
vi.doMock('../packages/adapters/src/tools/sandbox-initialization.js', () => ({ initializeShellSandbox: initialize }))
vi.doMock('../packages/adapters/src/tools/windows-srt-path.js', () => ({ verifiedWindowsSrt: () => '/fixed-install/srt-win.exe' }))
vi.doMock('../packages/adapters/src/tools/installation-dependencies.js', () => ({ installationDependencyRoots: async () => [], workspaceUsesInstallationDependencies: async () => false }))
vi.doMock('../packages/adapters/src/tools/windows-read-policy.js', () => ({ windowsReadDenyRoots: () => [], carveWindowsReadDenies: async (paths: string[]) => paths, windowsToolchainWriteDenies: async (paths: string[]) => paths }))
vi.doMock('node:child_process', () => ({ execFile: vi.fn(), spawn }))
const { runShell, resolveShellIdentity } = await import('../packages/adapters/src/tools/shell.js')

afterEach(async () => { Object.defineProperty(process, 'platform', { value: platform }); vi.clearAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-windows-pty-wiring-'))); directories.push(root)
  const modulePath = join(root, 'installed-node-pty', 'lib', 'index.js')
  await mkdir(dirname(modulePath), { recursive: true }); await writeFile(modulePath, 'scripted module, never executed')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const broker = ['/fixed-install/srt-win.exe', 'exec', '--quiet', '--deny-read', '/private', '--env', 'HTTPS_PROXY=loopback', '--', 'cmd.exe', '/d', '/c', 'encoded-command']
  sandbox.wrapWithSandboxArgv.mockResolvedValue({ argv: broker, env: {} })
  return { root, modulePath, broker, scope: 'ab'.repeat(16) }
}

it('runs the Windows PTY through the real runShell policy/identity path, preserving SRT and bounded output', async () => {
  const f = await fixture(), child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true) })
  const identity = await resolveShellIdentity('node', ['-e', 'literal'], f.root)
  const transport = vi.fn((argv, options) => {
    expect(argv[0]).toBe(f.broker[0]); expect(argv.slice(0, 5)).toEqual(f.broker.slice(0, 5))
    expect(argv).toContain('HTTPS_PROXY=loopback')
    expect(argv).not.toContain('cmd.exe')
    const spec = JSON.parse(Buffer.from(argv.at(-1), 'base64').toString())
    expect(spec).toEqual({ modulePath: f.modulePath, command: identity.executable, args: ['-e', 'literal'], scope: f.scope })
    expect(options.env).not.toHaveProperty('NODE_OPTIONS')
    setImmediate(() => { child.stdout.emit('data', Buffer.from('target-is-tty\n')); child.emit('close', 0) })
    return child
  })
  const beforeLaunch = vi.fn(async () => identity)
  const result = await runShell('node', ['-e', 'literal'], { cwd: f.root, expectedIdentity: identity, beforeLaunch, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: transport })
  expect(result).toMatchObject({ code: 0, stdout: 'target-is-tty\n', aborted: false })
  expect(beforeLaunch).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce()
  const policy = initialize.mock.calls[0]![0] as any
  expect(policy.network).toMatchObject({ allowedDomains: [], strictAllowlist: true })
  const bridge = await realpath(fileURLToPath(new URL('../packages/adapters/src/tools/windows-pty-bridge.cjs', import.meta.url)))
  const protocol = await realpath(fileURLToPath(new URL('../packages/adapters/src/tools/windows-pty-protocol.cjs', import.meta.url)))
  expect(policy.filesystem.allowRead).toContain(dirname(dirname(f.modulePath)))
  expect(policy.filesystem.allowRead).toContain(bridge)
  expect(policy.filesystem.allowRead).toContain(protocol)
  expect(policy.filesystem.allowRead).not.toContain(dirname(bridge))
  expect(policy.filesystem.allowWrite).not.toContain(dirname(dirname(f.modulePath)))
  expect(policy.filesystem.allowWrite).not.toContain(bridge)
  expect(policy.filesystem.allowWrite).not.toContain(protocol)
  expect(policy.filesystem.allowWrite).not.toContain(dirname(bridge))
  expect(policy.filesystem.denyWrite).toEqual(expect.arrayContaining([bridge, protocol]))
})

it.each(['abort', 'timeout'])('cancels the actual broker tree for Windows PTY %s and waits for close', async reason => {
  const f = await fixture(), controller = new AbortController()
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: null, stdin: null, kill: vi.fn(() => true) })
  spawn.mockImplementation((command, args) => {
    expect(command).toBe('taskkill.exe'); expect(args).toEqual(['/PID', '123', '/T', '/F'])
    const tree = Object.assign(new EventEmitter(), { unref: vi.fn() })
    setImmediate(() => { child.emit('close', null); tree.emit('close', 0) })
    return tree
  })
  const transport = vi.fn(() => { if (reason === 'abort') setImmediate(() => controller.abort()); return child })
  const result = await runShell('node', [], { cwd: f.root, signal: controller.signal, timeoutMs: 20, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: transport })
  expect(result).toMatchObject({ code: null, aborted: reason === 'abort', timedOut: reason === 'timeout' })
  expect(spawn).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce()
})

it('does not start a broker when cancellation lands during the final identity wait', async () => {
  const f = await fixture(), controller = new AbortController(), transport = vi.fn()
  const result = await runShell('node', [], { cwd: f.root, signal: controller.signal, beforeLaunch: async () => { controller.abort(); return undefined }, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: transport })
  expect(result).toMatchObject({ code: null, aborted: true, timedOut: false })
  expect(transport).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('does not taskkill a Windows broker after that process has already exited', async () => {
  const f = await fixture(), controller = new AbortController()
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: 0 as number | null, signalCode: null, stdout: new EventEmitter(), stderr: null, stdin: null, kill: vi.fn(() => true) })
  const transport = vi.fn(() => { setImmediate(() => controller.abort()); return child })
  const pending = runShell('node', [], { cwd: f.root, signal: controller.signal, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: transport })
  await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
  expect(spawn).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  child.emit('close', 0)
  await expect(pending).resolves.toMatchObject({ code: 0, aborted: true })
})

it('refuses a changed approval identity before starting any bridge or broker', async () => {
  const f = await fixture(), identity = await resolveShellIdentity('node', [], f.root), transport = vi.fn()
  await expect(runShell('node', [], { cwd: f.root, expectedIdentity: identity, beforeLaunch: async () => ({ ...identity, fingerprint: 'changed' }), windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: transport })).rejects.toThrow('SANDBOX_SETUP_FAILED')
  expect(transport).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
})

it('does not treat a missing or unknown Windows PTY exit as success, but keeps an explicit cancel', async () => {
  const f = await fixture()
  const missing = Object.assign(new EventEmitter(), { pid: 41, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: false, unknown: false } })
  await expect(runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => missing.emit('close', 0)); return missing } })).rejects.toThrow('AGENT_PTY_EXIT_UNKNOWN')
  const unknown = Object.assign(new EventEmitter(), { pid: 42, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: true, code: 0 } })
  await expect(runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => unknown.emit('close', 0)); return unknown } })).rejects.toThrow('AGENT_PTY_EXIT_UNKNOWN')
  const cancelled = Object.assign(new EventEmitter(), { pid: 43, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: false, unknown: false } })
  spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }))
  const controller = new AbortController()
  const pending = runShell('node', [], { cwd: f.root, signal: controller.signal, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => controller.abort()); return cancelled } })
  await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
  cancelled.emit('close', null)
  await expect(pending).resolves.toMatchObject({ aborted: true, timedOut: false, code: null })
  const exited = Object.assign(new EventEmitter(), { pid: 44, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: false, code: 7 } })
  const result = await runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => exited.emit('close', 0)); return exited } })
  expect(result).toMatchObject({ code: 7, aborted: false, timedOut: false })
  const agreed = Object.assign(new EventEmitter(), { pid: 45, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: false, code: 0 } })
  const success = await runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => agreed.emit('close', 0)); return agreed } })
  expect(success).toMatchObject({ code: 0, aborted: false, timedOut: false })
  const brokerFailed = Object.assign(new EventEmitter(), { pid: 47, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: false, code: 0 } })
  const hidden = await runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => brokerFailed.emit('close', 1)); return brokerFailed } })
  expect(hidden.code, 'A nonzero SRT broker exit must not become success').not.toBe(0)
  expect(hidden).toMatchObject({ code: 1, aborted: false, timedOut: false })
  const brokerMissing = Object.assign(new EventEmitter(), { pid: 48, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: false, code: 0 } })
  await expect(runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => brokerMissing.emit('close', null)); return brokerMissing } })).rejects.toThrow('AGENT_PTY_EXIT_UNKNOWN')
  const status = 0xC0000005 | 0
  for (const code of [256, 300, status]) {
    const failed = Object.assign(new EventEmitter(), { pid: 50 + code, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: false, code } })
    const failure = await runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => failed.emit('close', 0)); return failed } })
    expect(failure).toMatchObject({ code, aborted: false, timedOut: false })
  }
  const fractional = Object.assign(new EventEmitter(), { pid: 46, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true), windowsPtyExit: { framed: true, unknown: false, code: Number.NaN } })
  await expect(runShell('node', [], { cwd: f.root, windowsPty: { modulePath: f.modulePath, scope: f.scope }, spawnProcess: () => { setImmediate(() => fractional.emit('close', 0)); return fractional } })).rejects.toThrow('AGENT_PTY_EXIT_UNKNOWN')
})

it('kills the child when a non-Windows process-group signal fails, without taskkill', async () => {
  const f = await fixture()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  spawn.mockReset()
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: vi.fn() }, kill: vi.fn(() => true) })
  const group = vi.spyOn(process, 'kill').mockImplementation(pid => { if (pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); return true })
  try {
    const controller = new AbortController()
    const pending = runShell('node', [], { cwd: f.root, signal: controller.signal, spawnProcess: () => { setImmediate(() => controller.abort()); return child } })
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
    expect(group).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(spawn).not.toHaveBeenCalled()
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({ aborted: true, code: null })
  } finally { group.mockRestore(); spawn.mockReset() }
})
