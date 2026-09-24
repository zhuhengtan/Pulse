import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const SandboxManager = { initialize: vi.fn(), reset: vi.fn() }
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
vi.doMock(adapterRequire.resolve('@anthropic-ai/sandbox-runtime'), () => ({ SandboxManager }))
const { initializeShellSandbox } = await import('../packages/adapters/src/tools/sandbox-initialization.js')

const policy = { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }
const timeout = Object.assign(new Error('WFP readiness probe timeout'), { code: 'srt_win_timeout', subcommand: 'wfp' })
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
