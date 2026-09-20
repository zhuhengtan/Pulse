import { describe, expect, it } from 'vitest'
import { createModelEffectExecutor, type ProviderAdapter } from '@pulse/adapters'
import { ModelRouter, InMemoryModelRegistry, modelFallbackError, estimateProjectionTokens, type LLMRequestProjection, validateAdapterResult, validateJsonSchema } from '@pulse/runtime'
import { PulseRuntime } from '@pulse/runtime'
import type { EffectRecord, LaneProgram } from '@pulse/runtime'
import { defineLaneProgram } from '@pulse/runtime'
import { z } from 'zod'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })
const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'local_only', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'local_only', privacyRefs: [] }

describe('Provider Adapter to Runtime LLM Effect host', () => {
  it('enforces strict JSON Schema boundaries and numeric/string constraints', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['name', 'count'], properties: { name: { type: 'string', pattern: '^[A-Z]', minLength: 2 }, count: { type: 'integer', minimum: 1, maximum: 3 } } }
    expect(validateJsonSchema({ name: 'OK', count: 2 }, schema)).toBe(true)
    expect(validateJsonSchema({ name: 'ok', count: 2 }, schema)).toBe(false)
    expect(validateJsonSchema({ name: 'OK', count: 2, extra: true }, schema)).toBe(false)
    expect(validateJsonSchema({ name: 'OK', count: 4 }, schema)).toBe(false)
  })

  it('requires an explicit refusal message for refusal outputs', () => {
    expect(() => validateAdapterResult({ text: '', toolCalls: [], finishReason: 'refusal' })).toThrow('INVALID_REFUSAL')
    expect(() => validateAdapterResult({ text: '', refusal: 'not allowed', toolCalls: [], finishReason: 'refusal' })).not.toThrow()
  })

  it('filters candidates whose context window cannot fit the immutable projection', () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'too-small', providerId: 'p1', tasks: ['reason'], capabilities: { local: true, maxContextTokens: estimateProjectionTokens(projection) - 1 }, priority: 10 })
    registry.register({ id: 'fits', providerId: 'p2', tasks: ['reason'], capabilities: { local: true, maxContextTokens: estimateProjectionTokens(projection) }, priority: 1 })
    expect(new ModelRouter(registry).routeProjection('reason', projection).map((candidate) => candidate.id)).toEqual(['fits'])
  })

  it('reserves the requested output budget during model admission', () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'small-output', providerId: 'p1', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096, maxOutputTokens: 7 }, priority: 10 })
    registry.register({ id: 'fits-output', providerId: 'p2', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096, maxOutputTokens: 8 }, priority: 1 })
    const router = new ModelRouter(registry)
    expect(router.routeProjection('reason', projection, { maxOutputTokens: 8 }).map((candidate) => candidate.id)).toEqual(['fits-output'])
    expect(router.diagnostics('reason', projection.privacy, { maxOutputTokens: 8 })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'small-output', accepted: false, reasons: ['OUTPUT_BUDGET_TOO_SMALL'] })]))
  })

  it('rejects a structured-output schema that diverges from the final output schema', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'structured', providerId: 'structured-provider', tasks: ['plan'], capabilities: { local: true, structuredOutput: true, maxContextTokens: 4096, maxOutputTokens: 128 }, priority: 1 })
    let called = false
    const providers = new Map<string, ProviderAdapter>([['structured-provider', { id: 'structured-provider', name: 'structured', executeAttempt: async () => { called = true; return { text: '', structured: { ok: true }, toolCalls: [], finishReason: 'stop' } } }]])
    const executor = createModelEffectExecutor({ router: new ModelRouter(registry), providers })
    const effect = { id: 'effect-1', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'plan', kind: 'llm', concurrencyClass: 'llm', input: { task: 'plan', request: projection, requirements: { structuredOutput: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }, outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] } }, attemptId: 'attempt-1', attemptNo: 0, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord
    const execution = await executor(effect, new AbortController().signal)
    expect(execution).toMatchObject({ status: 'failed', error: { code: 'STRUCTURED_OUTPUT_CONTRACT_MISMATCH' } })
    expect(called).toBe(false)
  })

  it('routes local_only requests, falls back within one Effect, and records attempt metadata', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'local-first', providerId: 'p1', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 2 })
    registry.register({ id: 'local-second', providerId: 'p2', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 })
    registry.register({ id: 'cloud', providerId: 'cloud', tasks: ['reason'], capabilities: { local: false, maxContextTokens: 4096 }, priority: 9 })
    const calls: string[] = []
    const providers = new Map<string, ProviderAdapter>([
      ['p1', { id: 'p1', name: 'first', executeAttempt: async () => { calls.push('p1'); throw modelFallbackError({ retryable: true, localClosed: true, sideEffectState: 'none', cause: new Error('temporary') }) } }],
      ['p2', { id: 'p2', name: 'second', executeAttempt: async () => { calls.push('p2'); return { text: 'ok', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 5 } } } }],
    ])
    const router = new ModelRouter(registry)
    const runtime = new PulseRuntime({ effectExecutor: createModelEffectExecutor({ router, providers }) })
    const program: LaneProgram = { id: 'provider-host', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('provider-host', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('provider-host', 'finish') } }
    const { agentId } = runtime.createAgent('provider', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toEqual(['p1', 'p2'])
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.data).includes('local-second'))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.data).includes('cachedInputTokens'))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.data).includes('uncachedInputTokens'))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.data).includes('latencyMs'))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.data).includes('PRIVACY_CLOUD_BLOCKED'))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'effect.execution_metadata' && JSON.stringify(event.data).includes('slotWaitMs'))).toBe(true)
    const telemetry = runtime.telemetry()
    expect(telemetry.llm.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ effectId: 'effect-1', modelId: 'local-second', providerId: 'p2', usage: expect.objectContaining({ inputTokens: 12, cachedInputTokens: 5, uncachedInputTokens: 7 }) })]))
    expect(telemetry.llm.routeRejections).toMatchObject({ PRIVACY_CLOUD_BLOCKED: 1 })
    expect(telemetry.llm.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, cachedInputTokens: 5, uncachedInputTokens: 7 })
  })

  it('passes a Provider structured payload to the DSL schema decoder', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'structured', providerId: 'structured-provider', tasks: ['plan'], capabilities: { local: true, structuredOutput: true, maxContextTokens: 4096 }, priority: 1 })
    const providers = new Map<string, ProviderAdapter>([['structured-provider', { id: 'structured-provider', name: 'structured', executeAttempt: async () => ({ text: '', structured: { ok: true }, toolCalls: [], finishReason: 'stop' }) }]])
    const program = defineLaneProgram({ id: 'provider-structured', version: '1' }, (builder) => {
      builder.addStructuredLLMStep('plan', { task: 'plan', instruction: 'return structured', schema: z.object({ ok: z.boolean() }), onSuccess: (value) => value.ok ? 'finish' : 'finish' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: createModelEffectExecutor({ router: new ModelRouter(registry), providers }) })
    const { agentId } = runtime.createAgent('structured', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  })

  it('enforces provider and model concurrency slots across simultaneous Effects', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'shared-model', providerId: 'shared-provider', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 })
    let active = 0
    let maximum = 0
    const providers = new Map<string, ProviderAdapter>([['shared-provider', { id: 'shared-provider', name: 'shared', executeAttempt: async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 15)); active--; return { text: 'ok', toolCalls: [], finishReason: 'stop' } } }]])
    const runtime = new PulseRuntime({ effectExecutor: createModelEffectExecutor({ router: new ModelRouter(registry), providers, maxConcurrentByProvider: { 'shared-provider': 1 }, maxConcurrentByModel: { 'shared-model': 1 } }) })
    const program: LaneProgram = { id: 'provider-slots', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('provider-slots', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('provider-slots', 'finish') } }
    const first = runtime.createAgent('first', program)
    const second = runtime.createAgent('second', program)
    const outcomes = await Promise.all([runtime.start(first.agentId).outcome(), runtime.start(second.agentId).outcome()])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['succeeded', 'succeeded'])
    expect(maximum).toBe(1)
  })

  it('publishes rejected output metadata when every provider candidate violates the schema', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'invalid-model', providerId: 'invalid-provider', tasks: ['plan'], capabilities: { local: true, structuredOutput: true, maxContextTokens: 4096 }, priority: 1 })
    const providers = new Map<string, ProviderAdapter>([['invalid-provider', { id: 'invalid-provider', name: 'invalid', executeAttempt: async () => ({ text: 'not-json', toolCalls: [], finishReason: 'stop' }) }]])
    const runtime = new PulseRuntime({ effectExecutor: createModelEffectExecutor({ router: new ModelRouter(registry), providers }) })
    const program: LaneProgram = { id: 'provider-rejected', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'plan', kind: 'llm', concurrencyClass: 'llm', input: { task: 'plan', request: projection, outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('provider-rejected', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('provider-rejected', 'finish') } }
    const { agentId } = runtime.createAgent('rejected', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect([...runtime.state.results.values()]).toContainEqual(expect.objectContaining({ kind: 'rejected_output', value: 'not-json' }))
    expect(runtime.state.effects.get('effect-1')?.outcome).toMatchObject({ error: { code: 'OUTPUT_SCHEMA_VIOLATION' }, rejectedOutputRefs: [expect.any(String)] })
  })

  it('prepares LLM effects before dispatch without occupying the execution slot', async () => {
    const calls: string[] = []
    let release!: () => void
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1, maxPreparingLLMs: 1, effectExecutor: async (effect) => { calls.push(effect.key); return await new Promise((resolve) => { release = () => resolve({ value: { ok: true } }) }) } })
    const program: LaneProgram = { id: 'preparation', version: '1', step: ({ lane }) => lane.resume.step === 'start' ? { actions: [{ type: 'submit_effects', effects: [{ key: 'llm', kind: 'llm', concurrencyClass: 'llm', input: { request: projection } }] }], next: point('preparation', 'done') } : { actions: [{ type: 'complete', result: { ok: true } }], next: point('preparation', 'done') } }
    const { agentId } = runtime.createAgent('prepare', program)
    runtime.tick()
    expect(calls).toEqual([])
    expect(runtime.state.effects.get('effect-1')?.preparation?.state).toBe('preparing')
    await Promise.resolve()
    expect(calls).toEqual(['llm'])
    release()
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  })
})
