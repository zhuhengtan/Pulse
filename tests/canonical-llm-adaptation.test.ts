import { describe, expect, it, vi } from 'vitest'
import type { LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import {
  adaptCanonicalRequest,
  capabilityRegistry,
  DynamicCapabilityProbe,
  lowerProjectionToCanonical,
  OpenAICompatibleAdapter,
  parseAnthropicSseEvents,
  parseOpenAISseEvents,
  resolveModelCapability,
  toAnthropicPayload,
  toOpenAIPayload,
} from '@hunterzhu/pulse-adapters'

describe('Canonical LLM Adaptation Layer', () => {
  const dummyProjection: LLMRequestProjection = {
    contextSpec: {
      globalSnapshotVersion: 0,
      laneSnapshotVersion: 0,
      resultRefs: [],
      eventIds: [],
      toolSetId: 'tools@1',
      instruction: 'Run analysis',
      privacy: 'public',
      privacyRefs: [],
    },
    blocks: [
      { kind: 'system', content: 'You are an AI assistant.' },
      {
        kind: 'tools',
        content: [
          {
            name: 'calculate/sum',
            description: 'Sum numbers',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          },
        ],
      },
      {
        kind: 'conversation',
        content: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      },
      { kind: 'instruction', content: 'Run analysis' },
    ],
    prefixHash: 'prefix-1',
    projectionHash: 'projection-1',
    builderVersion: '1',
    policyVersion: '1',
    toolSetVersion: 'tools@1',
    privacy: 'public',
    privacyRefs: [],
  }

  const sampleSchema = {
    type: 'object',
    properties: { score: { type: 'number' }, summary: { type: 'string' } },
    required: ['score', 'summary'],
  }

  describe('Canonical Lowering', () => {
    it('lowers LLMRequestProjection to a normalized CanonicalLLMRequest', () => {
      const { canonical, toolNameAliases } = lowerProjectionToCanonical({
        request: dummyProjection,
        model: 'gpt-4o',
        outputSchema: sampleSchema,
        maxOutputTokens: 2048,
        reasoningEffort: 'medium',
        toolChoice: 'auto',
      })

      expect(canonical.model).toBe('gpt-4o')
      expect(canonical.maxTokens).toBe(2048)
      expect(canonical.reasoning?.effort).toBe('medium')
      expect(canonical.toolChoice).toBe('auto')
      expect(canonical.structuredOutput?.mode).toBe('json_schema')
      expect(canonical.structuredOutput?.schema).toEqual(sampleSchema)

      // Tools should be sanitized and aliases mapped
      expect(canonical.tools).toHaveLength(1)
      expect(canonical.tools![0].name).toBe('calculate_sum')
      expect(toolNameAliases.get('calculate_sum')).toBe('calculate/sum')

      // Messages check
      expect(canonical.messages[0]).toEqual({ role: 'system', content: 'You are an AI assistant.' })
      expect(canonical.messages.some((m) => m.role === 'user' && m.name === 'instruction')).toBe(true)
    })
  })

  describe('Capability Resolver', () => {
    it('resolves OpenAI o1/o3 reasoning model capability profiles', () => {
      const o1Profile = resolveModelCapability('o1-mini', 'openai')
      expect(o1Profile.reasoning).toBe('effort_param')
      expect(o1Profile.constraints.disallowTemperatureWithReasoning).toBe(true)
      expect(o1Profile.constraints.maxTokensParamName).toBe('max_completion_tokens')
      expect(o1Profile.structuredOutput).toBe('native_strict')

      const o3Profile = resolveModelCapability('o3-mini', 'openai')
      expect(o3Profile.reasoning).toBe('effort_param')
      expect(o3Profile.constraints.maxTokensParamName).toBe('max_completion_tokens')
    })

    it('resolves Anthropic Claude 3.7 thinking profile', () => {
      const claudeProfile = resolveModelCapability('claude-3-7-sonnet-20250219', 'anthropic')
      expect(claudeProfile.reasoning).toBe('budget_tokens')
      expect(claudeProfile.constraints.disallowTemperatureWithReasoning).toBe(true)
      expect(claudeProfile.constraints.defaultTemperatureWithReasoning).toBe(1.0)
    })

    it('resolves DeepSeek model capability profile', () => {
      const deepseekProfile = resolveModelCapability('deepseek-chat', 'deepseek')
      expect(deepseekProfile.structuredOutput).toBe('json_object_only')
      expect(deepseekProfile.reasoning).toBe('effort_param')
    })

    it('keeps json_schema for a deepseek model name on a non-DeepSeek protocol', () => {
      const profile = resolveModelCapability('deepseek-chat', 'openai-compatible')
      expect(profile.provider).toBe('openai-compatible')
      expect(profile.structuredOutput).toBe('native_strict')
      expect(profile.reasoning).toBe('effort_param')
    })

    it('sends reasoning_effort for OpenAI models that are not o1 or o3', () => {
      const gpt = resolveModelCapability('gpt-5.6', 'openai')
      expect(gpt.reasoning).toBe('effort_param')
      expect(gpt.constraints.maxTokensParamName).toBe('max_tokens')
      const o10 = resolveModelCapability('o10', 'openai')
      expect(o10.constraints.maxTokensParamName).toBe('max_tokens')
    })

    it('uses max_completion_tokens for o-series models on the OpenAI-compatible protocol', () => {
      const profile = resolveModelCapability('o3-mini', 'openai-compatible')
      expect(profile.provider).toBe('openai-compatible')
      expect(profile.reasoning).toBe('effort_param')
      expect(profile.constraints.maxTokensParamName).toBe('max_completion_tokens')
      expect(profile.constraints.disallowTemperatureWithReasoning).toBe(true)
    })

    it('matches a custom model-family prefix and ignores an interior substring', () => {
      capabilityRegistry.registerProfile('my-custom', { structuredOutput: 'json_object_only' })
      capabilityRegistry.registerProfile('my-custom-llm', {
        structuredOutput: 'unsupported',
        reasoning: 'unsupported',
        constraints: { maxTokensParamName: 'max_tokens' },
      })
      try {
        const customProfile = resolveModelCapability('my-custom-llm-v1', 'openai-compatible')
        expect(customProfile.structuredOutput).toBe('unsupported')
        expect(customProfile.reasoning).toBe('unsupported')
        expect(resolveModelCapability('vendor-my-custom-llm', 'openai-compatible').structuredOutput).toBe('native_strict')
      } finally {
        capabilityRegistry.unregisterProfile('my-custom')
        capabilityRegistry.unregisterProfile('my-custom-llm')
      }
    })
  })

  describe('Smart Polyfill & Self-Adaptation', () => {
    it('adapts structured output for json_object_only models (e.g. DeepSeek)', () => {
      const { canonical, toolNameAliases } = lowerProjectionToCanonical({
        request: dummyProjection,
        model: 'deepseek-chat',
        outputSchema: sampleSchema,
      })

      const capability = resolveModelCapability('deepseek-chat', 'deepseek')
      const probe = new DynamicCapabilityProbe()
      const { request: adapted, clientSchemaValidationRequired } = adaptCanonicalRequest(
        canonical,
        capability,
        probe,
        toolNameAliases,
      )

      expect(clientSchemaValidationRequired).toBe(true)
      expect(adapted.structuredOutput?.mode).toBe('json_object')
      expect(adapted.messages[0].role).toBe('system')
      expect(adapted.messages[0].content).toContain(JSON.stringify(sampleSchema))
    })

    it('adapts reasoning for OpenAI o-series by stripping temperature and using max_completion_tokens', () => {
      const { canonical, toolNameAliases } = lowerProjectionToCanonical({
        request: dummyProjection,
        model: 'o1',
        reasoningEffort: 'high',
        maxOutputTokens: 4000,
      })
      canonical.temperature = 0.7

      const capability = resolveModelCapability('o1', 'openai')
      const probe = new DynamicCapabilityProbe()
      const { request: adapted } = adaptCanonicalRequest(canonical, capability, probe, toolNameAliases)

      // Temperature must be stripped when reasoning is enabled for o1
      expect(adapted.temperature).toBeUndefined()
      expect(adapted.reasoning?.effort).toBe('high')

      // Payload serializer should output max_completion_tokens instead of max_tokens
      const payload = toOpenAIPayload(adapted, capability, 'openai')
      expect(payload.max_completion_tokens).toBe(4000)
      expect(payload.max_tokens).toBeUndefined()
      expect(payload.reasoning_effort).toBe('high')
      expect(payload.temperature).toBeUndefined()
    })

    it('adapts reasoning for Claude 3.7 thinking by computing budget_tokens and setting temperature to 1.0', () => {
      const { canonical, toolNameAliases } = lowerProjectionToCanonical({
        request: dummyProjection,
        model: 'claude-3-7-sonnet',
        reasoningEffort: 'medium',
        maxOutputTokens: 8192,
      })
      canonical.temperature = 0.5

      const capability = resolveModelCapability('claude-3-7-sonnet', 'anthropic')
      const probe = new DynamicCapabilityProbe()
      const { request: adapted } = adaptCanonicalRequest(canonical, capability, probe, toolNameAliases)

      expect(adapted.reasoning?.budgetTokens).toBe(2048)
      expect(adapted.temperature).toBe(1.0)

      const payload = toAnthropicPayload(adapted, capability)
      expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
      expect(payload.max_tokens).toBe(8192)
      expect(payload.temperature).toBe(1)
    })

    it('handles dynamic probe self-healing when reasoning_effort is rejected with HTTP 400', () => {
      const probe = new DynamicCapabilityProbe()
      const error400 = Object.assign(new Error("PROVIDER_HTTP_400: Unknown parameter: 'reasoning_effort'"), {
        code: 'PROVIDER_HTTP_400',
      })

      expect(probe.reasoningParameterRejected(error400)).toBe(true)

      // Before marking, reasoning is considered supported
      expect(probe.isReasoningUnsupported('custom-provider', 'model-x')).toBe(false)

      probe.markReasoningUnsupported('custom-provider', 'model-x')
      expect(probe.isReasoningUnsupported('custom-provider', 'model-x')).toBe(true)
      expect(probe.isReasoningUnsupported('custom-provider', 'model-y')).toBe(false)
      probe.markReasoningUnsupported('custom-provider')
      expect(probe.isReasoningUnsupported('custom-provider')).toBe(true)
      expect(probe.isReasoningUnsupported('custom-provider', 'model-y')).toBe(false)
      expect(probe.reasoningParameterRejected(Object.assign(new Error("PROVIDER_HTTP_400: Unknown parameter: 'max_completion_tokens'"), { code: 'PROVIDER_HTTP_400' }))).toBe(false)

      // Next adaptation should strip reasoning
      const { canonical, toolNameAliases } = lowerProjectionToCanonical({
        request: dummyProjection,
        model: 'model-x',
        reasoningEffort: 'low',
      })
      const capability = resolveModelCapability('model-x', 'custom-provider')
      const { request: adapted } = adaptCanonicalRequest(canonical, capability, probe, toolNameAliases)

      expect(adapted.reasoning).toBeUndefined()
    })
  })

  describe('Streaming Events Normalization', () => {
    it('normalizes OpenAI SSE delta chunks into CanonicalStreamEvent', () => {
      const openAiChunk = {
        choices: [
          {
            delta: {
              content: 'Hello, ',
              reasoning_content: 'Let me think about it.',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'calculate_sum', arguments: '{"a": 1' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 25 },
      }

      const events = parseOpenAISseEvents(openAiChunk)
      expect(events).toContainEqual({ type: 'text_delta', text: 'Hello, ' })
      expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Let me think about it.' })
      expect(events).toContainEqual({
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'calculate_sum',
        argumentsDelta: '{"a": 1',
      })
      expect(events).toContainEqual({
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 25 },
      })
    })

    it('normalizes Anthropic SSE events into CanonicalStreamEvent', () => {
      const textEvent = parseAnthropicSseEvents({
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: 'Anthropic says hello' } },
      })
      expect(textEvent).toEqual([{ type: 'text_delta', text: 'Anthropic says hello' }])

      const thinkingEvent = parseAnthropicSseEvents({
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'thinking_delta', thinking: 'Analyzing query...' } },
      })
      expect(thinkingEvent).toEqual([{ type: 'reasoning_delta', text: 'Analyzing query...' }])

      const toolEvent = parseAnthropicSseEvents({
        event: 'content_block_delta',
        data: { index: 1, delta: { type: 'input_json_delta', partial_json: ',"b":2}' } },
      })
      expect(toolEvent).toEqual([{ type: 'tool_call_delta', index: 1, argumentsDelta: ',"b":2}' }])

      const finishEvent = parseAnthropicSseEvents({
        event: 'message_delta',
        data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
      })
      expect(finishEvent).toContainEqual({ type: 'finish', reason: 'end_turn' })
      expect(finishEvent).toContainEqual({ type: 'usage', usage: { outputTokens: 42 } })
    })
  })

  describe('Provider request bodies', () => {
    const historyProjection: LLMRequestProjection = {
      ...dummyProjection,
      contextSpec: {
        ...dummyProjection.contextSpec,
        providerHistory: [
          { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
          { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: '{"content":"file"}', resultRef: 'tool-result' },
        ],
      },
      blocks: [
        { kind: 'provider_history', content: [] },
        { kind: 'instruction', content: 'continue' },
      ],
    }

    it('maps Anthropic tool calls and tool results without turning null content into text', () => {
      const { canonical } = lowerProjectionToCanonical({ request: historyProjection, model: 'claude-sonnet-4' })
      const payload = toAnthropicPayload(canonical, resolveModelCapability('claude-sonnet-4', 'anthropic'))
      const blocks = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>).flatMap((message) => message.content)
      expect(blocks).toContainEqual({ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } })
      expect(blocks).toContainEqual({ type: 'tool_result', tool_use_id: 'call_1', content: '{"content":"file"}' })
      expect(blocks).not.toContainEqual({ type: 'text', text: 'null' })
    })

    it('sends reasoning_effort for gpt-5.6 and only suppresses the rejected model', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'", type: 'invalid_request_error', param: 'reasoning_effort' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        const adapter = new OpenAICompatibleAdapter('openai', { provider: 'openai', reasoningEffort: 'high', defaultModel: 'gpt-5.6' })
        await adapter.executeAttempt({ request: dummyProjection, signal: new AbortController().signal })
        const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
        expect(first.model).toBe('gpt-5.6')
        expect(first.reasoning_effort).toBe('high')
        expect(first.max_completion_tokens).toBeUndefined()
        expect(second.reasoning_effort).toBeUndefined()

        await adapter.executeAttempt({ request: dummyProjection, signal: new AbortController().signal, model: 'gpt-4.1' })
        const third = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
        expect(third.model).toBe('gpt-4.1')
        expect(third.reasoning_effort).toBe('high')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('does not retry when a different parameter is rejected', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Unknown parameter: 'max_completion_tokens'", type: 'invalid_request_error', param: 'max_completion_tokens' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        const adapter = new OpenAICompatibleAdapter('openai-compatible', { provider: 'openai-compatible', reasoningEffort: 'low', defaultModel: 'o1' })
        await expect(adapter.executeAttempt({ request: dummyProjection, signal: new AbortController().signal, maxOutputTokens: 128 })).rejects.toMatchObject({ code: 'PROVIDER_HTTP_400' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        expect(body.max_completion_tokens).toBe(128)
        expect(body.reasoning_effort).toBe('low')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('keeps strict json_schema when the model name contains deepseek', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        await new OpenAICompatibleAdapter('compatible', { provider: 'openai-compatible', defaultModel: 'deepseek-chat' }).executeAttempt({
          request: dummyProjection,
          signal: new AbortController().signal,
          outputSchema: sampleSchema,
        })
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        expect(body.response_format.type).toBe('json_schema')
        expect(body.messages[0].content).not.toContain(JSON.stringify(sampleSchema))
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('sends provider tool history through the OpenAI adapter', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        await new OpenAICompatibleAdapter('openai', { provider: 'openai', defaultModel: 'gpt-4.1' }).executeAttempt({ request: historyProjection, signal: new AbortController().signal })
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        expect(body.messages).toContainEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] })
        expect(body.messages).toContainEqual({ role: 'tool', content: '{"content":"file"}', name: 'read_file', tool_call_id: 'call_1' })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
