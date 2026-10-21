import { writeConversationFixture } from './conversation-fixtures.js'
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveEvaluationModel, buildEvaluationArgs } from '../scripts/eval/config-budget.mjs'
import { selectPendingTrials, completedTrials, recoverTrial } from '../scripts/eval/resume.mjs'

const execute = promisify(execFile)
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2))

describe('evaluation model and budget', () => {
  it('uses the shared provider-nested catalog, legacy aliases, and rejects ambiguity', () => {
    const config = { providers: { ds: { provider: 'deepseek', models: { flash: { modelCode: 'deepseek-flash', displayName: 'Flash' } } } } }
    expect(resolveEvaluationModel(config, 'ds/flash')).toMatchObject({ providerCode: 'ds', modelCode: 'deepseek-flash', reference: 'ds/flash' })
    expect(resolveEvaluationModel(config, 'Flash').reference).toBe('ds/flash')
    expect(resolveEvaluationModel({ providers: { ds: { provider: 'deepseek' } }, models: { legacy: { provider: 'ds', modelCode: 'deepseek-flash' } } }, 'legacy')).toMatchObject({ reference: 'ds/legacy', modelCode: 'deepseek-flash' })
    expect(() => resolveEvaluationModel(config, 'ds/missing')).toThrow('UNKNOWN_MODEL_REFERENCE')
    expect(() => resolveEvaluationModel({ providers: { a: { provider: 'ollama', models: { same: { modelCode: 'same' } } }, b: { provider: 'ollama', models: { same: { modelCode: 'same' } } } } }, 'same')).toThrow('AMBIGUOUS_MODEL_REFERENCE')
    expect(config.providers.ds.models.flash.modelCode).toBe('deepseek-flash')
  })
  it('keeps actual attempts separate from turns and validates both', () => {
    expect(buildEvaluationArgs({ maxModelCalls: 16, maxTurns: 32 })).toEqual(['--max-model-calls', '16', '--max-turns', '32'])
    for (const value of [0, -1, NaN, 1.5, 257]) {
      expect(() => buildEvaluationArgs({ maxModelCalls: value, maxTurns: 32 })).toThrow()
      expect(() => buildEvaluationArgs({ maxModelCalls: 16, maxTurns: value })).toThrow()
    }
  })
  it('skips all terminal trials including failures, deduplicates identical rows, rejects conflicts', () => {
    const tasks = [{ id: 'A' }, { id: 'B' }], rows = [{ taskId: 'A', trial: 1, status: 'failed' }, { taskId: 'A', trial: 1, status: 'failed' }, { taskId: 'B', trial: 1, status: 'running' }]
    expect(selectPendingTrials(tasks, 2, rows)).toEqual([{ taskId: 'A', trial: 2 }, { taskId: 'B', trial: 1 }, { taskId: 'B', trial: 2 }])
    for (const status of ['passed', 'partial', 'failed', 'blocked_env', 'succeeded', 'cancelled', 'timeout']) expect(selectPendingTrials([{ id: 'A' }], 1, [{ taskId: 'A', trial: 1, status }])).toEqual([])
    expect(() => completedTrials([...rows, { taskId: 'A', trial: 1, status: 'succeeded' }])).toThrow('EVAL_RECORD_CONFLICT')
    expect(() => completedTrials([{ taskId: 'A', trial: 1, status: 'succeeded', usage: { inputTokens: -10 } }])).toThrow('EVAL_RECORD_USAGE_INVALID')
    expect(() => completedTrials([{ taskId: 'A', trial: 1, status: 'succeeded', usage: { providerCosts: [{ currency: 'USD', amount: -1 }] } }])).toThrow('EVAL_RECORD_COST_INVALID')
  })
})

const fakeCli = `import {appendFileSync,writeFileSync,mkdirSync} from 'node:fs'; import {join} from 'node:path';
const a=process.argv.slice(2), opt=k=>a[a.indexOf(k)+1];
const cwd=opt('--cwd'), calls=Number(opt('--max-model-calls'));
appendFileSync(process.env.PULSE_EVAL_INVOCATION_LOG,JSON.stringify({command:a[0],conversation:a[1],model:opt('--model'),calls,turns:Number(opt('--max-turns')),cwd})+'\\n');
writeFileSync(join(cwd,'result.txt'),'useful artifact');
const mode=process.env.PULSE_EVAL_FAKE_MODE;
console.log(JSON.stringify({type:'result',runId:'run-fake',status:mode==='failure'?'failed':'succeeded',taskOutcome:{status:'accepted'},usage:{modelCalls:a[0]==='resume'?3:2,inputTokens:mode==='unknown'?null:10,outputTokens:2,providerCosts:[],completeness:mode==='unknown'?'partial':'complete'}}));`

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-eval-repair-'))
  const dataset = await json(resolve('evals/tasks.v1.json'))
  for (const task of dataset.tasks) { task.scoring = { method: 'artifact', maxPoints: 1, checks: [{ type: 'fileExists', path: 'result.txt', points: 1 }] }; task.sideEffects.network = false }
  await save(join(directory, 'dataset.json'), dataset)
  await save(join(directory, 'config.json'), { providers: { local: { provider: 'ollama', models: { fixture: { modelCode: 'fixture', maxContextTokens: 32000 } } } } })
  await writeFile(join(directory, 'fake-cli.mjs'), fakeCli)
  const out = join(directory, 'output'), invocationLog = join(directory, 'invocations.jsonl')
  const args = [resolve('scripts/eval/run.mjs'), '--dataset', join(directory, 'dataset.json'), '--cli', join(directory, 'fake-cli.mjs'), '--config', join(directory, 'config.json'), '--model', 'local/fixture', '--task', 'code-01', '--trials', '2', '--max-calls', '16', '--max-turns', '32', '--max-total-tokens', '10000000', '--out', out, '--auto-approve']
  const run = (extra: string[] = [], mode = '') => execute(process.execPath, [...args, ...extra], { env: { ...process.env, PULSE_EVAL_INVOCATION_LOG: invocationLog, PULSE_EVAL_FAKE_MODE: mode }, timeout: 30000 })
  const invocations = async () => (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { directory, out, args, run, invocations }
}

describe('real batch entry with an offline fake CLI', () => {
  it('forwards budgets and nested model references; resume never repeats finished or failed trials', async () => {
    const f = await fixture()
    try {
      await f.run([], 'failure')
      expect(await f.invocations()).toMatchObject([{ model: 'local/fixture', calls: 16, turns: 32 }, { model: 'local/fixture', calls: 16, turns: 32 }])
      const before = await readFile(join(f.out, 'runs.jsonl'), 'utf8'), artifact = await readFile(join(f.out, 'workspaces/code-01/trial-1/result.txt'), 'utf8')
      await f.run(['--resume'])
      expect(await f.invocations()).toHaveLength(2)
      expect(await readFile(join(f.out, 'runs.jsonl'), 'utf8')).toBe(before)
      expect(await readFile(join(f.out, 'workspaces/code-01/trial-1/result.txt'), 'utf8')).toBe(artifact)
      expect((await json(join(f.out, 'report.json'))).tasksRun).toBe(2)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })
  it('reuses a saved capture after interruption without repeating model execution', async () => {
    const f = await fixture()
    try {
      await f.run()
      const rows = (await readFile(join(f.out, 'runs.jsonl'), 'utf8')).trim().split('\n')
      await writeFile(join(f.out, 'runs.jsonl'), rows[0] + '\n')
      const batch = await json(join(f.out, 'batch.json')); batch.trials['code-01:2'].status = 'running'
      await save(join(f.out, 'batch.json'), batch)
      await f.run(['--resume'])
      expect(await f.invocations()).toHaveLength(2)
      expect((await json(join(f.out, 'report.json'))).budget.actualTokens).toBe(24)
      expect((await readFile(join(f.out, 'runs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })
  it.each([false, true])('resumes original Host identity; expired deadline=%s never starts new work', async expired => {
    const f = await fixture()
    try {
      await f.run()
      const rows = (await readFile(join(f.out, 'runs.jsonl'), 'utf8')).trim().split('\n')
      await writeFile(join(f.out, 'runs.jsonl'), rows[0] + '\n')
      await rm(join(f.out, 'captures/code-01-trial-2.json'))
      const batch = await json(join(f.out, 'batch.json')); Object.assign(batch.trials['code-01:2'], { status: 'running', childPid: null, runId: 'run-original' })
      if (expired) batch.trials['code-01:2'].startedAt = Date.now() - 700000
      await save(join(f.out, 'batch.json'), batch)
      const dataDir = join(f.out, 'pulse-data/code-01/trial-2'), conversation = join(dataDir, 'conversations/conv-original')
      await mkdir(join(conversation, 'runs/run-original'), { recursive: true })
      await writeConversationFixture(join(conversation, 'manifest.json'), JSON.stringify({ id: 'conv-original', updatedAt: new Date().toISOString(), activeRunId: 'run-original', runs: ['run-original'] }))
      await save(join(conversation, 'runs/run-original/model-budget.json'), { schemaVersion: 1, limit: 16, used: 2 })
      if (expired) {
        await expect(f.run(['--resume'])).rejects.toThrow('EVAL_TRIAL_DEADLINE_EXPIRED')
        expect(await f.invocations()).toHaveLength(2)
        expect((await json(join(conversation, 'runs/run-original/model-budget.json'))).used).toBe(2)
        return
      }
      await f.run(['--resume'])
      expect((await f.invocations()).at(-1)).toMatchObject({ command: 'resume', conversation: 'conv-original', calls: 16, turns: 32 })
      expect((await json(join(f.out, 'report.json'))).records[1].usage.modelCalls).toBe(3)
      await f.run(['--resume'])
      expect(await f.invocations()).toHaveLength(3)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })
  it('fails closed on corrupt JSONL and changed batch identity before another invocation', async () => {
    const f = await fixture()
    try {
      await f.run()
      const path = join(f.out, 'runs.jsonl'), before = await readFile(path, 'utf8')
      await writeFile(path, before + '{unfinished json')
      await expect(f.run(['--resume'])).rejects.toThrow('EVAL_JSONL_CORRUPT')
      expect(await readFile(path, 'utf8')).toBe(before + '{unfinished json')
      expect(await f.invocations()).toHaveLength(2)
      await writeFile(path, before)
      await save(join(f.directory, 'config.json'), { providers: { local: { provider: 'ollama', models: { fixture: { modelCode: 'fixture', maxContextTokens: 32001 } } } } })
      await expect(f.run(['--resume'])).rejects.toThrow('EVAL_BATCH_IDENTITY_MISMATCH')
      expect(await f.invocations()).toHaveLength(2)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })
  it.each(['unknown', 'cost-unknown'])('retains %s usage boundary across batch resume', async mode => {
    const f = await fixture(), extra = mode === 'cost-unknown' ? ['--max-cost', '1'] : []
    try {
      await f.run(extra, mode === 'unknown' ? 'unknown' : '')
      expect(await f.invocations()).toHaveLength(1)
      await f.run([...extra, '--resume'])
      expect(await f.invocations()).toHaveLength(1)
      expect((await json(join(f.out, 'report.json'))).budgetStopped).toBe(true)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })
  it('rejects an active budget mismatch instead of resetting its counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-eval-budget-mismatch-'))
    try {
      const dir = join(root, 'conversations/conv-fake/runs/run-fake'); await mkdir(dir, { recursive: true })
      await writeConversationFixture(join(root, 'conversations/conv-fake/manifest.json'), JSON.stringify({ id: 'conv-fake', updatedAt: new Date().toISOString(), activeRunId: 'run-fake' }))
      await save(join(dir, 'model-budget.json'), { schemaVersion: 1, limit: 16, used: 7 })
      await expect(recoverTrial(root, { maxModelCalls: 8 })).rejects.toThrow('BUDGET_MISMATCH')
      expect((await json(join(dir, 'model-budget.json'))).used).toBe(7)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('never dispatches a pending reserved trial when inherited history already exceeds the token ceiling', async () => {
    const f = await fixture()
    try {
      await f.run()
      const rows = (await readFile(join(f.out, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      rows[0].usage.inputTokens = 10000002
      await writeFile(join(f.out, 'runs.jsonl'), JSON.stringify(rows[0]) + '\n')
      await rm(join(f.out, 'captures/code-01-trial-2.json'))
      const batch = await json(join(f.out, 'batch.json'))
      Object.assign(batch.trials['code-01:2'], { status: 'running', childPid: null })
      await save(join(f.out, 'batch.json'), batch)
      const history = await readFile(join(f.out, 'runs.jsonl'), 'utf8')
      await f.run(['--resume'])
      expect(await f.invocations()).toHaveLength(2)
      expect(await readFile(join(f.out, 'runs.jsonl'), 'utf8')).toBe(history)
      expect((await json(join(f.out, 'report.json'))).budgetStopped).toBe(true)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })
})
