import { expect, it } from 'vitest'
import { sourceClaimHostTimeout } from './helpers/source-claim-timeouts.js'

it.each([
  ['linux', 'current', 30_000], ['linux', 'external', 45_000], ['linux', 'paged', 30_000],
  ['darwin', 'current', 30_000], ['darwin', 'external', 45_000], ['darwin', 'paged', 30_000],
  ['win32', 'current', 30_000], ['win32', 'external', undefined], ['win32', 'paged', 30_000],
] as const)('preserves the %s source-claim %s fixture envelope', (platform, mode, timeout) => {
  expect(sourceClaimHostTimeout(platform, mode)).toBe(timeout)
})
