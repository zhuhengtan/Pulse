import { it, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { processFrontModel } from '../packages/server/src/front-model.js'
import { createModelEffectExecutor, OpenAICompatibleAdapter } from '../packages/adapters/src/index.js'
import { InMemoryModelRegistry, ModelRouter } from '../packages/runtime/src/index.js'

const root = await mkdtemp(join(tmpdir(), 'pulse-budget-continuation-'))
const realFetch = globalThis.fetch
function check(name: string, body: () => Promise<void>) {
  it(name, async () => { try { await body() } finally { globalThis.fetch = realFetch } })
}
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const budgetPath = name => join(root, name, 'model-budget.json')
const projection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'local_only', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'local_only', privacyRefs: [] }
const signal = new AbortController().signal
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
const rejectedReasoning = () => new Response(JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'", type: 'invalid_request_error', param: 'reasoning_effort' } }), { status: 400, headers: { 'content-type': 'application/json' } })

check('reopen preserves used and original limit', async () => {
  const p = budgetPath('restore'), budget = await ModelAttemptBudget.open(p, 2)
  await budget.reserve()
  const restored = await ModelAttemptBudget.open(p, 99)
  assert.equal(restored.used, 1); assert.equal(restored.limit, 2)
  await restored.reserve()
  await assert.rejects(restored.reserve(), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED', retryable: false })
  assert.equal(JSON.parse(await readFile(p, 'utf8')).used, 2)
  // Windows stat exposes synthetic mode bits; POSIX chmod is not its ACL model.
  if (process.platform !== 'win32') assert.equal((await stat(p)).mode & 0o777, 0o600)
})
check('continuations inherit unspent calls across cold reopening without double-counting attempts', async () => {
  const firstPath = budgetPath('lineage-first'), first = await ModelAttemptBudget.open(firstPath, 4)
  await first.reserve('planning'); await first.reserve('approval')
  const nextPath = budgetPath('lineage-next'), next = await ModelAttemptBudget.open(nextPath, 64)
  await next.inheritRemaining(firstPath)
  assert.equal(next.limit, 2); assert.equal(next.used, 0)
  await next.reserve('work')
  const restored = await ModelAttemptBudget.open(nextPath, 64)
  await restored.inheritRemaining(firstPath)
  assert.equal(restored.limit, 2); assert.equal(restored.used, 1)
  await restored.reserve('verification')
  const third = await ModelAttemptBudget.open(budgetPath('lineage-third'), 64)
  await third.inheritRemaining(nextPath)
  assert.equal(third.limit, 0)
  await assert.rejects(third.reserve(), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  assert.equal(first.used + restored.used + third.used, 4)
})
check('parallel reservations admit exactly limit', async () => {
  const budget = await ModelAttemptBudget.open(budgetPath('parallel'), 3)
  const settled = await Promise.allSettled(Array.from({ length: 12 }, () => budget.reserve()))
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 3)
  assert.equal(budget.used, 3)
})
check('corrupt ledger fails closed', async () => {
  const p = budgetPath('corrupt'); await ModelAttemptBudget.open(p, 3)
  await writeFile(p, '{broken')
  await assert.rejects(ModelAttemptBudget.open(p, 99), { code: 'TASK_MODEL_CALL_BUDGET_CORRUPT' })
  assert.equal(await readFile(p, 'utf8'), '{broken')
})
check('legacy seed is retained', async () => {
  const budget = await ModelAttemptBudget.open(budgetPath('seed'), 4, 3)
  assert.equal(budget.used, 3); await budget.reserve()
  await assert.rejects(budget.reserve(), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
})
check('failed persistence does not advance count', async () => {
  const p = budgetPath('persist-fail'), budget = await ModelAttemptBudget.open(p, 2)
  await rm(join(root, 'persist-fail'), { recursive: true })
  await writeFile(join(root, 'persist-fail'), 'parent is a file')
  await assert.rejects(budget.reserve()); assert.equal(budget.used, 0)
})
check('executor hook blocks before provider request', async () => {
  const registry = new InMemoryModelRegistry()
  registry.register({ id: 'mock-model', providerId: 'p', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 })
  let calls = 0, sent: any
  const budget = await ModelAttemptBudget.open(budgetPath('executor'), 1)
  const config = { router: new ModelRouter(registry), providers: new Map([['p', { id: 'p', name: 'p', executeAttempt: async request => { sent = request.request; calls++; return { text: 'ok', toolCalls: [], finishReason: 'stop' } } }]]), beforeProviderAttempt: () => budget.reserve(), modelBudget: () => ({ limit: budget.limit, used: budget.used }) }
  const first = createModelEffectExecutor(config), detachedReview = createModelEffectExecutor(config)
  const effect = id => ({ id, agentId: 'agent', ownerLaneId: 'lane', key: 'reason', kind: 'llm', input: { task: 'reason', request: projection }, attemptId: id, attemptNo: 1 })
  const admitted = await first(effect('main'), signal)
  assert.equal(admitted.executionState, 'succeeded')
  assert.equal(admitted.metadata.providerAttempts, 1)
  assert.match(JSON.stringify(sent.blocks), /limit=1, used=1.*remaining=0/)
  assert.notEqual(sent.projectionHash, projection.projectionHash)
  assert.equal(projection.blocks.length, 1)
  const blocked = await detachedReview(effect('review'), signal)
  assert.equal(blocked.error.code, 'TASK_MODEL_CALL_BUDGET_EXHAUSTED')
  assert.equal(blocked.metadata.providerAttempts, 0)
  assert.equal(calls, 1); assert.equal(budget.used, 1)
})
check('adapter internal retry reserves before second fetch', async () => {
  let fetches = 0, retries = 0
  globalThis.fetch = async () => ++fetches === 1 ? rejectedReasoning() : success()
  const adapter = new OpenAICompatibleAdapter('openai', { provider: 'openai', reasoningEffort: 'high', defaultModel: 'gpt-5.6' })
  await adapter.executeAttempt({ request: projection, signal, beforeRetryAttempt: async () => { retries++ } })
  assert.equal(fetches, 2); assert.equal(retries, 1)
})
check('adapter exhausted retry does not send second fetch', async () => {
  let fetches = 0
  globalThis.fetch = async () => { fetches++; return rejectedReasoning() }
  const adapter = new OpenAICompatibleAdapter('openai', { provider: 'openai', reasoningEffort: 'high', defaultModel: 'gpt-5.6' })
  await assert.rejects(adapter.executeAttempt({ request: projection, signal, beforeRetryAttempt: async () => { throw Object.assign(new Error('exhausted'), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED', retryable: false }) } }), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  assert.equal(fetches, 1)
})
check('front hook exhaustion is not swallowed', async () => {
  let fetches = 0
  globalThis.fetch = async () => { fetches++; return success() }
  await assert.rejects(processFrontModel('inspect', undefined, { enabled: true, model: 'fixture' }, [], [], async () => { throw Object.assign(new Error('exhausted'), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' }) }), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  assert.equal(fetches, 0)
})
check('front internal retry shares reservation hook', async () => {
  let fetches = 0, reservations = 0
  globalThis.fetch = async () => ++fetches === 1 ? rejectedReasoning() : success()
  await processFrontModel('inspect', undefined, { enabled: true, provider: 'openai-compatible', model: 'gpt-5.6' }, [], [], async () => { reservations++ })
  assert.equal(reservations, fetches, 'front-model internal retry omitted reservation')
})
