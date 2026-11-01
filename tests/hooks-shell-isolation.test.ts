import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const platform = process.platform
const directories: string[] = []
const sandbox = { reset: vi.fn(async () => {}), cleanupAfterCommand: vi.fn(), wrapWithSandboxArgv: vi.fn(), annotateStderrWithSandboxFailures: vi.fn((_id: string, text: string) => text) }
const initialize = vi.fn(async () => {})
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
vi.doMock(adapterRequire.resolve('@anthropic-ai/sandbox-runtime'), () => ({ SandboxManager: sandbox }))
vi.doMock('../packages/adapters/src/tools/sandbox-initialization.js', () => ({ initializeShellSandbox: initialize }))
vi.doMock('../packages/adapters/src/tools/windows-srt-path.js', () => ({ verifiedWindowsSrt: () => '/fixed-install/srt-win.exe' }))
vi.doMock('../packages/adapters/src/tools/installation-dependencies.js', () => ({ installationDependencyRoots: async () => [], workspaceUsesInstallationDependencies: async () => false }))
vi.doMock('../packages/adapters/src/tools/windows-read-policy.js', () => ({ windowsReadDenyRoots: () => [], carveWindowsReadDenies: async (paths: string[]) => paths, windowsToolchainWriteDenies: async (paths: string[]) => paths }))
const { runShell } = await import('../packages/adapters/src/tools/shell.js')

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.clearAllMocks()
  delete process.env.AWS_ACCESS_KEY_ID
  delete process.env.SSH_AUTH_SOCK
  delete process.env.KUBECONFIG
  delete process.env.FAKE_HOST_MARKER
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-hook-isolation-')))
  directories.push(root)
  return root
}

function child() {
  const value = Object.assign(new EventEmitter(), { pid: 7, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, kill: vi.fn(() => true) })
  return value
}

it('keeps an ordinary shell merge and seals only the hook child environment', async () => {
  const root = await workspace()
  process.env.AWS_ACCESS_KEY_ID = 'fake-aws-marker'
  process.env.SSH_AUTH_SOCK = '/tmp/fake-agent-marker'
  process.env.KUBECONFIG = '/tmp/fake-kube-marker'
  const proxy = 'http://127.0.0.1:9/pulse-hook-proxy-marker'
  const host = { ...process.env, HTTP_PROXY: proxy, FAKE_HOST_MARKER: 'kept' }
  sandbox.wrapWithSandboxArgv.mockResolvedValue({ argv: [process.execPath, '-e', 'process.exit(0)'], env: host })
  const ordinary = child()
  const ordinarySpawn = vi.fn(() => { setImmediate(() => ordinary.emit('close', 0)); return ordinary })
  await runShell('node', ['-e', 'process.exit(0)'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' }, spawnProcess: ordinarySpawn })
  expect(ordinarySpawn.mock.calls[0]![1].env).toMatchObject({ AWS_ACCESS_KEY_ID: 'fake-aws-marker', FAKE_HOST_MARKER: 'kept' })
  const sealed = child()
  const sealedSpawn = vi.fn(() => { setImmediate(() => sealed.emit('close', 0)); return sealed })
  await runShell('node', ['-e', 'process.exit(0)'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' }, readOnlyWorkspace: true, isolatedHome: true, allowedDomains: [], sealedCallerEnv: true, spawnProcess: sealedSpawn })
  const env = sealedSpawn.mock.calls[0]![1].env as NodeJS.ProcessEnv
  expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
  expect(env.SSH_AUTH_SOCK).toBeUndefined()
  expect(env.KUBECONFIG).toBeUndefined()
  expect(env.FAKE_HOST_MARKER).toBeUndefined()
  expect(env.HTTP_PROXY).toBe(proxy)
  expect(env.HOME).toContain('pulse-shell-')
  const policy = initialize.mock.calls.at(-1)![0] as { network: { allowedDomains: string[]; strictAllowlist: boolean }; filesystem: { allowWrite: string[] } }
  expect(policy.network).toEqual({ allowedDomains: [], deniedDomains: [], strictAllowlist: true })
  expect(policy.filesystem.allowWrite).not.toContain(root)
})

it('does not copy host markers into the Windows hook child overlay', async () => {
  const root = await workspace()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  process.env.AWS_ACCESS_KEY_ID = 'fake-aws-marker'
  const proxy = 'http://127.0.0.1:9/pulse-hook-proxy-marker'
  const broker = ['/fixed-install/srt-win.exe', 'exec', '--quiet', '--env', 'HTTPS_PROXY=http://127.0.0.1:9', '--', 'node.exe', '-e', 'process.exit(0)']
  sandbox.wrapWithSandboxArgv.mockResolvedValue({ argv: broker, env: { ...process.env, AWS_ACCESS_KEY_ID: 'fake-aws-marker', HTTP_PROXY: proxy } })
  const launched = child()
  const spawn = vi.fn((_argv: string[], options: { env: NodeJS.ProcessEnv }) => { setImmediate(() => launched.emit('close', 0)); return launched })
  await runShell('node', ['-e', 'process.exit(0)'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' }, readOnlyWorkspace: true, isolatedHome: true, allowedDomains: [], sealedCallerEnv: true, spawnProcess: spawn })
  const argv = spawn.mock.calls[0]![0] as string[]
  expect(argv.join('\n')).not.toContain('fake-aws-marker')
  expect(argv).toContain(`HTTP_PROXY=${proxy}`)
  expect(argv).toContain('HTTPS_PROXY=http://127.0.0.1:9')
  expect(spawn.mock.calls[0]![1].env.AWS_ACCESS_KEY_ID).toBeUndefined()
  expect(spawn.mock.calls[0]![1].env.HTTP_PROXY).toBe(proxy)
})

it('rejects an early stdin close instead of trusting exit 0, and still accepts a delivered payload', async () => {
  const root = await workspace()
  sandbox.wrapWithSandboxArgv.mockImplementation(async (command: string) => ({ argv: [process.execPath, '-e', command.includes('closeSync') ? `require('node:fs').closeSync(0);process.stdout.write('{}')` : `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d==='{}'?'{}':'bad'))`], env: process.env }))
  // Force the actual pipe-error boundary without depending on OS pipe capacity
  // or closing libuv's fd behind its back (which can abort newer Node builds).
  const broken = child()
  const stdin = Object.assign(new EventEmitter(), { end: (_data: string, callback?: (error: Error) => void) => {
    setImmediate(() => {
      const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
      stdin.emit('error', error)
      callback?.(error)
      broken.emit('close', 0)
    })
  } })
  Object.assign(broken, { stdin })
  await expect(runShell('node', ['-e', 'closeSync'], { cwd: root, readOnlyWorkspace: true, isolatedHome: true, allowedDomains: [], timeoutMs: 5000, stdinData: 'x'.repeat(60000), spawnProcess: () => broken })).rejects.toMatchObject({ code: 'SHELL_STDIN_DELIVERY_UNKNOWN' })
  const delivered = await runShell('node', ['-e', 'read'], { cwd: root, readOnlyWorkspace: true, isolatedHome: true, allowedDomains: [], timeoutMs: 5000, stdinData: '{}' })
  expect(delivered).toMatchObject({ code: 0, stdout: '{}' })
})
