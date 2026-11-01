import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const SandboxManager = { initialize: vi.fn(), reset: vi.fn(), updateConfig: vi.fn() }
const expandWindowsFsPaths = vi.fn(), getWindowsSandboxUserStatusAsync = vi.fn(), resolveSrtWin = vi.fn(), stampWindowsAcl = vi.fn(), realpath = vi.fn()
vi.doMock('node:fs/promises', () => ({ realpath }))
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
vi.doMock(adapterRequire.resolve('@anthropic-ai/sandbox-runtime'), () => ({ SandboxManager, DEFAULT_WINDOWS_PROXY_PORT_RANGE: [60080, 60089], expandWindowsFsPaths, getWindowsSandboxUserStatusAsync, resolveSrtWin, stampWindowsAcl }))
const { initializeShellSandbox } = await import('../packages/adapters/src/tools/sandbox-initialization.js')

const policy = { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }
const timeout = Object.assign(new Error('WFP readiness probe timeout'), { code: 'srt_win_timeout', subcommand: 'wfp' })
beforeEach(() => {
  expandWindowsFsPaths.mockImplementation(paths => [...paths])
  realpath.mockImplementation(async path => path)
  getWindowsSandboxUserStatusAsync.mockResolvedValue({ provisioned: true, sid: 'sandbox-sid' })
  resolveSrtWin.mockReturnValue({ exe: 'fixed-srt.exe', prefixArgs: [] })
})
afterEach(() => vi.resetAllMocks())

it('cleans up a cold Windows WFP timeout and requires a successful second initialization', async () => {
  const order: string[] = []
  SandboxManager.initialize.mockImplementationOnce(async () => { order.push('timeout'); throw timeout }).mockImplementationOnce(async () => { order.push('verified') })
  SandboxManager.reset.mockImplementation(async () => { order.push('cleanup') })
  await initializeShellSandbox(policy, 'win32')
  expect(order).toEqual(['timeout', 'cleanup', 'verified'])
})

it('fails closed after the second WFP timeout', async () => {
  const init = SandboxManager.initialize.mockRejectedValue(timeout)
  SandboxManager.reset.mockResolvedValue()
  await expect(initializeShellSandbox(policy, 'win32')).rejects.toBe(timeout)
  expect(init).toHaveBeenCalledTimes(2)
})

const bindDenied = (port: number, extras = {}) => Object.assign(new Error('loopback bind denied'), { code: 'EACCES', syscall: 'listen', address: '127.0.0.1', port, ...extras })
it('resets denied Windows proxy binds and only narrows the original WFP range', async () => {
  const original = largePolicy()
  SandboxManager.initialize.mockRejectedValueOnce(bindDenied(60080)).mockRejectedValueOnce(bindDenied(60082)).mockResolvedValueOnce(undefined)
  await initializeShellSandbox(original, 'win32')
  expect(SandboxManager.initialize.mock.calls.map(([p]) => p.windows?.proxyPortRange)).toEqual([undefined, [60081, 60089], [60083, 60089]])
  expect(SandboxManager.reset).toHaveBeenCalledTimes(2)
  const effective = SandboxManager.updateConfig.mock.calls[0]![0]
  expect(effective).toEqual({ ...original, windows: { proxyPortRange: [60083, 60089] } })
  expect(effective.filesystem).toEqual(original.filesystem)
  expect(original).not.toHaveProperty('windows')
  expect(stampWindowsAcl).toHaveBeenCalledTimes(5)
})

it('fails closed when every port in the explicitly configured range is denied', async () => {
  const configured = { ...policy, windows: { proxyPortRange: [61000, 61002] as [number, number] } }
  const last = bindDenied(61002)
  SandboxManager.initialize.mockRejectedValueOnce(bindDenied(61000)).mockRejectedValueOnce(bindDenied(61001)).mockRejectedValueOnce(last)
  await expect(initializeShellSandbox(configured, 'win32')).rejects.toBe(last)
  expect(SandboxManager.initialize.mock.calls.map(([p]) => p.windows.proxyPortRange)).toEqual([[61000, 61002], [61001, 61002], [61002, 61002]])
  expect(SandboxManager.reset).toHaveBeenCalledTimes(2)
  expect(SandboxManager.updateConfig).not.toHaveBeenCalled()
})

it.each([
  ['linux', bindDenied(60080)],
  ['win32', bindDenied(60079)],
  ['win32', bindDenied(60089)],
  ['win32', bindDenied(60080, { address: '0.0.0.0' })],
  ['win32', bindDenied(60080, { syscall: 'open' })],
  ['win32', bindDenied(60080, { port: '60080' })],
  ['win32', bindDenied(60080, { code: 'EPERM' })],
] as const)('never retries a non-proxy authorization error (%s, %j)', async (platform, failure) => {
  SandboxManager.initialize.mockRejectedValue(failure)
  await expect(initializeShellSandbox(policy, platform)).rejects.toBe(failure)
  expect(SandboxManager.initialize).toHaveBeenCalledTimes(1)
  expect(SandboxManager.reset).not.toHaveBeenCalled()
})

it('honors cancellation after failed-port cleanup without trying another initialization', async () => {
  const controller = new AbortController()
  SandboxManager.initialize.mockRejectedValueOnce(bindDenied(60080))
  SandboxManager.reset.mockImplementationOnce(async () => { controller.abort() })
  await expect(initializeShellSandbox(policy, 'win32', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(SandboxManager.initialize).toHaveBeenCalledTimes(1)
  expect(SandboxManager.updateConfig).not.toHaveBeenCalled()
})

it('bounds proxy setup retries even when a configured port range is large', async () => {
  const configured = { ...policy, windows: { proxyPortRange: [61000, 62000] as [number, number] } }
  const last = bindDenied(61003)
  SandboxManager.initialize.mockRejectedValueOnce(bindDenied(61000)).mockRejectedValueOnce(bindDenied(61001)).mockRejectedValueOnce(bindDenied(61002)).mockRejectedValueOnce(last)
  await expect(initializeShellSandbox(configured, 'win32')).rejects.toBe(last)
  expect(SandboxManager.initialize).toHaveBeenCalledTimes(4)
  expect(SandboxManager.reset).toHaveBeenCalledTimes(3)
})

it('does not renew the WFP readiness retry allowance after advancing a proxy port', async () => {
  SandboxManager.initialize.mockRejectedValueOnce(timeout).mockRejectedValueOnce(bindDenied(60080)).mockRejectedValueOnce(timeout)
  await expect(initializeShellSandbox(policy, 'win32')).rejects.toBe(timeout)
  expect(SandboxManager.initialize).toHaveBeenCalledTimes(3)
  expect(SandboxManager.reset).toHaveBeenCalledTimes(2)
})

it('requires failed-listener cleanup to succeed before another initialization', async () => {
  const cleanup = new Error('cleanup failed')
  SandboxManager.initialize.mockRejectedValueOnce(bindDenied(60080))
  SandboxManager.reset.mockRejectedValueOnce(cleanup)
  await expect(initializeShellSandbox(policy, 'win32')).rejects.toBe(cleanup)
  expect(SandboxManager.initialize).toHaveBeenCalledTimes(1)
})

it.each([
  ['win32', { code: 'wfp_verify_failed', subcommand: 'wfp' }],
  ['win32', { code: 'srt_win_timeout', subcommand: 'acl' }],
  ['linux', timeout],
] as const)('does not retry other isolation failures (%s, %j)', async (platform, failure) => {
  const init = SandboxManager.initialize.mockRejectedValue(failure)
  const reset = SandboxManager.reset.mockResolvedValue()
  await expect(initializeShellSandbox(policy, platform)).rejects.toBe(failure)
  expect(init).toHaveBeenCalledTimes(1)
  expect(reset).not.toHaveBeenCalled()
})

const largePolicy = () => ({ ...policy, filesystem: { ...policy.filesystem, allowWrite: ['C:\\workspace'], denyRead: Array.from({ length: 37 }, (_, i) => `C:\\private\\${i}`), denyWrite: Array.from({ length: 5 }, (_, i) => `C:\\tools\\${i}`) } })

it('applies every deny in bounded batches before publishing the full Windows policy', async () => {
  const full = largePolicy()
  await initializeShellSandbox(full, 'win32')
  const first = SandboxManager.initialize.mock.calls[0]![0].filesystem
  const batches = [first, ...stampWindowsAcl.mock.calls.map(([batch]) => batch)]
  expect(batches).toHaveLength(6)
  expect(batches.every(batch => batch.denyRead.length + batch.denyWrite.length <= 8)).toBe(true)
  expect(batches.flatMap(batch => batch.denyRead)).toEqual(full.filesystem.denyRead)
  expect(batches.flatMap(batch => batch.denyWrite)).toEqual(full.filesystem.denyWrite)
  expect(first.allowWrite).toEqual(full.filesystem.allowWrite)
  for (const [batch] of stampWindowsAcl.mock.calls) expect(batch).toMatchObject({ holderPid: process.pid, sandboxUserSid: 'sandbox-sid', srtWin: { exe: 'fixed-srt.exe' } })
  expect(SandboxManager.updateConfig).toHaveBeenCalledWith(full)
})

it('never publishes a partially applied policy and never retries an ACL failure', async () => {
  const failure = Object.assign(new Error('ACL timeout'), { code: 'srt_win_timeout', subcommand: 'acl' })
  stampWindowsAcl.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw failure })
  await expect(initializeShellSandbox(largePolicy(), 'win32')).rejects.toBe(failure)
  expect(SandboxManager.initialize).toHaveBeenCalledTimes(1)
  expect(stampWindowsAcl).toHaveBeenCalledTimes(2)
  expect(SandboxManager.updateConfig).not.toHaveBeenCalled()
})

it('keeps read-deny dominance across physical aliases and case variants in different batches', async () => {
  const full = largePolicy()
  full.filesystem.denyWrite.push('C:\\alias', 'c:\\PRIVATE\\0')
  realpath.mockImplementation(async path => path === 'C:\\alias' ? 'C:\\private\\0' : path)
  await initializeShellSandbox(full, 'win32')
  const first = SandboxManager.initialize.mock.calls[0]![0].filesystem
  const batches = [first, ...stampWindowsAcl.mock.calls.map(([batch]) => batch)]
  expect(batches.flatMap(batch => batch.denyWrite)).toEqual(Array.from({ length: 5 }, (_, i) => `C:\\tools\\${i}`))
  expect(batches.flatMap(batch => batch.denyRead)).toEqual(full.filesystem.denyRead)
})

it.each(['missing path', 'credential rules'])('retains the SDK convergence lifecycle for %s', async reason => {
  const full: any = largePolicy()
  if (reason === 'missing path') realpath.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  else full.credentials = {}
  await initializeShellSandbox(full, 'win32')
  expect(SandboxManager.initialize).toHaveBeenCalledWith(full, undefined, false)
  expect(stampWindowsAcl).not.toHaveBeenCalled()
})

it('stops batch initialization on cancellation without publishing a partial policy', async () => {
  const controller = new AbortController()
  stampWindowsAcl.mockImplementationOnce(() => { controller.abort() })
  await expect(initializeShellSandbox(largePolicy(), 'win32', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(stampWindowsAcl).toHaveBeenCalledTimes(1)
  expect(SandboxManager.updateConfig).not.toHaveBeenCalled()
})

it('requires a provisioned sandbox SID before applying additional batches', async () => {
  getWindowsSandboxUserStatusAsync.mockResolvedValue({ provisioned: false })
  await expect(initializeShellSandbox(largePolicy(), 'win32')).rejects.toThrow('not provisioned')
  expect(stampWindowsAcl).not.toHaveBeenCalled()
  expect(SandboxManager.updateConfig).not.toHaveBeenCalled()
})
