import { describe, expect, it, vi } from 'vitest'
import { MockAdapter } from '../packages/adapters/src/providers/mock.js'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'

describe('host model routing', () => {
  it('uses the active model by default and translates display names to provider codes', async () => {
    const mock = new MockAdapter('mock')
    const executeAttempt = vi.spyOn(mock, 'executeAttempt').mockResolvedValue({ text: 'ok', toolCalls: [], finishReason: 'stop' })
    const routing = createHostModelRouting({
      activeModel: 'Quick',
      activeProviderCode: 'local',
      activeProvider: { provider: 'mock', defaultModel: 'mock-code' },
      providerProfiles: { local: { provider: 'mock', defaultModel: 'mock-code' } },
      providerModels: {
        Quick: { provider: 'local', model: 'mock-code' },
        Deep: { provider: 'local', model: 'deep-code' },
      },
      activeAdapter: mock,
    })

    expect(routing.router.route('reason', 'cloud_allowed').map((model) => model.id)).toEqual(['Quick'])
    const adapter = routing.providers.get('local')!
    await adapter.executeAttempt({ request: {} as never, signal: new AbortController().signal, model: 'Deep' })
    expect(executeAttempt).toHaveBeenCalledWith(expect.objectContaining({ model: 'deep-code' }))
  })

  it('uses per-task fallback order and rejects missing route candidates', () => {
    const routing = createHostModelRouting({
      activeModel: 'Quick',
      activeProviderCode: 'local',
      activeProvider: { provider: 'mock', defaultModel: 'quick-code' },
      providerProfiles: {
        local: { provider: 'mock', defaultModel: 'quick-code' },
        cloud: { provider: 'openai-compatible', baseURL: 'https://example.invalid/v1', defaultModel: 'accurate-code' },
      },
      providerModels: {
        Quick: { provider: 'local', model: 'quick-code', maxContextTokens: 4_096 },
        Accurate: { provider: 'cloud', model: 'accurate-code', maxContextTokens: 128_000, maxOutputTokens: 16_000, reasoningEffort: 'high' },
      },
      taskRouting: { verify: ['Accurate', 'Quick'] },
    })
    expect(routing.router.route('verify', 'cloud_allowed').map((model) => model.id)).toEqual(['Accurate', 'Quick'])
    expect(routing.candidates.find((candidate) => candidate.id === 'Accurate')?.capabilities).toMatchObject({ maxContextTokens: 128_000, maxOutputTokens: 16_000, reasoning: 'high' })

    expect(() => createHostModelRouting({
      activeModel: 'Quick',
      activeProvider: { provider: 'mock', defaultModel: 'quick-code' },
      taskRouting: { verify: ['missing'] },
    })).toThrow('UNKNOWN_MODEL_ROUTE_CANDIDATE:verify:missing')
  })

  it('fails closed when an explicitly configured task route is empty', () => {
    expect(() => createHostModelRouting({
      activeModel: 'mock',
      activeProvider: { provider: 'mock', defaultModel: 'mock' },
      taskRouting: { plan: [] },
    })).toThrow('EMPTY_MODEL_ROUTE:plan')
  })
})
