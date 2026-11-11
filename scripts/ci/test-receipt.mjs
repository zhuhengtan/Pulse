import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

function planHash(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

export function makeTestReceipt(plan, result) {
  if (typeof plan.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(plan.nonce)) throw Error('INVALID_TEST_RECEIPT_NONCE')
  return {
    version: 1, complete: true, nonce: plan.nonce, planHash: planHash(plan),
    inventoryHash: plan.inventoryHash, shard: plan.shard,
    files: result.files, passed: result.passed, skipped: result.skipped,
  }
}

export function verifyTestReceipt(plan, receipt) {
  const expected = makeTestReceipt(plan, receipt ?? {})
  if (!receipt || Object.keys(receipt).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) => receipt[key] !== value) ||
      receipt.files !== plan.files.length ||
      !['files', 'passed', 'skipped'].every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0)) {
    throw Error('INVALID_TEST_COMPLETION_RECEIPT')
  }
  return receipt
}

export function writeTestReceipt(path, plan, result) {
  const receipt = verifyTestReceipt(plan, makeTestReceipt(plan, result))
  const pending = path + '.pending'
  writeFileSync(pending, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
  renameSync(pending, path)
}

export function readTestReceipt(path, plan) {
  try { return verifyTestReceipt(plan, JSON.parse(readFileSync(path, 'utf8'))) }
  catch (error) { throw Error('TEST_COMPLETION_RECEIPT_REQUIRED', { cause: error }) }
}
