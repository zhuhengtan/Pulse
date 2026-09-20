import { describe, expect, it } from 'vitest'
import { OpenAICompatibleAdapter } from '@pulse/adapters'
import type { LLMRequestProjection } from '@pulse/runtime'

const apiKey = process.env.OPENAI_API_KEY

describe.skipIf(!apiKey)('live OpenAI-compatible adapter', () => {
  it('performs one minimal request and normalizes the response', async () => {
    const adapter = new OpenAICompatibleAdapter('openai-live', {
      provider: 'openai',
      apiKey,
      defaultModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      baseURL: process.env.OPENAI_BASE_URL,
      maxOutputTokens: 16,
    })
    const request: LLMRequestProjection = {
      contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'live-smoke', instruction: 'Reply with exactly the word OK.', privacy: 'public', privacyRefs: [] },
      blocks: [{ kind: 'system', content: 'You are a live adapter smoke-test.' }, { kind: 'instruction', content: 'Reply with exactly the word OK.' }],
      prefixHash: 'live-prefix',
      projectionHash: 'live-projection',
      builderVersion: '1',
      policyVersion: '1',
      toolSetVersion: 'live-smoke',
      privacy: 'public',
      privacyRefs: [],
    }
    const result = await adapter.executeAttempt({ request, signal: new AbortController().signal })
    expect(result.text.length).toBeGreaterThan(0)
    expect(['stop', 'length', 'tool_calls']).toContain(result.finishReason)
  }, 30_000)
})
