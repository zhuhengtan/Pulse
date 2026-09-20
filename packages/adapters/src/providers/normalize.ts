import type { LLMResult } from '@pulse/runtime'

export interface ProviderSseEvent { event?: string; data: any }

/** Read provider SSE frames without treating incomplete tool arguments as executable input. */
export async function consumeProviderSse(response: Response): Promise<ProviderSseEvent[]> {
  if (!response.body) throw new Error('PROVIDER_STREAM_BODY_MISSING')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: ProviderSseEvent[] = []
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  const flush = (): void => {
    if (dataLines.length === 0) { eventName = undefined; return }
    const raw = dataLines.join('\n')
    dataLines = []
    const data = raw === '[DONE]' ? raw : (() => { try { return JSON.parse(raw) } catch { return { raw } } })()
    events.push({ ...(eventName === undefined ? {} : { event: eventName }), data })
    eventName = undefined
  }
  const consumeLines = (text: string): void => {
    buffer += text
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) flush()
      else if (line.startsWith(':')) { /* SSE comment */ }
      else if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
      newline = buffer.indexOf('\n')
    }
  }
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    consumeLines(decoder.decode(chunk.value, { stream: true }))
  }
  consumeLines(decoder.decode())
  if (buffer.length > 0 || dataLines.length > 0) flush()
  return events
}

export function normalizeOpenAIResponse(response: any): LLMResult {
  const message = response?.choices?.[0]?.message ?? {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call: any, index: number) => ({ toolCallId: `pulse-tool-${index + 1}`, name: String(call.function?.name ?? ''), input: parseJson(call.function?.arguments) })) : []
  const finishReason = response?.choices?.[0]?.finish_reason
  const refusal = typeof message.refusal === 'string' ? message.refusal : undefined
  const text = String(message.content ?? '')
  const cachedInputTokens = response?.usage?.prompt_tokens_details?.cached_tokens ?? response?.usage?.cache_read_input_tokens
  const inputTokens = response?.usage?.prompt_tokens
  const cost = response?.usage?.cost && typeof response.usage.cost === 'object' ? { amount: Number(response.usage.cost.amount), currency: String(response.usage.cost.currency ?? 'USD'), source: 'reported' as const, ...(response.usage.cost.pricing_version === undefined ? {} : { pricingVersion: String(response.usage.cost.pricing_version) }) } : undefined
  return { text, ...(parseStructured(text) === undefined ? {} : { structured: parseStructured(text) }), toolCalls, ...(refusal === undefined ? {} : { refusal }), finishReason: refusal !== undefined || finishReason === 'refusal' ? 'refusal' : finishReason === 'tool_calls' ? 'tool_calls' : finishReason === 'length' ? 'length' : finishReason === 'error' ? 'error' : 'stop', ...(response?.usage ? { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(response.usage.completion_tokens === undefined ? {} : { outputTokens: response.usage.completion_tokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(inputTokens !== undefined && cachedInputTokens !== undefined ? { uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens) } : {}), ...(cost === undefined ? {} : { cost }) } } : {}) }
}
export function normalizeAnthropicResponse(response: any): LLMResult {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const text = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
  const toolCalls = blocks.filter((block: any) => block.type === 'tool_use').map((block: any, index: number) => ({ toolCallId: `pulse-tool-${index + 1}`, name: String(block.name), input: block.input ?? {} }))
  const refusalBlock = blocks.find((block: any) => block.type === 'refusal' && typeof block.text === 'string')
  const refusal = refusalBlock?.text as string | undefined
  const inputTokens = response?.usage?.input_tokens
  const cachedInputTokens = response?.usage?.cache_read_input_tokens
  const cost = response?.usage?.cost && typeof response.usage.cost === 'object' ? { amount: Number(response.usage.cost.amount), currency: String(response.usage.cost.currency ?? 'USD'), source: 'reported' as const } : undefined
  return { text, ...(parseStructured(text) === undefined ? {} : { structured: parseStructured(text) }), toolCalls, ...(refusal === undefined ? {} : { refusal }), finishReason: refusal !== undefined || response?.stop_reason === 'refusal' ? 'refusal' : toolCalls.length ? 'tool_calls' : 'stop', ...(response?.usage ? { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(response.usage.output_tokens === undefined ? {} : { outputTokens: response.usage.output_tokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(inputTokens !== undefined && cachedInputTokens !== undefined ? { uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens) } : {}), ...(cost === undefined ? {} : { cost }) } } : {}) }
}
function parseJson(value: unknown): unknown { if (typeof value !== 'string') return value ?? {}; try { return JSON.parse(value) } catch { return { raw: value } } }
function parseStructured(value: string): unknown | undefined { if (!value.trim()) return undefined; try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === 'object' ? parsed : undefined } catch { return undefined } }
