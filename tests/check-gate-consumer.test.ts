import { it, expect } from 'vitest'
// Import the compiled delivery, not the sources under repair. `checkInvocation`
// and `isCheck` are the two functions the task-controller gate actually calls to
// decide whether a receipt is a required check, so the regression exercises the
// shipped classification path instead of asserting on production source text.
import { checkInvocation } from '../packages/server/dist/task-controller/program.js'
import { isCheck } from '../packages/server/dist/check-receipt.js'

type Meta = {
  toolName?: string
  toolCommand?: string
  toolArguments?: unknown
  outcomeStatus?: string
  toolExitCode?: number
}
type Body = { code?: number; timedOut?: boolean; aborted?: boolean }
type Receipt = { ref: string; meta: Meta; body: Body }

/**
 * Real receipt metadata: toolCommand is the whole display string (command plus
 * args, built by the runtime), while toolArguments carries the executable and
 * its argv. A classifier that feeds toolCommand to isCheck sees the display
 * string as the executable name.
 */
const receipt = (ref: string, command: string, args: string[], code: number): Receipt => ({
  ref,
  meta: {
    toolName: 'shell.exec',
    toolCommand: [command, ...args].join(' '),
    toolArguments: { command, args, cwd: '.' },
    outcomeStatus: code === 0 ? 'succeeded' : 'failed',
    toolExitCode: code,
  },
  body: { code },
})

/**
 * Classification exactly as the production gate performs it: the executable and
 * its argv come from toolArguments, then isCheck decides. latestChecks itself is
 * driven through the compiled lane program in tests/check-gate-program.test.ts,
 * so this file must not reimplement the gate algorithm.
 */
const requiredCheck = (entry: Receipt): boolean => {
  const invocation = checkInvocation(entry.meta)
  return invocation !== undefined && isCheck(invocation.command, invocation.args)
}

it('extracts the executable and argv from toolArguments, not the display string', () => {
  const test = receipt('result-1', 'node', ['--test', 'tests/foo.test.mjs'], 1)
  const invocation = checkInvocation(test.meta)
  expect(invocation).toEqual({ command: 'node', args: ['--test', 'tests/foo.test.mjs'], cwd: '.' })
  // Feeding the display string as the executable hides a real test failure,
  // which is exactly why the gate must not classify toolCommand directly.
  expect(isCheck(String(test.meta.toolCommand), [])).toBe(false)
})

it('does not treat a read of a test path as a required check', () => {
  expect(requiredCheck(receipt('result-2', 'cat', ['tests/foo.test.mjs'], 1))).toBe(false)
  expect(requiredCheck(receipt('result-3', 'ls', ['tests/'], 2))).toBe(false)
  expect(requiredCheck(receipt('result-4', 'grep', ['-n', 'test', 'tests/foo.test.mjs'], 1))).toBe(false)
  // The retry that succeeds is not a check either, so a later successful read
  // can never be mistaken for a superseded required test result.
  expect(requiredCheck(receipt('result-6', 'cat', ['tests/foo.test.mjs'], 0))).toBe(false)
})

it('still classifies a real node --test receipt as a required check', () => {
  // Failure blocking and supersede are properties of latestChecks itself; they
  // are asserted against the compiled lane program in
  // tests/check-gate-program.test.ts rather than a copy of the gate algorithm.
  expect(requiredCheck(receipt('result-7', 'node', ['--test', 'tests/foo.test.mjs'], 1))).toBe(true)
})

it('leaves receipts without structured arguments to the historical text branch', () => {
  const legacy = { toolName: 'shell.exec', toolCommand: 'node --test tests/foo.test.mjs' }
  const legacyRead = { toolName: 'shell.exec', toolCommand: 'cat tests/foo.test.mjs' }
  expect(checkInvocation(legacy)).toBeUndefined()
  expect(checkInvocation(legacyRead)).toBeUndefined()
  // Non-shell receipts are never required checks.
  expect(checkInvocation({ toolName: 'fs.read', toolArguments: { path: 'tests/foo.test.mjs' } })).toBeUndefined()
  expect(checkInvocation({ toolName: 'shell.exec', toolArguments: { command: 'node', args: '--test' } })).toBeUndefined()
})
