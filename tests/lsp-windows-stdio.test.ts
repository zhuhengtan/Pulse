import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const platform = process.platform
const directories: string[] = []
const sandbox = { reset: vi.fn(async () => {}), cleanupAfterCommand: vi.fn(), wrapWithSandboxArgv: vi.fn(), annotateStderrWithSandboxFailures: vi.fn((_id, text) => text) }
const initialize = vi.fn(async () => {})
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
vi.doMock(adapterRequire.resolve('@anthropic-ai/sandbox-runtime'), () => ({ SandboxManager: sandbox }))
vi.doMock('../packages/adapters/src/tools/sandbox-initialization.js', () => ({ initializeShellSandbox: initialize }))
vi.doMock('../packages/adapters/src/tools/windows-srt-path.js', () => ({ verifiedWindowsSrt: () => '/fixed-install/srt-win.exe' }))
vi.doMock('../packages/adapters/src/tools/installation-dependencies.js', () => ({ installationDependencyRoots: async () => [], workspaceUsesInstallationDependencies: async () => false }))
vi.doMock('../packages/adapters/src/tools/windows-read-policy.js', () => ({ windowsReadDenyRoots: () => [], carveWindowsReadDenies: async (paths: string[]) => paths, windowsToolchainWriteDenies: async (paths: string[]) => paths }))
const { runShell, resolveShellIdentity } = await import('../packages/adapters/src/tools/shell.js')

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('keeps the Windows SRT prefix and replaces only the direct stdio command for a read-only isolated target', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-lsp-win-stdio-')))
  directories.push(root)
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const broker = ['/fixed-install/srt-win.exe', 'exec', '--quiet', '--deny-read', '/private', '--env', 'HTTPS_PROXY=loopback', '--', 'cmd.exe', '/d', '/c', 'encoded-command']
  sandbox.wrapWithSandboxArgv.mockResolvedValue({ argv: broker, env: {} })
  const identity = await resolveShellIdentity(process.execPath, ['-e', '0'], root)
  const child = Object.assign(new EventEmitter(), { pid: 77, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: vi.fn() }, kill: vi.fn(() => true) })
  const result = await runShell(process.execPath, ['-e', '0'], {
    cwd: root, expectedIdentity: identity, readOnlyWorkspace: true, isolatedHome: true, stdioTarget: true, timeoutMs: 5000,
    spawnProcess: (argv, options) => {
      expect(argv[0]).toBe(broker[0])
      expect(argv).toContain('--quiet')
      expect(argv).toContain('--deny-read')
      const separator = argv.indexOf('--')
      expect(separator).toBeGreaterThan(1)
      expect(argv[separator + 1]).toBe(identity.executable)
      expect(argv).not.toContain('cmd.exe')
      expect(options.env?.HOME).toBeTruthy()
      expect(options.env?.HOME).not.toBe(homedir())
      expect(options.env?.USERPROFILE).toBe(options.env?.HOME)
      setImmediate(() => child.emit('close', 0))
      return child
    },
  })
  expect(result).toMatchObject({ code: 0, aborted: false })
  const policy = initialize.mock.calls[0]![0] as { filesystem: { allowWrite: string[] } }
  expect(policy.filesystem.allowWrite).not.toContain(root)
})
