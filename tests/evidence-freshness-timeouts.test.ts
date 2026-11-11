import { expect, it } from 'vitest'
import { evidenceFreshnessTimeouts } from './helpers/evidence-freshness-timeouts.js'

it.each([
  ['linux', 30_000, 45_000],
  ['darwin', 30_000, 45_000],
  ['win32', undefined, 720_000],
] as const)('keeps both freshness fixture envelopes explicit for %s', (platform, retainedPatch, testAdditions) => {
  expect(evidenceFreshnessTimeouts(platform)).toEqual({ retainedPatch, testAdditions })
})
