import { expect, it, vi } from 'vitest'
import { makeTestPlan, splitTests, verifyPartition } from '../scripts/ci/test-plan.mjs'
import CIReporter, { verifyExecution } from '../scripts/ci/test-reporter.mjs'
const files = Array.from({ length: 13 }, (_, i) => `tests/${i}.test.ts`)
it('distributes every case file exactly once over four deterministic nonempty shards', () => {
  const weights = { [files[0]]: 900000, [files[1]]: 300000 }
  const bins = splitTests(files, weights)
  expect(bins).toEqual(splitTests([...files].reverse(), weights))
  expect(bins.flatMap(bin => bin.files).sort()).toEqual([...files].sort())
  expect(bins.reduce((n, bin) => n + bin.milliseconds, 0)).toBe(1200000 + 11 * 60000)
  expect(() => verifyPartition(files, bins)).not.toThrow()
  expect(() => verifyPartition(files, bins.slice(1))).toThrow()
  expect(() => verifyPartition(files, bins.map((bin, i) => i === 0 ? { ...bin, files: [...bin.files, files[0]] } : bin))).toThrow()
  expect(() => splitTests([...files, files[0]])).toThrow()
})
it('plans the actual full inventory and each shard against the same inventory hash', async () => {
  const full = await makeTestPlan(process.cwd())
  const shards = await Promise.all([1, 2, 3, 4].map(n => makeTestPlan(process.cwd(), n)))
  expect(shards.flatMap(shard => shard.files).sort()).toEqual(full.files)
  expect(new Set(shards.map(shard => shard.inventoryHash))).toEqual(new Set([full.inventoryHash]))
  expect(full.files.some(file => file.startsWith('tests/live/'))).toBe(false)
  expect(full.files).toContain('tests/hooks-host-lifecycle.test.ts')
  await expect(makeTestPlan(process.cwd(), 0)).rejects.toThrow('INVALID_TEST_SHARD')
})
it('rejects missing, duplicate, unexpected or incomplete test execution; preserves declared skips', () => {
  const plan = { root: '/workspace', files: ['tests/a.test.ts'] }
  const file = { id: 'f', filepath: '/workspace/tests/a.test.ts', tasks: [
    { id: 'a', name: 'passed', result: { state: 'pass' }, mode: 'run' },
    { id: 's', name: 'declared skip', result: { state: 'skip' }, mode: 'skip' },
  ] }
  expect(verifyExecution(plan, [file])).toEqual({ files: 1, passed: 1, skipped: 1 })
  for (const actual of [[], [file, file], [{ ...file, filepath: '/workspace/tests/b.test.ts' }]]) expect(() => verifyExecution(plan, actual)).toThrow('COVERAGE_MISMATCH')
  expect(() => verifyExecution(plan, [{ ...file, tasks: [{ ...file.tasks[0], result: { state: 'skip' } }] }])).toThrow('INCOMPLETE')
  expect(() => verifyExecution(plan, [file], new Map([['s', 'run']]))).toThrow('INCOMPLETE')
})
it('prints the first failure at task update time without waiting for the file to finish', () => {
  const reporter = new CIReporter(), error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    reporter.onCollected([{ id: 'f', name: 'suite', tasks: [{ id: 'a', name: 'native case', mode: 'run' }] }])
    reporter.onTaskUpdate([['a', { state: 'fail', errors: [{ message: 'first durable error' }] }]])
    expect(error).toHaveBeenCalledWith('[ci:test] FAIL suite > native case')
    expect(error).toHaveBeenCalledWith('first durable error')
    reporter.onTaskUpdate([['a', { state: 'fail' }]])
    expect(error).toHaveBeenCalledTimes(2)
  } finally { error.mockRestore() }
})
