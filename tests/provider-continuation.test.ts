import { afterEach, expect, it, vi } from 'vitest'
import { AnthropicAdapter, OpenAICompatibleAdapter, normalizeAnthropicResponse, normalizeOpenAIResponse, toOpenAIMessages } from '@hunterzhu/pulse-adapters'
import { appendHistory, ContextBuilder, createAgent, createRuntimeState, type JsonValue, type LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import { lowerProjectionToCanonical, resolveModelCapability, toAnthropicPayload } from '../packages/adapters/src/providers/canonical/index.js'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'

afterEach(() => vi.restoreAllMocks())
function projection(provider: string, continuation: any): LLMRequestProjection {
  const state = createRuntimeState(), { agent, root } = createAgent(state, 'goal', { programId: 'test', programVersion: '1', step: 'start', locals: {} })
  state.results.set('result', { id: 'result', value: { value: 'OK' }, privacy: 'public', derivedFrom: [], producer: { kind: 'effect', id: 'tool-effect' } })
  root.visibleResultRefs!.add('result')
  state.toolCallCorrelations.set('runtime-call', { toolCallId: 'runtime-call', llmEffectId: 'llm-effect', toolEffectId: 'tool-effect', resultRef: 'result' })
  const history = appendHistory(root, { instruction: 'Use echo', resultRefs: ['result'], output: { text: 'visible', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'runtime-call', providerToolCallId: 'native-call', providerToolName: 'echo', providerToolArguments: '{"value":"OK"}', name: 'echo', input: { value: 'OK' } }], providerContinuation: { provider, ...continuation } } as JsonValue, privacy: 'public' })
  return new ContextBuilder(state).build({ agent, lane: history, resultRefs: ['result'], instruction: 'continue', toolSetId: 'tools@1' })
}
const message = (content: unknown, extra: any = {}) => ({ choices: [{ message: { content, tool_calls: [{ id: 'native-call', type: 'function', function: { name: 'echo', arguments: '{"value":"OK"}' }, ...extra }] }, finish_reason: 'tool_calls' }] })

it('round-trips MiniMax hidden think content and separate reasoning through runtime history without rendering either in general history', () => {
  const raw = message('<think>private chain</think>visible'); raw.choices[0]!.message = { ...raw.choices[0]!.message, reasoning_content: 'private continuation' } as any
  const result = normalizeOpenAIResponse(raw, undefined, 'minimax')
  expect(result.text).toBe('visible')
  const request = projection('minimax', result.providerContinuation)
  const native = toOpenAIMessages(request, 'minimax').find(item => item.role === 'assistant')
  expect(native).toMatchObject({ content: '<think>private chain</think>visible', reasoning_content: 'private continuation' })
  const visible = JSON.stringify(request.blocks.filter(item => item.kind !== 'provider_history'))
  expect(visible).not.toContain('private chain'); expect(visible).not.toContain('private continuation')
  expect(toOpenAIMessages(request, 'openai').find(item => item.role === 'assistant')).not.toHaveProperty('reasoning_content')
  expect(toOpenAIMessages(request, 'openai').find(item => item.role === 'assistant')?.content).toBe('visible')
})
it('round-trips Gemini tool thought signatures and OpenRouter reasoning details only to the original service', () => {
  const result = normalizeOpenAIResponse(message('', { extra_content: { google: { thought_signature: 'opaque-signature' } } }), undefined, 'gemini')
  const request = projection('gemini', result.providerContinuation)
  expect(toOpenAIMessages(request, 'gemini').find(item => item.role === 'assistant')?.tool_calls).toEqual([expect.objectContaining({ extra_content: { google: { thought_signature: 'opaque-signature' } } })])
  expect(JSON.stringify(toOpenAIMessages(request, 'openai'))).not.toContain('opaque-signature')
  const router = projection('openrouter', { metadata: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-encrypted' }] } })
  expect(toOpenAIMessages(router, 'openrouter').find(item => item.role === 'assistant')).toHaveProperty('reasoning_details', [{ type: 'reasoning.encrypted', data: 'opaque-encrypted' }])
  expect(JSON.stringify(toOpenAIMessages(router, 'minimax'))).not.toContain('opaque-encrypted')
})
it('preserves thinking signatures in Anthropic history and omits them when converting to OpenAI', () => {
  const result = normalizeAnthropicResponse({ content: [{ type: 'thinking', thinking: 'private thought', signature: 'native-signature' }, { type: 'tool_use', id: 'native-call', name: 'echo', input: { value: 'OK' } }], stop_reason: 'tool_use' })
  const request = projection('anthropic', result.providerContinuation)
  const payload = toAnthropicPayload(lowerProjectionToCanonical({ request }).canonical, resolveModelCapability('claude', 'anthropic'))
  expect(JSON.stringify(payload)).toContain('native-signature')
  expect(JSON.stringify(toOpenAIMessages(request, 'openai'))).not.toContain('native-signature')
})
it('accumulates Gemini tool signatures and reasoning details from streamed chunks', async () => {
  const stream = [
    { choices: [{ delta: { reasoning_content: 'private reasoning', reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }], tool_calls: [{ index: 0, id: 'native-call', function: { name: 'echo', arguments: '{"value":' }, extra_content: { google: { thought_signature: 'streamed-signature' } } }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: '-continued' }], tool_calls: [{ index: 0, function: { arguments: '"OK"}' } }] }, finish_reason: 'tool_calls' }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  const result = await new OpenAICompatibleAdapter('gemini', { provider: 'gemini', defaultModel: 'gemini' }).executeAttempt({ request: projection('gemini', {}), signal: new AbortController().signal, onObservation: () => {} })
  expect(result.providerContinuation).toMatchObject({ reasoningContent: 'private reasoning', metadata: { toolExtras: { 'native-call': { google: { thought_signature: 'streamed-signature' } } }, reasoning_details: [{ data: 'opaque-continued' }] } })
})
it('accumulates Anthropic thinking and signature deltas before the tool call', async () => {
  const stream = [
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'private thought' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'signature' } }],
    ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'native-call', name: 'echo', input: { value: 'OK' } } }],
    ['message_delta', { delta: { stop_reason: 'tool_use' } }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  const result = await new AnthropicAdapter('anthropic', { provider: 'anthropic' }).executeAttempt({ request: projection('anthropic', {}), signal: new AbortController().signal, onObservation: () => {} })
  expect(result.text).toBe('')
  expect(result.providerContinuation).toMatchObject({ metadata: { thinkingBlocks: [{ thinking: 'private thought', signature: 'signature' }] } })
})
it('does not send strict JSON or unsupported reasoning controls to generic upstream vendors', () => {
  expect(resolveModelCapability('any-model', 'openrouter')).toMatchObject({ structuredOutput: 'unsupported', reasoning: 'unsupported' })
  expect(resolveModelCapability('glm', 'zhipu')).toMatchObject({ structuredOutput: 'json_object_only', reasoning: 'unsupported' })
  expect(resolveModelCapability('MiniMax-M3.1-Flash', 'minimax')).toMatchObject({ reasoning: 'effort_param' })
  expect(resolveModelCapability('deepseek-flash', 'deepseek')).toMatchObject({ structuredOutput: 'json_object_only' })
  expect(resolveModelCapability('gpt-6.1-sol', 'openai').constraints.maxTokensParamName).toBe('max_completion_tokens')
  expect(resolveModelCapability('gpt-5-mini', 'openai').constraints.maxTokensParamName).toBe('max_completion_tokens')
  expect(resolveModelCapability('gpt-4o', 'openai').constraints.maxTokensParamName).toBe('max_tokens')
})

it('allows a chat-only model without sending tool definitions, native tool history or unsupported strict JSON controls', async () => {
  let sent: any
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }) })
  const routing = createHostModelRouting({ activeModel: 'account/plain', activeProviderCode: 'account', activeProvider: { provider: 'openai', defaultModel: 'plain' }, providerModels: { 'account/plain': { provider: 'account', model: 'plain', tools: 'unsupported', structuredOutput: 'unsupported' } } })
  const request = projection('minimax', { reasoningContent: 'private-chain' })
  request.blocks.push({ kind: 'tools', content: [{ name: 'echo', inputSchema: { type: 'object' } }] })
  const result = await routing.providers.get('account')!.executeAttempt({ request, model: 'account/plain', outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } }, signal: new AbortController().signal })
  expect(result.text).toBe('{"ok":true}')
  expect(sent.tools).toBeUndefined(); expect(sent.response_format).toBeUndefined()
  expect(sent.messages.some((item: any) => item.role === 'tool')).toBe(false)
  expect(JSON.stringify(sent)).not.toContain('private-chain')
  expect(routing.candidates[0]?.capabilities.toolCalling).toBe(false)
})
