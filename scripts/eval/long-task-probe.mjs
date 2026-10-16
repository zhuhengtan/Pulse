import { cp, mkdir, readFile, writeFile, symlink, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Run the candidate runner with a fake CLI and the real compiled artifact grader. */
export async function probeRunnerIntegration(workspace, destination, { signal } = {}) {
  signal?.throwIfAborted()
  await mkdir(destination, { recursive: false })
  const staged = join(destination, 'workspace')
  await cp(workspace, staged, { recursive: true, filter: path => !['node_modules', '.git', '.pulse', '.pulse-dev', 'dist', 'web-dist'].includes(path.split('/').at(-1)) })
  // Candidate changes cannot replace the independent artifact grader.
  await cp(join(root, 'scripts/eval/grade.mjs'), join(staged, 'scripts/eval/grade.mjs'))
  await symlink(join(root, 'node_modules'), join(staged, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const name of ['runtime', 'adapters', 'server', 'tool-sdk']) {
    await mkdir(join(staged, 'packages', name), { recursive: true })
    await cp(join(root, 'packages', name, 'dist'), join(staged, 'packages', name, 'dist'), { recursive: true })
    await symlink(join(root, 'packages', name, 'node_modules'), join(staged, 'packages', name, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const dataset = JSON.parse(await readFile(join(staged, 'evals/tasks.v1.json'), 'utf8'))
  for (const task of dataset.tasks) { task.scoring = { method: 'artifact', maxPoints: 1, checks: [{ type: 'fileExists', path: 'result.txt', points: 1 }] }; task.sideEffects.network = false }
  await writeFile(join(destination, 'dataset.json'), JSON.stringify(dataset))
  await writeFile(join(destination, 'fake-cli.mjs'), `import{appendFileSync,writeFileSync}from'node:fs';import{join}from'node:path';const a=process.argv.slice(2),o=k=>a[a.indexOf(k)+1];appendFileSync(process.env.PULSE_EVAL_INVOCATION_LOG,JSON.stringify({model:o('--model'),calls:Number(o('--max-model-calls')),turns:Number(o('--max-turns'))})+'\\n');writeFileSync(join(o('--cwd'),'result.txt'),'offline artifact');console.log(JSON.stringify({type:'result',status:'succeeded',runId:'offline',taskOutcome:{status:'accepted'},usage:{modelCalls:1,inputTokens:10,outputTokens:2,providerCosts:[],completeness:'complete'}}));`)
  const checks = []
  const cases = [
    { name: 'nested explicit call budget', config: { providers: { local: { provider: 'ollama', models: { fixture: { modelCode: 'fixture', maxContextTokens: 32000 } } } } }, model: 'local/fixture', flag: '--max-model-calls', calls: 7, turns: 3 },
    { name: 'nested legacy call alias', config: { providers: { local: { provider: 'ollama', models: { fixture: { modelCode: 'fixture', maxContextTokens: 32000 } } } } }, model: 'local/fixture', flag: '--max-calls', calls: 11, turns: 4 },
    { name: 'legacy flat config', config: { providers: { local: { provider: 'ollama' } }, models: { legacy: { provider: 'local', modelCode: 'fixture', maxContextTokens: 32000 } } }, model: 'legacy', flag: '--max-model-calls', calls: 9, turns: 5 },
  ]
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i], dir = join(destination, `case-${i}`), log = join(dir, 'calls.jsonl')
    await mkdir(dir); await writeFile(join(dir, 'config.json'), JSON.stringify(c.config))
    try {
      const { stdout } = await execute(process.execPath, [join(staged, 'scripts/eval/run.mjs'), '--dataset', join(destination, 'dataset.json'), '--cli', join(destination, 'fake-cli.mjs'), '--config', join(dir, 'config.json'), '--model', c.model, '--task', 'code-01', '--trials', '1', c.flag, String(c.calls), '--max-turns', String(c.turns), '--max-total-tokens', '10000000', '--out', join(dir, 'out'), '--auto-approve'], { cwd: staged, env: { PATH: process.env.PATH, PULSE_EVAL_INVOCATION_LOG: log }, timeout: 30000, signal })
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(calls.length, 1); assert.equal(calls[0].calls, c.calls); assert.equal(calls[0].turns, c.turns)
      const report = JSON.parse(await readFile(join(dir, 'out/report.json'), 'utf8'))
      assert.equal(report.tasksRun, 1); assert.equal(report.budget.maxTurnsPerAttempt, c.turns)
      const reportedCalls = [report.budget.maxModelCallsPerTrial, report.budget.maxModelCallsPerAttempt].filter(value => value !== undefined)
      assert.ok(reportedCalls.length > 0, 'Report must identify the actual call budget')
      for (const value of reportedCalls) assert.equal(value, c.calls, 'Conflicting call-budget report fields')
      if (report.budget.providerCallLimitRequested !== undefined) assert.equal(report.budget.providerCallLimitRequested, true)
      assert.equal(report.budget.providerCallLimitEnforced, false) // fake CLI has no Host ledger; do not claim enforcement
      assert.equal(report.model.provider, 'local'); assert.equal(report.model.modelCode, 'fixture')
      if (report.model.reference !== undefined) assert.equal(report.model.reference, c.model === 'legacy' ? 'local/legacy' : c.model)
      assert.equal(report.score, 1); assert.equal(report.records[0].grading.passed, true)
      checks.push({ name: c.name, passed: true, detail: stdout.slice(-1000), invocations: calls })
    } catch (error) { checks.push({ name: c.name, passed: false, detail: String(error.stderr ?? error.message).slice(-3000) }) }
  }
  for (const [i, bad] of [{ name: 'unknown model rejected before CLI', model: 'local/missing', calls: 7, pattern: /UNKNOWN_MODEL_REFERENCE|Configured.*model.*not found|unknown model/i }, { name: 'zero budget rejected before CLI', model: 'local/fixture', calls: 0, pattern: /max-model-calls|invalid.*budget|budget.*integer/i }, { name: 'conflicting aliases rejected before CLI', model: 'local/fixture', calls: 7, extra: ['--max-calls', '11'], pattern: /conflict/i }, { name: 'duplicate budget flag rejected before CLI', model: 'local/fixture', calls: 7, extra: ['--max-model-calls', '9'], pattern: /duplicate/i }, { name: 'missing budget value rejected before CLI', model: 'local/fixture', calls: 7, extra: ['--max-calls'], pattern: /missing.*budget/i }].entries()) {
    const dir = join(destination, `negative-${i}`), log = join(dir, 'calls.jsonl')
    await mkdir(dir); await writeFile(join(dir, 'config.json'), JSON.stringify(cases[0].config))
    let failure
    try { await execute(process.execPath, [join(staged, 'scripts/eval/run.mjs'), '--dataset', join(destination, 'dataset.json'), '--cli', join(destination, 'fake-cli.mjs'), '--config', join(dir, 'config.json'), '--model', bad.model, '--task', 'code-01', '--trials', '1', '--max-model-calls', String(bad.calls), '--max-turns', '3', '--max-total-tokens', '10000000', '--out', join(dir, 'out'), '--auto-approve', ...(bad.extra ?? [])], { cwd: staged, env: { PATH: process.env.PATH, PULSE_EVAL_INVOCATION_LOG: log }, timeout: 30000, signal }) } catch (error) { failure = error }
    const invoked = await access(log).then(() => true, () => false)
    checks.push({ name: bad.name, passed: !!failure && !invoked && bad.pattern.test(String(failure.stderr ?? failure.message)), detail: String(failure?.stderr ?? failure?.message ?? 'Unexpected CLI invocation or success').slice(-2000) })
  }
  await writeFile(join(destination, 'result.json'), JSON.stringify({ generationCalls: 0, grader: 'actual compiled artifact grader', checks }, null, 2))
  return checks
}
