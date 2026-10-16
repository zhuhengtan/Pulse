import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime, defineLaneProgram } from '../../packages/runtime/dist/index.js'
import { providerHttpErrorFromResponse } from '../../packages/adapters/dist/providers/normalize.js'
import { reserveAttempt, save, load, interviewAnswer } from './long-task-lib.mjs'

for (const length of [5, 10, 20]) for (const width of [1, 2]) for (const compact of length === 20 && width === 2 ? [false, true] : [false]) {
  test(`Runtime ${length} dependency rounds, ${width === 1 ? 'serial' : 'parallel independent tools'}, compaction=${compact}`, async () => {
    let models = 0, completed = 0, summaries = 0
    const program = defineLaneProgram({ id: `calibration-${length}-${width}`, version: '1', ...(compact ? { historyCompaction: { summarizeTask: 'reason', keepRecentRounds: 4 } } : {}) }, builder => {
      builder.addReActLoopStep('work', { instruction: 'Complete every dependent round.', maxTurns: 30, maxToolsPerTurn: 4, onFinish: () => ({ complete: { completed } }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'tool') { completed++; return { value: { writtenRevision: completed } } }
      if (effect.key === '$compact-summary') { summaries++; return { value: { text: `${completed} tool revisions completed; keep current progress.` } } }
      assert.equal(completed, models * width)
      models++
      return { value: models <= length ? { finishReason: 'tool_calls', toolCalls: Array.from({ length: width }, (_, i) => ({ name: 'fixture.update', input: { round: models, lane: i } })) } : { finishReason: 'stop', text: 'All rounds complete.' } }
    } })
    const { agentId } = runtime.createAgent('Long dependency chain', program)
    const outcome = await runtime.start(agentId).outcome()
    if (length === 20 && width === 2 && !compact) {
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.error?.code, 'CONTEXT_TOO_LARGE')
      assert.equal(outcome.error?.details?.lastError?.code, 'CONTEXT_TOO_LARGE')
      assert.match(outcome.error.message, /historyCompaction/)
      return
    }
    assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome))
    assert.equal(models, length + 1); assert.equal(completed, length * width)
    if (compact) assert.ok(summaries > 0)
  })
}
test('transport admission retains all sample and aggregate limits after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-eval-ledger-')), path = join(dir, 'budget.json')
  try {
    save(path, { totalLimit: 96, sampleLimit: 16, used: 0, samples: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`LT0${i + 1}`, 0])) })
    for (let task = 1; task <= 6; task++) for (let call = 1; call <= 16; call++) assert.equal(reserveAttempt(path, `LT0${task}`).sample, call)
    assert.equal(load(path).used, 96)
    assert.throws(() => reserveAttempt(path, 'LT01'), /budget exhausted/)
    assert.equal(load(path).used, 96)
    await writeFile(path, '{bad json')
    assert.throws(() => reserveAttempt(path, 'LT01'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('owner simulator never chooses implementation or an unknown option', () => {
  assert.deepEqual(interviewAnswer({ options: [{ label: '暂不执行', value: '暂不执行' }, { label: '执行', value: '执行' }] }).value, { value: '暂不执行' })
  assert.equal(interviewAnswer({ prompt: '使用哪种新偏好？', options: ['未知A', '未知B'] }).unanswered, true)
  assert.match(interviewAnswer({ prompt: '预算是多少？' }).value.text, /96/)
  assert.equal(interviewAnswer({ prompt: '同名文件已存在？', options: ['换个名字', '覆盖'] }).value.value, '换个名字')
})

test('HTTP 429 remains a retryable provider limit, not a business-task verdict', async () => {
  const error = await providerHttpErrorFromResponse(new Response(JSON.stringify({ error: { message: 'Local simulated rate limit' } }), { status: 429 }))
  assert.equal(error.code, 'PROVIDER_HTTP_429'); assert.equal(error.retryable, true)
})

test('a slow tool is cancelled through its actual AbortSignal without reporting completion', async () => {
  let started, aborted = false
  const entered = new Promise(resolve => { started = resolve })
  const program = defineLaneProgram({ id: 'slow-tool-calibration', version: '1' }, builder => {
    builder.addReActLoopStep('work', { instruction: 'Wait for slow work', maxTurns: 4, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async (effect, signal) => {
    if (effect.kind !== 'tool') return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fixture.slow', input: {} }] } }
    started()
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    return { status: 'cancelled', executionState: 'cancelled' }
  } })
  const { agentId } = runtime.createAgent('Slow cancellable task', program), session = runtime.start(agentId), outcome = session.outcome()
  await entered; await session.cancel('OFFLINE_EVALUATION_CANCEL')
  assert.equal((await outcome).status, 'cancelled'); assert.equal(aborted, true)
})

test('LT06 actual rename and report-layout choices select exact values with truthful basis', () => {
  const options = [
    { value: 'v2', label: 'docs/plans/pulse-long-task-evaluation-v2.md，保留原文件' },
    { value: 'subdir', label: '子目录新文件' },
    { value: 'other', label: '其它新文件名' },
    { value: 'overwrite', label: '覆盖' },
  ]
  for (const choices of [options, [...options].reverse()]) {
    const answer = interviewAnswer({ prompt: '同名文件已存在，请选择新路径', options: choices })
    assert.equal(answer.value.value, 'v2'); assert.match(answer.basis, /v2/); assert.doesNotMatch(answer.basis, /subdir/)
  }
  assert.equal(interviewAnswer({ prompt: '计划路径已存在', options: [{ value: 'new-name-other', label: '其它新文件名' }, { value: 'new-name-v2', label: 'v2' }] }).value.value, 'new-name-v2')
  assert.equal(interviewAnswer({ prompt: '报告怎么组织？', options: [{ value: 'single-file-overview-first', label: '单文件' }, { value: 'multi-file', label: '每例独立报告+汇总README' }] }).value.value, 'multi-file')
  assert.equal(interviewAnswer({ prompt: '同名文件存在', options: [{ value: 'subdir', label: '子目录新文件' }, { value: 'other', label: '其它新文件名' }] }).unanswered, true)
})

test('increased round budgets are strict and do not mutate the previous round', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-raised-budget-')), path = join(dir, 'budget.json')
  try {
    save(path, { totalLimit: 384, sampleLimit: 64, used: 0, samples: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`LT0${i + 1}`, 0])) })
    for (let i = 0; i < 64; i++) reserveAttempt(path, 'LT01')
    assert.equal(load(path).used, 64)
    assert.throws(() => reserveAttempt(path, 'LT01'), /budget exhausted/)
    assert.equal(load(path).samples.LT02, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('transport failure and unknown usage stop batch admission; business failure does not', async () => {
  const { evaluationBlockReason } = await import('./long-task-lib.mjs')
  assert.match(evaluationBlockReason({ outcome: { error: { code: 'PROVIDER_NETWORK_ERROR' } }, outerAttempts: 1 }), /provider_block/)
  assert.match(evaluationBlockReason({ outcome: { status: 'failed' }, outerAttempts: 1, usage: { inputTokens: null, outputTokens: null } }), /unknown_usage/)
  assert.equal(evaluationBlockReason({ outcome: { status: 'failed', error: { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' } }, outerAttempts: 64, usage: { inputTokens: 100, outputTokens: 10 } }), undefined)
  assert.equal(evaluationBlockReason({ outerAttempts: 0 }), undefined)
})

test('transport diagnostics retain DOM timeout names and redact arbitrary codes/messages', async () => {
  const { transportErrorCode } = await import('./long-task-lib.mjs')
  assert.equal(transportErrorCode(new DOMException('https://user:secret@private/path', 'TimeoutError')), 'TimeoutError')
  assert.equal(transportErrorCode({ cause: { code: 'ENOTFOUND' } }), 'ENOTFOUND')
  assert.equal(transportErrorCode({ code: 'SECRET_TOKEN', message: 'sensitive', name: 'https://user:pass@host' }), 'TRANSPORT_ERROR')
})

test('opaque final option values preserve the safe answer; reversed or arbitrary labels stay unanswered', () => {
  const options = [{ label: '暂不执行（默认，保持计划）', value: 'hold' }, { label: '执行（开始P0-P4）', value: 'execute' }]
  assert.deepEqual(interviewAnswer({ prompt: '计划已保存，请选择下一步', options }).value, { value: 'hold' })
  assert.equal(interviewAnswer({ prompt: '计划是否执行', options }).final, true)
  assert.equal(interviewAnswer({ prompt: '计划是否执行', options: [...options].reverse() }).unanswered, true)
  assert.equal(interviewAnswer({ prompt: '其它偏好', options: [{ label: 'A', value: 'hold' }, { label: 'B', value: 'execute' }] }).unanswered, true)
})

test('absolute deadline is inherited and owner waiting never renews it', async () => {
  const { remainingEvaluationMs } = await import('./long-task-lib.mjs')
  const at = '2026-10-15T00:00:00.000Z', start = Date.parse(at)
  assert.equal(remainingEvaluationMs(at, 1200000, start + 1100000), 100000)
  assert.equal(remainingEvaluationMs(at, 1200000, start + 1200000), 0)
  assert.equal(remainingEvaluationMs(at, 1200000, start + 1200001), 0)
  assert.throws(() => remainingEvaluationMs('invalid', 1200000, start), /EVAL_DEADLINE_INVALID/)
})

test('unknown open questions remain waiting instead of recycling unrelated owner facts', () => {
  assert.equal(interviewAnswer({ prompt: '界面应该用什么配色？' }).unanswered, true)
  assert.equal(interviewAnswer({ prompt: '报告如何组织？', options: [{ label: 'A) 每例一份独立报告 + 一份总报告', value: 'A' }, { label: 'B) 单一总报告', value: 'B' }] }).value.value, 'A')
})

test('explicit null evaluator limits preserve accounting without a hidden cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-eval-unbounded-')), path = join(dir, 'budget.json')
  try {
    save(path, { totalLimit: null, sampleLimit: null, used: 0, samples: { LT01: 0 } })
    for (let i = 0; i < 300; i++) reserveAttempt(path, 'LT01')
    assert.equal(load(path).used, 300)
    assert.equal(load(path).sampleLimit, null)
    save(path, { totalLimit: 2, sampleLimit: null, used: 0, samples: { LT01: 0 } })
    reserveAttempt(path, 'LT01'); reserveAttempt(path, 'LT01')
    assert.throws(() => reserveAttempt(path, 'LT01'), /budget exhausted/)
    save(path, { totalLimit: null, sampleLimit: 2, used: 0, samples: { LT01: 0 } })
    reserveAttempt(path, 'LT01'); reserveAttempt(path, 'LT01')
    assert.throws(() => reserveAttempt(path, 'LT01'), /budget exhausted/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
