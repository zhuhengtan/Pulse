import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const platform = process.platform
const directories: string[] = []
const ipcDirectories: string[] = []
const sandbox = { reset: vi.fn(async () => {}), cleanupAfterCommand: vi.fn(), wrapWithSandboxArgv: vi.fn(), annotateStderrWithSandboxFailures: vi.fn((_id, text) => text) }
const initialize = vi.fn(async (_policy: unknown) => {}), spawn = vi.fn()
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
vi.doMock(adapterRequire.resolve('@anthropic-ai/sandbox-runtime'), () => ({ SandboxManager: sandbox }))
vi.doMock('../packages/adapters/src/tools/sandbox-initialization.js', () => ({ initializeShellSandbox: initialize }))
vi.doMock('../packages/adapters/src/tools/shell-sandbox.js', async () => {
  const actual = await vi.importActual<typeof import('../packages/adapters/src/tools/shell-sandbox.js')>('../packages/adapters/src/tools/shell-sandbox.js')
  return { ...actual, shellSandboxManager: () => actual.directShellSandbox() }
})
vi.doMock('../packages/adapters/src/tools/windows-srt-path.js', () => ({ verifiedWindowsSrt: () => '/fixed-install/srt-win.exe' }))
vi.doMock('../packages/adapters/src/tools/installation-dependencies.js', () => ({ installationDependencyRoots: async () => [], workspaceUsesInstallationDependencies: async () => false }))
vi.doMock('../packages/adapters/src/tools/windows-read-policy.js', () => ({ windowsReadDenyRoots: () => [], carveWindowsReadDenies: async (paths: string[]) => paths, windowsToolchainWriteDenies: async (paths: string[]) => paths }))
vi.doMock('node:child_process', () => ({ execFile: vi.fn(), spawn }))
// Changing process.platform does not create POSIX filesystem roots on Windows.
// Keep real filesystem setup/cleanup, but place the mocked POSIX IPC root in the
// native temp directory rather than requiring a drive-root /tmp directory.
vi.doMock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, mkdtemp: async (prefix: string) => {
    if (!prefix.startsWith(join('/tmp', 'pulse-shell-ipc-'))) return actual.mkdtemp(prefix)
    const directory = await actual.mkdtemp(join(tmpdir(), basename(prefix)))
    ipcDirectories.push(directory)
    return directory
  } }
})
const { runShell, resolveShellIdentity } = await import('../packages/adapters/src/tools/shell.js')

afterEach(async () => { Object.defineProperty(process, 'platform', { value: platform }); vi.clearAllMocks(); vi.unstubAllEnvs(); await Promise.all([...directories.splice(0), ...ipcDirectories.splice(0)].map(path => rm(path, { recursive: true, force: true }))) })
async function settleFixture(controller: AbortController, child: EventEmitter, pending: Promise<unknown>, code: number | null = null): Promise<void> {
  // If setup has not installed close listeners yet, abort prevents a late launch.
  controller.abort()
  child.emit('close', code)
  await pending
}
function waitBeforeSettlement(pending: Promise<unknown>, check: () => void): Promise<unknown> {
  return Promise.race([pending.then(() => { throw new Error('Shell settled before cancellation was checked') }), vi.waitFor(check)])
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-windows-pty-wiring-'))); directories.push(root)
  const modulePath = join(root, 'installed-node-pty', 'lib', 'index.js')
  await mkdir(dirname(modulePath), { recursive: true }); await writeFile(modulePath, 'scripted module, never executed')
  vi.stubEnv('SystemRoot', 'C:\\Windows')
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
    expect(command).toBe('C:\\Windows\\System32\\taskkill.exe'); expect(args).toEqual(['/PID', '123', '/T', '/F'])
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
  try {
    await waitBeforeSettlement(pending, () => expect(controller.signal.aborted).toBe(true))
    expect(spawn).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('close', 0)
    await expect(pending).resolves.toMatchObject({ code: 0, aborted: true })
  } finally { await settleFixture(controller, child, pending, 0) }
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
  try {
    await waitBeforeSettlement(pending, () => expect(controller.signal.aborted).toBe(true))
    cancelled.emit('close', null)
    await expect(pending).resolves.toMatchObject({ aborted: true, timedOut: false, code: null })
  } finally { await settleFixture(controller, cancelled, pending) }
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

it.each(['linux', 'darwin'] as const)('kills the child when a %s process-group signal fails, without taskkill', async targetPlatform => {
  const f = await fixture()
  Object.defineProperty(process, 'platform', { value: targetPlatform })
  spawn.mockReset()
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: vi.fn() }, kill: vi.fn(() => true) })
  const group = vi.spyOn(process, 'kill').mockImplementation(pid => { if (pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); return true })
  const controller = new AbortController()
  const transport = vi.fn(() => { setImmediate(() => controller.abort()); return child })
  const pending = runShell('node', [], { cwd: f.root, signal: controller.signal, spawnProcess: transport })
  try {
    // Surface setup rejection directly instead of hiding it behind a kill poll.
    await waitBeforeSettlement(pending, () => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
    expect(transport).toHaveBeenCalledOnce()
    expect(group).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(spawn).not.toHaveBeenCalled()
    expect(ipcDirectories).toHaveLength(1)
    expect(dirname(ipcDirectories[0]!)).toBe(tmpdir())
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({ aborted: true, code: null })
    await expect(access(ipcDirectories[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    // Consume close and cleanup while the platform and signal mock still apply.
    try { await settleFixture(controller, child, pending) } finally { group.mockRestore(); spawn.mockReset() }
  }
})

it.each([
  ['win32', 'initialize'], ['win32', 'identity'],
  ['linux', 'initialize'], ['linux', 'identity'],
] as const)('drains failed fixture cleanup during %s %s setup before restoring mocks', async (targetPlatform, stage) => {
  const f = await fixture()
  Object.defineProperty(process, 'platform', { value: targetPlatform })
  const controller = new AbortController()
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: null, stdin: null, kill: vi.fn(() => true) })
  const transport = vi.fn(() => { setImmediate(() => controller.abort()); return child })
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const gate = async () => { enter(); await blocked }
  if (stage === 'initialize') initialize.mockImplementationOnce(gate)
  const pending = runShell('node', [], { cwd: f.root, signal: controller.signal, spawnProcess: transport, ...(stage === 'identity' ? { beforeLaunch: async () => { await gate(); return undefined } } : {}) })
  const group = vi.spyOn(process, 'kill').mockReturnValue(true)
  const failure = new Error('fixture assertion failed before launch')
  const attempt = async () => {
    try {
      await Promise.race([entered, pending])
      expect(child.listenerCount('close')).toBe(0)
      throw failure
    } finally {
      // Simulate a failed wait while setup is still blocked. Cleanup must abort
      // before releasing that setup, rather than losing an early close event.
      const cleanup = settleFixture(controller, child, pending)
      release()
      await cleanup
    }
  }
  try {
    await expect(attempt()).rejects.toBe(failure)
    await expect(pending).resolves.toMatchObject({ aborted: true, code: null })
    expect(transport).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(group).not.toHaveBeenCalled()
    expect(sandbox.cleanupAfterCommand).toHaveBeenCalledOnce()
    const policy = initialize.mock.calls[0]![0] as { filesystem: { allowWrite: string[] } }
    const temporaryRoots = policy.filesystem.allowWrite.filter(path => path !== f.root)
    expect(temporaryRoots).toHaveLength(targetPlatform === 'win32' ? 1 : 2)
    for (const root of temporaryRoots) await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = Object.assign(new EventEmitter(), { pid: 4243, stdout: null, stderr: null, stdin: null, kill: vi.fn(() => true) })
    await expect(runShell('node', [], { cwd: f.root, spawnProcess: () => { setImmediate(() => next.emit('close', 0)); return next } })).resolves.toMatchObject({ code: 0, aborted: false })
  } finally { group.mockRestore() }
})
