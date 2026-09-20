import { describe, expect, it } from 'vitest'
import { createModelEffectExecutor, type ProviderAdapter } from '@pulse/adapters'
import { AdaptiveModelRouter, InMemoryModelRegistry, type EffectRecord, type LLMRequestProjection } from '@pulse/runtime'

const projection: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'default', instruction: 'reason', privacy: 'public', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'reason' }], prefixHash: 'prefix', projectionHash: 'projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'default', privacy: 'public', privacyRefs: [] }

describe('adaptive model routing', () => {
  it('ranks candidates from quality, latency, cost, cache, and exploration feedback', () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'slow-expensive', providerId: 'p1', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 20 })
    registry.register({ id: 'fast-cheap', providerId: 'p2', tasks: ['reason'], capabilities: { maxContextTokens: 4096 }, priority: 1 })
    const router = new AdaptiveModelRouter(registry, { priorityWeight: 0.01, qualityWeight: 5, latencyWeight: 2, costWeight: 2, cacheWeight: 2, explorationWeight: 0 })
    router.recordFeedback({ modelId: 'slow-expensive', outcome: 'failed', quality: 0.2, usage: { latencyMs: 2_000, inputTokens: 100, cachedInputTokens: 0, cost: { amount: 10, currency: 'USD', source: 'reported' } } })
    router.recordFeedback({ modelId: 'fast-cheap', outcome: 'succeeded', quality: 0.9, usage: { latencyMs: 20, inputTokens: 100, cachedInputTokens: 80, cost: { amount: 0.01, currency: 'USD', source: 'reported' } } })

    expect(router.route('reason', 'public').map((candidate) => candidate.id)).toEqual(['fast-cheap', 'slow-expensive'])
    expect(router.metrics().get('fast-cheap')).toMatchObject({ attempts: 1, successes: 1, failures: 0, cachedInputTokens: 80, inputTokens: 100 })
  })

  it('records provider attempt feedback through the standard executor', async () => {
    const registry = new InMemoryModelRegistry()
    registry.register({ id: 'feedback-model', providerId: 'feedback-provider', tasks: ['reason'], capabilities: { local: true, maxContextTokens: 4096 }, priority: 1 })
    const provider: ProviderAdapter = { id: 'feedback-provider', name: 'feedback', executeAttempt: async () => ({ text: 'ok', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, latencyMs: 3, cost: { amount: 0.02, currency: 'USD', source: 'reported' } } }) }
    const router = new AdaptiveModelRouter(registry)
    const executor = createModelEffectExecutor({ router, providers: new Map([[provider.id, provider]]) })
    const effect = { id: 'effect-1', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'reason', kind: 'llm', concurrencyClass: 'llm', input: { task: 'reason', request: projection }, attemptId: 'effect-1-attempt-1', attemptNo: 1, state: 'running', executionState: 'running', sideEffectState: 'none' } as unknown as EffectRecord

    await expect(executor(effect, new AbortController().signal)).resolves.toMatchObject({ executionState: 'succeeded' })
    expect(router.metrics().get('feedback-model')).toMatchObject({ attempts: 1, successes: 1, qualityTotal: 1, latencyTotalMs: 3, costTotal: 0.02, cachedInputTokens: 4, inputTokens: 10 })
  })
})
