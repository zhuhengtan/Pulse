import { it, expect } from 'vitest'
// Import the compiled delivery, not the source under repair: a regression that
// reads src could pass while the shipped dist/check-receipt.js still misclassifies.
import { isCheck } from '../packages/server/dist/check-receipt.js'

const check = (command: string, args: string[] = []): boolean => isCheck(command, args)

it('exposes isCheck as a compiled public export', () => {
  expect(typeof isCheck).toBe('function')
  expect(isCheck.length).toBe(2)
})

it('does not treat reading a test file as a check', () => {
  // The exact false positive that blocked the six Vitest cases: the old
  // implementation matched "tests/" anywhere in the joined argv.
  expect(check('shasum', ['-a', '256', 'tests/cli-parse-inline-equals.test.ts'])).toBe(false)
  expect(check('sha256sum', ['tests/cli-parse-inline-equals.test.ts'])).toBe(false)
  expect(check('git', ['diff', '--', 'tests/cli-parse-inline-equals.test.ts'])).toBe(false)
  expect(check('git', ['show', 'HEAD:tests/check-inventory.test.ts'])).toBe(false)
  expect(check('cat', ['tests/cli-parse-inline-equals.test.ts'])).toBe(false)
  expect(check('ls', ['tests/'])).toBe(false)
  expect(check('grep', ['-n', 'test', 'tests/check-inventory.test.ts'])).toBe(false)
  expect(check('rg', ['--files-with-matches', 'check', 'tests/'])).toBe(false)
  expect(check('diff', ['-u', 'tests/a.test.ts', 'tests/b.test.ts'])).toBe(false)
})

it('does not read interpreter inline code or trailing data as a script position', () => {
  expect(check('node', ['-e', "console.log('test')"])).toBe(false)
  expect(check('node', ['--eval', "console.log('check')"])).toBe(false)
  // Review boundary: the words after -e are that code's argv, never a script.
  expect(check('node', ['-e', 'console.log(1)', 'tests/verify.mjs'])).toBe(false)
  // A runner-shaped flag after the script name belongs to the script's own data.
  expect(check('node', ['scripts/collect.mjs', '--test'])).toBe(false)
  expect(check('node', ['scripts/collect.mjs', 'tests/verify.mjs'])).toBe(false)
  expect(check('python3', ['scripts/report.py', '-m', 'pytest'])).toBe(false)
  expect(check('python3', ['scripts/report.py', '--check'])).toBe(false)
})

it('does not split quoted shell text into a runner invocation', () => {
  // Review boundary: the semicolon sits inside the quotes, so this only prints.
  expect(check('sh', ['-c', 'echo "prefix; vitest run"'])).toBe(false)
  expect(check('bash', ['-c', "echo 'npm test'"])).toBe(false)
  expect(check('sh', ['-c', 'cat tests/cli-parse-inline-equals.test.ts'])).toBe(false)
  // Unsupported structures abstain instead of being guessed into a check.
  expect(check('sh', ['-c', 'echo $(npx vitest)'])).toBe(false)
  expect(check('sh', ['-c', 'diff <(ls) <(ls)'])).toBe(false)
})

it('keeps real runners and verification scripts classifiable', () => {
  expect(check('vitest', ['run', 'tests/is-check-classification.test.ts'])).toBe(true)
  expect(check('vitest')).toBe(true)
  expect(check('node', ['--test', 'tests/foo.test.mjs'])).toBe(true)
  expect(check('node', ['--check', 'packages/server/src/check-receipt.ts'])).toBe(true)
  expect(check('pnpm', ['exec', 'vitest', 'run'])).toBe(true)
  expect(check('npx', ['vitest', 'run'])).toBe(true)
  expect(check('env', ['VAR=1', 'vitest', 'run'])).toBe(true)
  expect(check('python', ['-m', 'pytest'])).toBe(true)
  expect(check('python3', ['-m', 'pytest', 'tests/'])).toBe(true)
  expect(check('eslint', ['.'])).toBe(true)
  expect(check('xmllint', ['--noout', 'docs/sample.xml'])).toBe(true)
  expect(check('bash', ['scripts/verify.sh'])).toBe(true)
  expect(check('./scripts/verify.sh')).toBe(true)
  expect(check('sh', ['-c', 'vitest run'])).toBe(true)
  expect(check('pnpm', ['run', 'check'])).toBe(true)
})

it('does not classify unrelated commands that merely mention test or check', () => {
  expect(check('echo', ['test'])).toBe(false)
  expect(check('echo', ['check', 'vitest'])).toBe(false)
  expect(check('pnpm', ['run', 'build'])).toBe(false)
  expect(check('mkdir', ['tests'])).toBe(false)
})
