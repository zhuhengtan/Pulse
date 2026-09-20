import { describe, expect, it } from 'vitest'
import { createModelEffectExecutor, type ProviderAdapter } from '@pulse/adapters'
import { ModelRouter, InMemoryModelRegistry, modelFallbackError, estimateProjectionTokens, type LLMRequestProjection } from '@pulse/runtime'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'
import { defineLaneProgram } from '@pulse/runtime'
import { z } from 'zod'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })
const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'local_only', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'local_only', privacyRefs: [] }

describe('Provider Adapter to Runtime LLM Effect host', () => {
  it('filters candidates whose context window cannot fit the immutable projection', () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'too-small', providerId: 'p1', tasks: ['reason'], capabilities: { local: true, maxContextTokens: estimateProjectionTokens(projection) - 1 }, priority: 10 })
    registry.register({ id: 'fits', providerId: 'p2', tasks: ['reason'], capabilities: { local: true, maxContextTokens: estimateProjectionTokens(projection) }, priority: 1 })
    expect(new ModelRouter(registry).routeProjection('reason', projection).map((candidate) => candidate.id)).toEqual(['fits'])
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
})
