import { afterEach, expect, it, vi } from 'vitest'
import type { LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import { createModelEffectExecutor, createProviderAdapter } from '@hunterzhu/pulse-adapters'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'
import { normalizeModelConfig } from '../packages/server/src/model-config.js'
import { normalizeDiscoveredModel } from '../packages/server/src/providers/onboarding.js'
import { captureRunModelRouting, restoreRunModelRouting } from '../packages/server/src/run-model-routing.js'

const request: LLMRequestProjection = {
  contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'fixture', instruction: 'Reply briefly', privacy: 'cloud_allowed', privacyRefs: [] },
  blocks: [{ kind: 'instruction', content: 'Reply briefly' }], prefixHash: 'prefix', projectionHash: 'fixture', builderVersion: '2', policyVersion: '1', toolSetVersion: '1', privacy: 'cloud_allowed', privacyRefs: [],
}
afterEach(() => vi.unstubAllGlobals())

it('sends each task and fallback its exact effort and preserves configured model and provider defaults', async () => {
  const payloads: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body); payloads.push(body)
    if (body.reasoning_effort === 'xhigh') return Response.json({ error: { message: 'Unsupported reasoning_effort', param: 'reasoning_effort' } }, { status: 400 })
    return Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })
  }))
  const profile = { provider: 'openai-compatible', baseURL: 'http://127.0.0.1:12345/v1', reasoningEffort: 'low' as const }
  const routing = createHostModelRouting({ activeModel: 'primary', activeProvider: profile, providerModels: { primary: { provider: 'openai-compatible', model: 'primary-code', reasoningEffort: 'medium', maxOutputTokens: 2048 }, backup: { provider: 'openai-compatible', model: 'backup-code', maxOutputTokens: 1024 } }, taskRouting: { reason: [{ model: 'primary', reasoningEffort: 'xhigh' }, { model: 'backup', reasoningEffort: 'none' }], plan: [{ model: 'primary', reasoningEffort: 'minimal' }], merge: ['primary'], verify: ['backup'] } })
  const execute = createModelEffectExecutor(routing), signal = new AbortController().signal
  const run = (task: string, attemptNo = 1) => execute({ id: 'test-effect', attemptId: `attempt-${attemptNo}`, attemptNo, kind: 'llm', input: { task, request, requirements: { reasoningEffort: 'low' } }, retryPolicy: { maxAttempts: 2 } } as never, signal)
  expect(await run('reason')).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_REASONING_UNSUPPORTED', retryable: true } })
  expect(payloads).toHaveLength(1)
  expect(await run('reason', 2)).toMatchObject({ executionState: 'succeeded' })
  await run('plan'); await run('merge'); await run('verify')
  expect(payloads.map(body => [body.model, body.reasoning_effort, body.max_tokens])).toEqual([
    ['primary-code', 'xhigh', 2048], ['backup-code', 'none', 1024], ['primary-code', 'minimal', 2048], ['primary-code', 'medium', 2048], ['backup-code', 'low', 1024],
  ])
})

it('maps native provider controls and reports insufficient legacy thinking budget before sending a request', async () => {
  const payloads: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    payloads.push(JSON.parse(options.body))
    return String(url).endsWith('/messages') ? Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }) : Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })
  }))
  const base = { request, signal: new AbortController().signal, strictReasoning: true }
  const claude = createProviderAdapter({ provider: 'anthropic', baseURL: 'https://fixture.invalid' })
  await claude.executeAttempt({ ...base, model: 'claude-opus-4-7', reasoningEffort: 'max' })
  await claude.executeAttempt({ ...base, model: 'claude-sonnet-4-6', reasoningEffort: 'none' })
  await expect(claude.executeAttempt({ ...base, model: 'claude-3-7-sonnet', reasoningEffort: 'high', maxOutputTokens: 4096 })).rejects.toMatchObject({ code: 'PROVIDER_REASONING_OUTPUT_BUDGET' })
  const deepseek = createProviderAdapter({ provider: 'deepseek', baseURL: 'https://fixture.invalid' })
  await deepseek.executeAttempt({ ...base, model: 'deepseek-flash', reasoningEffort: 'none' })
  await deepseek.executeAttempt({ ...base, model: 'deepseek-flash', reasoningEffort: 'max' })
  const openrouter = createProviderAdapter({ provider: 'openrouter', baseURL: 'https://fixture.invalid' })
  await openrouter.executeAttempt({ ...base, model: 'vendor/model', reasoningEffort: 'xhigh', supportedReasoningEfforts: ['xhigh'] })
  expect(payloads).toHaveLength(5)
  expect(payloads[0]).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } })
  expect(payloads[1]).toMatchObject({ thinking: { type: 'disabled' } })
  expect(payloads[2]).toMatchObject({ thinking: { type: 'disabled' } }); expect(payloads[2]).not.toHaveProperty('reasoning_effort')
  expect(payloads[3]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
  expect(payloads[4]).toMatchObject({ reasoning: { effort: 'xhigh' }, provider: { require_parameters: true } }); expect(payloads[4]).not.toHaveProperty('reasoning_effort')
})

it('normalizes aliases, retains legacy strings and rejects a known unsupported effort or mandatory-thinking disable', () => {
  const providers = { open: { provider: 'openai', models: { '5': { modelCode: 'gpt-5' }, '5.2': { modelCode: 'gpt-5.2' } } } }
  const config = normalizeModelConfig({ providers, taskRouting: { plan: [{ model: '5.2', reasoningEffort: 'xhigh' }, '5'], reason: [{ model: '5' }] } })
  expect(config.taskRouting).toEqual({ plan: [{ model: 'open/5.2', reasoningEffort: 'xhigh' }, 'open/5'], reason: ['open/5'] })
  expect(() => normalizeModelConfig({ providers, taskRouting: { plan: [{ model: 'open/5', reasoningEffort: 'none' }] } })).toThrow('MODEL_ROUTE_REASONING_UNSUPPORTED')
  const discovered = normalizeDiscoveredModel({ id: 'vendor/model', reasoning: { supported_efforts: ['none', 'xhigh', 'max'], mandatory: true } })
  expect(discovered?.supportedReasoningEfforts).toEqual(['xhigh', 'max'])
})

it('restores an unchanged route order and effort defaults without retaining connection credentials', () => {
  const original = { activeModel: 'p/a', activeProviderCode: 'p', provider: { provider: 'openai-compatible', apiKey: 'fixture-key', reasoningEffort: 'high' as const }, providerProfiles: { p: { provider: 'openai-compatible', reasoningEffort: 'low' as const } }, providerModels: { 'p/a': { provider: 'p', model: 'a', reasoningEffort: 'medium' as const }, 'p/b': { provider: 'p', model: 'b' } }, taskRouting: { plan: [{ model: 'p/a', reasoningEffort: 'max' as const }, 'p/b'] } }
  const saved = JSON.parse(JSON.stringify(captureRunModelRouting(original)))
  expect(JSON.stringify(saved)).not.toContain('fixture-key')
  const changed = { ...original, activeModel: 'p/b', provider: { ...original.provider, defaultModel: 'b', apiKey: 'rotated-key' }, taskRouting: { plan: ['p/b'] }, providerProfiles: { p: { provider: 'openai-compatible', reasoningEffort: 'max' as const, apiKey: 'rotated-key' } } }
  const restored = restoreRunModelRouting(changed, saved)
  expect(restored.activeModel).toBe('p/a')
  expect(restored.taskRouting).toEqual(original.taskRouting)
  expect(restored.providerProfiles?.p?.reasoningEffort).toBe('low')
  expect(restored.provider?.apiKey).toBe('rotated-key')
  expect(restored.providerModels?.['p/a']?.reasoningEffort).toBe('medium')
})
