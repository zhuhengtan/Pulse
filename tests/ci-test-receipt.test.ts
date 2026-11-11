import { expect, it } from 'vitest'
import { makeTestReceipt, verifyTestReceipt } from '../scripts/ci/test-receipt.mjs'

const plan = { nonce: 'a'.repeat(64), root: '/repo', files: ['tests/a.test.ts'], inventoryHash: 'inventory', shard: 1 }
const counts = { files: 1, passed: 2, skipped: 0 }

it('binds complete execution counts to the exact invocation and plan', () => {
  const receipt = makeTestReceipt(plan, counts)
  expect(verifyTestReceipt(plan, receipt)).toEqual(receipt)
  expect(receipt).toMatchObject({ version: 1, complete: true, ...counts })
})

it.each([
  { nonce: 'b'.repeat(64) }, { root: '/other' }, { files: ['tests/b.test.ts'] },
  { inventoryHash: 'other' }, { shard: 2 },
])('rejects receipts from a different invocation or plan (%j)', change => {
  expect(() => verifyTestReceipt({ ...plan, ...change }, makeTestReceipt(plan, counts))).toThrow('INVALID_TEST_COMPLETION_RECEIPT')
})

it.each([
  { complete: false }, { files: 0 }, { passed: -1 }, { skipped: 0.5 },
  { version: 2 }, { extra: true }, { passed: undefined },
])('rejects incomplete or invalid completion records (%j)', change => {
  expect(() => verifyTestReceipt(plan, { ...makeTestReceipt(plan, counts), ...change })).toThrow('INVALID_TEST_COMPLETION_RECEIPT')
})
