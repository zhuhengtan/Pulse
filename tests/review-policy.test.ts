import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { createModelEffectExecutor, type ProviderAdapter } from '@hunterzhu/pulse-adapters'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'
import { ReviewLedger } from '../packages/server/src/review-ledger.js'
import { runPlanReviewRequest } from '../packages/server/src/index.js'

afterEach(() => vi.useRealTimers())
it('shares the same saved-plan allowance when the request wrapper is reconstructed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-plan-review-restore-'))
  let calls = 0
  const adapter: ProviderAdapter = { id: 'openai-compatible', name: 'offline', async executeAttempt() { calls++; throw Object.assign(new Error('offline'), { code: 'PROVIDER_NETWORK_ERROR', retryable: true }) } }
  const routing = createHostModelRouting({ activeModel: 'fixture', activeProvider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 128000, maxOutputTokens: 16384 }, activeAdapter: adapter })
  const path = join(root, 'attempts.jsonl')
  const execute = createModelEffectExecutor({ ...routing, reviewPolicy: new ReviewLedger(path) })
  const request = { ...routing, execute, system: 'Review the saved plan.', instruction: JSON.stringify({ savedPlan: { path: 'plan.md', hash: 'same', content: 'Same plan and evidence.' } }), maxOutputTokens: 8192, signal: new AbortController().signal }
  try {
    await expect(runPlanReviewRequest(request, true, 128000, true, undefined, true, true)).rejects.toThrow()
    expect(calls).toBe(2)
    const restored = createModelEffectExecutor({ ...routing, reviewPolicy: new ReviewLedger(path) })
    try { await expect(runPlanReviewRequest({ ...request, execute: restored }, true, 128000, true, undefined, true, true)).rejects.toThrow() }
    finally { restored.dispose() }
    expect(calls).toBe(2)
  } finally { execute.dispose(); await rm(root, { recursive: true, force: true }) }
})
it('does not reset review allowance when the durable journal is incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-review-bad-journal-')), path = join(root, 'attempts.jsonl')
  try {
    await writeFile(path, '{"type":"claim"')
    await expect(new ReviewLedger(path).claim('same')).rejects.toMatchObject({ code: 'REVIEW_LEDGER_INVALID', retryable: false })
    expect(await readFile(path, 'utf8')).toBe('{"type":"claim"')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, 'medium'] as const)('clamps to a 4K reviewer and honors only an explicit verify effort override (%s)', async effort => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-small-review-')), seen: any[] = []
  const adapter: ProviderAdapter = { id: 'openai-compatible', name: 'small', async executeAttempt(input) { seen.push(input); return { text: '{"ok":true}', toolCalls: [], finishReason: 'stop' } } }
  const routing = createHostModelRouting({ activeModel: 'small', activeProvider: { provider: 'openai-compatible', defaultModel: 'small', maxContextTokens: 32000, maxOutputTokens: 4096, reasoningEffort: 'high' }, activeAdapter: adapter, ...(effort ? { taskRouting: { verify: [{ model: 'small', reasoningEffort: effort }] } } : {}) })
  const execute = createModelEffectExecutor({ ...routing, reviewPolicy: new ReviewLedger(join(root, 'attempts.jsonl')) })
  const program = defineLaneProgram({ id: 'small-review', version: '1', reviewExecution: true, requestOutputReserveTokens: 16384 }, b => b.addStructuredLLMStep('verify', { task: 'verify', instruction: 'Review the supplied receipts.', schema: z.object({ ok: z.boolean() }), onSuccess: value => ({ complete: { value } }) }))
  try {
    const runtime = new PulseRuntime({ ...routing, effectExecutor: execute })
    expect((await runtime.start(runtime.createAgent('Review.', program).agentId).outcome()).status).toBe('succeeded')
    expect(seen).toHaveLength(1)
    expect(seen[0].maxOutputTokens).toBe(4096)
    expect(seen[0].reasoningEffort).toBe(effort ?? 'low')
  } finally { execute.dispose(); await rm(root, { recursive: true, force: true }) }
})
it('serializes claims, preserves the two-request allowance across restore, and budgets each attempt independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-review-ledger-'))
  let now = 1000
  const path = join(dir, 'attempts.jsonl')
  try {
    const ledger = new ReviewLedger(path, () => now)
    expect(await ledger.claim('review')).toEqual({ attempt: 1, timeoutMs: 60000 })
    now += 59000
    const restored = new ReviewLedger(path, () => now)
    expect(await restored.claim('review')).toEqual({ attempt: 2, timeoutMs: 45000 })
    await expect(restored.claim('review')).rejects.toMatchObject({ code: 'REVIEW_ATTEMPTS_EXHAUSTED', retryable: false })
    const concurrent = await Promise.allSettled([ledger.claim('other'), ledger.claim('other'), ledger.claim('other')])
    expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    now += 105001
    await expect(new ReviewLedger(path, () => now).claim('other')).rejects.toMatchObject({ code: 'REVIEW_ATTEMPTS_EXHAUSTED' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it.each(['success', 'truncated', 'schema', 'network', 'authentication', 'refusal', 'exhausted'] as const)('bounds a structured code review without replaying work (%s)', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-code-review-'))
  const requests: Array<{ maxOutputTokens?: number; reasoningEffort?: string }> = []
  const adapter: ProviderAdapter = { id: 'openai-compatible', name: 'fixture', async executeAttempt(input) {
    requests.push(input)
    if (mode === 'authentication') throw Object.assign(new Error('unauthorized'), { code: 'PROVIDER_HTTP_401', retryable: false })
    if (mode === 'refusal') return { text: '', toolCalls: [], finishReason: 'refusal', refusal: 'denied' }
    if (mode === 'exhausted' || requests.length === 1 && mode === 'truncated') return { text: '', toolCalls: [], finishReason: 'length' }
    if (requests.length === 1 && mode === 'schema') return { text: '{"wrong":"shape"}', toolCalls: [], finishReason: 'stop' }
    if (requests.length === 1 && mode === 'network') throw Object.assign(new Error('offline'), { code: 'PROVIDER_NETWORK_ERROR', retryable: true })
    return { text: '{"status":"passed"}', toolCalls: [], finishReason: 'stop' }
  } }
  const routing = createHostModelRouting({ activeModel: 'fixture', activeProvider: { provider: 'openai-compatible', defaultModel: 'fixture', reasoningEffort: 'high', maxContextTokens: 32000, maxOutputTokens: 16384 }, activeAdapter: adapter })
  const execute = createModelEffectExecutor({ ...routing, reviewPolicy: new ReviewLedger(join(dir, 'attempts.jsonl')) })
  const program = defineLaneProgram({ id: 'review', version: '1', reviewExecution: true }, b => b.addStructuredLLMStep('verify-task', {
    task: 'verify', instruction: 'Verify the settled source evidence. Return the verdict.', schema: z.object({ status: z.literal('passed') }),
    onSuccess: result => ({ complete: { value: result } }), onError: error => ({ complete: { value: { status: 'unavailable', code: error.code } } }),
  }))
  try {
    const rt = new PulseRuntime({ ...routing, programs: [program], effectExecutor: execute })
    const outcome = await rt.start(rt.createAgent('Review existing work without editing it.', program).agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    const failed = ['authentication', 'refusal', 'exhausted'].includes(mode)
    expect(rt.state.results.get(outcome.resultRef!)?.value).toMatchObject({ status: failed ? 'unavailable' : 'passed' })
    const expected = ['success', 'authentication', 'refusal'].includes(mode) ? 1 : 2
    expect(requests).toHaveLength(expected)
    expect(requests.map(r => r.maxOutputTokens)).toEqual(expected === 1 ? [8192] : [8192, 16384])
    expect(requests.every(r => r.reasoningEffort === 'low')).toBe(true)
    expect(routing.candidates[0]!.reasoningEffort).toBe('high')
    expect([...rt.state.effects.values()].every(e => e.kind === 'llm')).toBe(true)
    const rows = (await readFile(join(dir, 'attempts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    expect(rows.filter(r => r.type === 'claim')).toHaveLength(expected)
  } finally { execute.dispose(); await rm(dir, { recursive: true, force: true }) }
})

it('gives a timed-out first attempt a separate 45-second retry and honors parent cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-review-timeout-'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let requests = 0
  const adapter: ProviderAdapter = { id: 'openai-compatible', name: 'slow', async executeAttempt(input) {
    requests++; started()
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  } }
  const routing = createHostModelRouting({ activeModel: 'fixture', activeProvider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 32000, maxOutputTokens: 16384 }, activeAdapter: adapter })
  const path = join(dir, 'attempts.jsonl')
  const execute = createModelEffectExecutor({ ...routing, reviewPolicy: new ReviewLedger(path) })
  const program = defineLaneProgram({ id: 'slow-review', version: '1', reviewExecution: true }, b => b.addStructuredLLMStep('verify-task', { task: 'verify', instruction: 'Review.', schema: z.object({ ok: z.boolean() }), onSuccess: () => ({ complete: {} }), onError: e => ({ complete: { value: { code: e.code } } }) }))
  try {
    const rt = new PulseRuntime({ ...routing, programs: [program], effectExecutor: execute })
    const session = rt.start(rt.createAgent('Review retained work.', program).agentId)
    await ready
    const secondReady = new Promise<void>(resolve => { started = resolve })
    await vi.advanceTimersByTimeAsync(60000)
    await secondReady
    const claims = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'claim')
    expect(claims.map(r => r.timeoutMs)).toEqual([60000, 45000])
    await session.cancel('USER_REQUESTED')
    expect((await session.outcome()).status).toBe('cancelled')
    expect(requests).toBe(2)
  } finally { vi.useRealTimers(); execute.dispose(); await rm(dir, { recursive: true, force: true }) }
})
