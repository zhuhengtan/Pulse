import { describe, expect, it } from 'vitest'
import { OpenAICompatibleAdapter } from '@pulse/adapters'
import type { LLMRequestProjection } from '@pulse/runtime'

const apiKey = process.env.OPENAI_API_KEY
const toolSmoke = process.env.PULSE_LIVE_TOOL_SMOKE === '1'

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

  it.skipIf(!toolSmoke)('forces and normalizes a real tool call', async () => {
    const adapter = new OpenAICompatibleAdapter('openai-live-tool', {
      provider: 'openai',
      apiKey,
      defaultModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      baseURL: process.env.OPENAI_BASE_URL,
      maxOutputTokens: 64,
      toolChoice: 'required',
    })
    const request: LLMRequestProjection = {
      contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'live-tool-smoke', instruction: 'Call report_status with ok=true.', privacy: 'public', privacyRefs: [] },
      blocks: [
        { kind: 'system', content: 'You are a live adapter tool-call smoke-test.' },
        { kind: 'tools', content: [{ name: 'report_status', description: 'Report a status value.', inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }] },
        { kind: 'instruction', content: 'Call report_status with ok=true.' },
      ],
      prefixHash: 'live-tool-prefix', projectionHash: 'live-tool-projection', builderVersion: '1', policyVersion: '1', toolSetVersion: 'live-tool-smoke', privacy: 'public', privacyRefs: [],
    }
    const result = await adapter.executeAttempt({ request, signal: new AbortController().signal })
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([expect.objectContaining({ name: 'report_status', input: { ok: true } })])
  }, 30_000)
})
