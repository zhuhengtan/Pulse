import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeRunnerIntegration } from './long-task-probe.mjs'
import { manifest } from './long-task-lib.mjs'

test('offline runner probe uses real compiled dependencies and does not modify the candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-real-grader-probe-')), workspace = join(dir, 'candidate')
  try {
    await mkdir(join(workspace, 'scripts/eval'), { recursive: true }); await mkdir(join(workspace, 'evals'))
    for (const name of ['run.mjs', 'config-budget.mjs', 'resume.mjs', 'status.mjs', 'validate.mjs', 'grade.mjs']) await cp(new URL(name, import.meta.url), join(workspace, 'scripts/eval', name))
    await cp(new URL('../../evals/tasks.v1.json', import.meta.url), join(workspace, 'evals/tasks.v1.json'))
    const before = await manifest(workspace)
    const checks = await probeRunnerIntegration(workspace, join(dir, 'probe'))
    assert.equal(checks.length, 8); assert.equal(checks.every(c => c.passed), true, JSON.stringify(checks))
    assert.deepEqual(await manifest(workspace), before)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('accepts equivalent report fields while still rejecting the round8 argument-parser defect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-entry-contract-')), workspace = join(dir, 'candidate')
  try {
    await mkdir(join(workspace, 'scripts/eval'), { recursive: true }); await mkdir(join(workspace, 'evals'))
    for (const name of ['run.mjs', 'config-budget.mjs', 'resume.mjs', 'status.mjs', 'validate.mjs', 'grade.mjs']) await cp(new URL(name, import.meta.url), join(workspace, 'scripts/eval', name))
    await cp(new URL('../../evals/tasks.v1.json', import.meta.url), join(workspace, 'evals/tasks.v1.json'))
    const runner = join(workspace, 'scripts/eval/run.mjs')
    const source = (await readFile(runner, 'utf8')).replace('maxModelCallsPerTrial: maxCalls', 'maxModelCallsPerAttempt: maxCalls').replace('providerCallLimitRequested: true, ', '').replace('reference: modelName, modelCode: modelRow.modelCode', 'modelCode: modelRow.modelCode')
    await writeFile(runner, source)
    const compatible = await probeRunnerIntegration(workspace, join(dir, 'compatible'))
    assert.equal(compatible.every(c => c.passed), true, JSON.stringify(compatible))
    assert.ok(source.includes('const { maxModelCalls: maxCalls, maxTurns } = parseEvaluationBudgets(args)'))
    await writeFile(runner, source.replace('const { maxModelCalls: maxCalls, maxTurns } = parseEvaluationBudgets(args)', "const maxCalls = Number(option('--max-model-calls', option('--max-calls', '24'))); const maxTurns = Number(option('--max-turns', '24')); if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 256) throw new Error('--max-model-calls invalid budget integer')"))
    const defective = await probeRunnerIntegration(workspace, join(dir, 'defective'))
    assert.equal(defective.filter(c => c.passed).length, 5)
    assert.deepEqual(defective.filter(c => !c.passed).map(c => c.name), ['conflicting aliases rejected before CLI', 'duplicate budget flag rejected before CLI', 'missing budget value rejected before CLI'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
