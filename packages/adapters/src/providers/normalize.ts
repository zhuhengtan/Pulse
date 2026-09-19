import type { LLMResult } from '@pulse/runtime'

export function normalizeOpenAIResponse(response: any): LLMResult {
  const message = response?.choices?.[0]?.message ?? {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call: any, index: number) => ({ toolCallId: `pulse-tool-${index + 1}`, name: String(call.function?.name ?? ''), input: parseJson(call.function?.arguments) })) : []
  const finishReason = response?.choices?.[0]?.finish_reason
  return { text: String(message.content ?? ''), toolCalls, finishReason: finishReason === 'tool_calls' ? 'tool_calls' : finishReason === 'length' ? 'length' : 'stop', ...(response?.usage ? { usage: { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens, ...(response.usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens }) } } : {}) }
}
export function normalizeAnthropicResponse(response: any): LLMResult {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const text = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
  const toolCalls = blocks.filter((block: any) => block.type === 'tool_use').map((block: any, index: number) => ({ toolCallId: `pulse-tool-${index + 1}`, name: String(block.name), input: block.input ?? {} }))
  return { text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', ...(response?.usage ? { usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } } : {}) }
}
function parseJson(value: unknown): unknown { if (typeof value !== 'string') return value ?? {}; try { return JSON.parse(value) } catch { return { raw: value } } }
