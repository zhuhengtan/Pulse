import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, cp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { prepareEvaluationSupport, probeEvaluationEnvironment } from './long-task-support.mjs'
import { gradeCase } from './long-task-grade.mjs'
import { save, load } from './long-task-lib.mjs'
import { historicalAccounting } from './resume.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), exec = promisify(execFile)
test('actual LT02 failure stays failed; repaired fixture passes all nine independent assertions and executable tests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-lt02-replay-'))
  try {
    const task = load(join(root, 'evals/long-tasks.v1.json')).tasks.find(t => t.id === 'LT02')
    for (const kind of ['real', 'repaired', 'v17-real', 'v17-repaired']) {
      const fixture = load(join(root, `tests/fixtures/lt02-${kind}-regression.json`))
      const out = join(dir, kind), caseDir = join(out, 'LT02'), workspace = join(caseDir, 'workspace')
      await mkdir(workspace, { recursive: true })
      for (const name of ['scripts', 'evals']) await cp(join(root, name), join(workspace, name), { recursive: true })
      await writeFile(join(workspace, 'package.json'), '{"type":"module"}')
      for (const [path, content] of Object.entries(fixture.files)) { await mkdir(join(workspace, path, '..'), { recursive: true }); await writeFile(join(workspace, path), content) }
      const support = await prepareEvaluationSupport(workspace)
      await probeEvaluationEnvironment(workspace, join(caseDir, 'environment'))
      save(join(out, 'frozen.json'), { dataset: { limits: { perSampleCalls: 32 } }, support: { LT02: support } })
      save(join(caseDir, 'before.json'), {})
      save(join(caseDir, 'result.json'), { outcome: { status: 'failed', error: { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' } }, taskOutcome: { status: 'failed' }, outerAttempts: 30 })
      const grade = await gradeCase(out, task)
      const independent = grade.checks.filter(c => c.name.startsWith('独立恢复验收:'))
      assert.equal(independent.length, 9)
      assert.equal(independent.filter(c => c.passed).length, kind === 'real' ? 6 : kind === 'v17-real' ? 7 : 9, JSON.stringify(independent))
      assert.equal(grade.businessStatus, 'failed') // repaired artifacts do not rewrite the real run outcome
      if (kind === 'real') assert.deepEqual(independent.filter(c => !c.passed).map(c => c.name.split(': ')[1]), ['duplicate-terminal-history-summary', 'resumed-token-cap-not-reset', 'resumed-unknown-cost-cap-not-reset'])
      if (kind === 'v17-real') assert.deepEqual(independent.filter(c => !c.passed).map(c => c.name.split(': ')[1]), ['duplicate-terminal-history-summary', 'resumed-unknown-cost-cap-not-reset'])
      if (kind.startsWith('v17-')) {
        for (const file of ['resume.test.mjs', 'run-resume.test.mjs']) {
          const run = await exec(process.execPath, ['--test', `scripts/eval/${file}`], { cwd: workspace, env: { PATH: process.env.PATH }, timeout: 30000 })
          assert.match(run.stdout, new RegExp(`pass ${file === 'resume.test.mjs' ? 10 : 4}`))
        }
      }
      if (kind === 'repaired') {
        const helper = await exec(process.execPath, ['--test', 'scripts/eval/resume.test.mjs'], { cwd: workspace, env: { PATH: process.env.PATH }, timeout: 30000 })
        assert.match(helper.stdout, /pass 8/)
        const integration = await exec(process.execPath, ['--test', 'scripts/eval/resume-e2e.test.mjs'], { cwd: workspace, env: { PATH: process.env.PATH }, timeout: 30000 })
        assert.match(integration.stdout, /all resume end-to-end checks passed/)
        assert.match(integration.stdout, /fake task grading failure remains a failure/)
        assert.match(integration.stdout, /unfinished edited fixture is not overwritten/)
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('prepare provisions fixed dependencies, runs no-model environment check, and rejects stale prechecks before auth or fetch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-eval-support-')), out = join(dir, 'prepared')
  try {
    await exec(process.execPath, [join(root, 'scripts/eval/long-tasks.mjs'), 'prepare', '--out', out, '--task', 'LT02', '--sample-calls', '32'], { cwd: root, env: { PATH: process.env.PATH }, timeout: 60000 })
    const workspace = join(out, 'LT02/workspace'), frozen = load(join(out, 'frozen.json'))
    assert.ok(Object.keys(frozen.support.LT02).length > 200)
    assert.equal(load(join(out, 'LT02/environment-check/result.json')).generationCalls, 0)
    await assert.rejects(access(join(workspace, 'tests/fixtures/lt02-repaired-regression.json')))
    await assert.rejects(access(join(workspace, 'tests/fixtures/lt02-v17-repaired-regression.json')))
    const runner = join(workspace, 'scripts/eval/run.mjs')
    await writeFile(runner, await readFile(runner, 'utf8') + '\n// stale after setup\n')
    let failure
    try { await exec(process.execPath, [join(root, 'scripts/eval/long-task-worker.mjs'), out, 'LT02'], { cwd: root, env: { PATH: process.env.PATH }, timeout: 30000 }) } catch (error) { failure = error }
    assert.match(String(failure?.stderr), /EVAL_ENVIRONMENT_PRECHECK_STALE/)
    assert.equal(load(join(out, 'budget.json')).used, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('main runner inherits one terminal accounting view, with unknown currency and zero price distinguished', () => {
  const row = { taskId: 'A', trial: 1, status: 'failed', usage: { inputTokens: 10, outputTokens: 2, providerCosts: [{ currency: 'USD', amount: 0 }] } }
  const raw = [row, structuredClone(row), { taskId: 'B', trial: 1, status: 'running' }]
  assert.deepEqual(historicalAccounting(raw, 'USD'), { records: [row], tokens: 12, unknownTokenRuns: 0, costUnknown: false, knownCost: 0 })
  assert.equal(raw.length, 3)
  assert.equal(historicalAccounting(raw, 'CNY').costUnknown, true)
  assert.equal(historicalAccounting([{ ...row, usage: { inputTokens: 10, outputTokens: 2 } }], 'USD').costUnknown, true)
  assert.equal(historicalAccounting([{ ...row, usage: null }], 'USD').unknownTokenRuns, 1)
  assert.throws(() => historicalAccounting([row, { ...row, status: 'succeeded' }], 'USD'), /EVAL_RECORD_CONFLICT/)
})
