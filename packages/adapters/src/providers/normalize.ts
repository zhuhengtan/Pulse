import type { LLMResult } from '@pulse/runtime'

export interface ProviderSseEvent { event?: string; data: any }

export function providerHttpError(status: number): Error & { code: string; retryable: boolean } {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500
  return Object.assign(new Error(`PROVIDER_HTTP_${status}`), { code: `PROVIDER_HTTP_${status}`, retryable })
}

export function providerNetworkError(cause: unknown): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error('PROVIDER_NETWORK_ERROR'), { code: 'PROVIDER_NETWORK_ERROR', retryable: true, cause })
}

export function providerResponseError(detail: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(`PROVIDER_RESPONSE_INVALID: ${detail}`), { code: 'PROVIDER_RESPONSE_INVALID', retryable: true })
}

export async function parseProviderJson(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch { throw providerResponseError('PROVIDER_RESPONSE_INVALID_JSON') }
}

/** Read provider SSE frames without treating incomplete tool arguments as executable input. */
export async function consumeProviderSse(response: Response): Promise<ProviderSseEvent[]> {
  if (!response.body) throw providerResponseError('PROVIDER_STREAM_BODY_MISSING')
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
    const data = raw === '[DONE]' ? raw : (() => { try { return JSON.parse(raw) } catch { throw providerResponseError('PROVIDER_STREAM_INVALID_JSON') } })()
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
  const root = providerRecord(response, 'OpenAI response')
  if (!Array.isArray(root.choices) || root.choices.length === 0) throw providerResponseError('OpenAI response must contain at least one choice')
  const choice = providerRecord(root.choices[0], 'OpenAI choice')
  const message = providerRecord(choice.message, 'OpenAI message')
  const toolCalls = message.tool_calls === undefined ? [] : normalizeOpenAIToolCalls(message.tool_calls)
  const refusal = message.refusal === undefined ? undefined : requiredProviderString(message.refusal, 'OpenAI refusal')
  const text = providerText(message.content, 'OpenAI message content')
  const finishReason = normalizeOpenAIFinishReason(choice.finish_reason, refusal, toolCalls.length > 0)
  const rawUsage = root.usage === undefined ? undefined : providerRecord(root.usage, 'OpenAI usage')
  const promptDetails = rawUsage?.prompt_tokens_details === undefined ? undefined : providerRecord(rawUsage.prompt_tokens_details, 'OpenAI prompt token details')
  const usage = normalizeUsage(rawUsage === undefined ? undefined : { ...rawUsage, cached_tokens: rawUsage.cached_tokens ?? promptDetails?.cached_tokens ?? rawUsage.cache_read_input_tokens }, { input: 'prompt_tokens', output: 'completion_tokens', cached: 'cached_tokens' }, 'OpenAI')
  return { text, ...(parseStructured(text) === undefined ? {} : { structured: parseStructured(text) }), toolCalls, ...(refusal === undefined ? {} : { refusal }), finishReason, ...(usage === undefined ? {} : { usage }) }
}
export function normalizeAnthropicResponse(response: any): LLMResult {
  const root = providerRecord(response, 'Anthropic response')
  if (!Array.isArray(root.content)) throw providerResponseError('Anthropic response content must be an array')
  const blocks = root.content
  const text = blocks.filter((block: any) => providerRecord(block, 'Anthropic content block').type === 'text').map((block: any) => requiredProviderString(providerRecord(block, 'Anthropic text block').text, 'Anthropic text block text')).join('')
  const toolBlocks = blocks.filter((block: any) => providerRecord(block, 'Anthropic content block').type === 'tool_use')
  const toolCalls = toolBlocks.map((block: any, index: number) => {
    const value = providerRecord(block, 'Anthropic tool block')
    return { toolCallId: `pulse-tool-${index + 1}`, name: requiredProviderString(value.name, 'Anthropic tool name'), input: parseJson(value.input) }
  })
  const refusalBlock = blocks.find((block: any) => block.type === 'refusal' && typeof block.text === 'string')
  const refusal = refusalBlock?.text as string | undefined
  const finishReason = normalizeAnthropicFinishReason(root.stop_reason, refusal, toolCalls.length > 0)
  const usage = normalizeUsage(root.usage, { input: 'input_tokens', output: 'output_tokens', cached: 'cache_read_input_tokens' }, 'Anthropic')
  return { text, ...(parseStructured(text) === undefined ? {} : { structured: parseStructured(text) }), toolCalls, ...(refusal === undefined ? {} : { refusal }), finishReason, ...(usage === undefined ? {} : { usage }) }
}
function providerRecord(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerResponseError(`${label} must be an object`)
  return value as Record<string, any>
}

function requiredProviderString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw providerResponseError(`${label} must be a non-empty string`)
  return value
}

function providerText(value: unknown, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    const item = part as Record<string, unknown>
    return item.type === 'text' && typeof item.text === 'string'
  })) return value.map((part) => (part as Record<string, string>).text).join('')
  throw providerResponseError(`${label} must be a string, null, or text-part array`)
}

function providerMetric(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || !Number.isFinite(value) || (value as number) < 0) throw providerResponseError(`${label} must be a non-negative integer`)
  return value as number
}

function normalizeUsage(raw: unknown, fields: { input: string; output: string; cached: string }, provider: string): NonNullable<LLMResult['usage']> | undefined {
  if (raw === undefined) return undefined
  const value = providerRecord(raw, `${provider} usage`)
  const inputTokens = providerMetric(value[fields.input], `${provider} input tokens`)
  const outputTokens = providerMetric(value[fields.output], `${provider} output tokens`)
  const cachedInputTokens = providerMetric(value[fields.cached], `${provider} cached input tokens`)
  if (inputTokens !== undefined && cachedInputTokens !== undefined && cachedInputTokens > inputTokens) throw providerResponseError(`${provider} cached input tokens exceed input tokens`)
  const cost = value.cost === undefined ? undefined : normalizeCost(value.cost, provider)
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(inputTokens !== undefined && cachedInputTokens !== undefined ? { uncachedInputTokens: inputTokens - cachedInputTokens } : {}), ...(cost === undefined ? {} : { cost }) }
}

function normalizeCost(raw: unknown, provider: string): NonNullable<LLMResult['usage']>['cost'] {
  const value = providerRecord(raw, `${provider} cost`)
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0) throw providerResponseError(`${provider} cost amount must be a non-negative number`)
  if (typeof value.currency !== 'string' || value.currency.length === 0) throw providerResponseError(`${provider} cost currency must be a non-empty string`)
  if (value.pricing_version !== undefined && typeof value.pricing_version !== 'string') throw providerResponseError(`${provider} pricing version must be a string`)
  return { amount: value.amount, currency: value.currency, source: 'reported', ...(value.pricing_version === undefined ? {} : { pricingVersion: value.pricing_version }) }
}

function normalizeOpenAIToolCalls(raw: unknown): Array<{ toolCallId: string; name: string; input: unknown }> {
  if (!Array.isArray(raw)) throw providerResponseError('OpenAI tool_calls must be an array')
  return raw.map((call: unknown, index: number) => {
    const value = providerRecord(call, 'OpenAI tool call')
    const fn = providerRecord(value.function, 'OpenAI tool function')
    return { toolCallId: `pulse-tool-${index + 1}`, name: requiredProviderString(fn.name, 'OpenAI tool name'), input: parseJson(fn.arguments) }
  })
}

function normalizeOpenAIFinishReason(raw: unknown, refusal: string | undefined, hasTools: boolean): LLMResult['finishReason'] {
  if (refusal !== undefined || raw === 'refusal') return 'refusal'
  if (raw === undefined) return hasTools ? 'tool_calls' : 'stop'
  if (raw === 'tool_calls') { if (!hasTools) throw providerResponseError('tool_calls finish reason requires tool calls'); return 'tool_calls' }
  if (raw === 'stop') { if (hasTools) throw providerResponseError('stop finish reason cannot contain tool calls'); return 'stop' }
  if (raw === 'length') { if (hasTools) throw providerResponseError('length finish reason cannot contain tool calls'); return 'length' }
  if (raw === 'error' || raw === 'content_filter') { if (hasTools) throw providerResponseError('error finish reason cannot contain tool calls'); return 'error' }
  throw providerResponseError(`unsupported OpenAI finish reason: ${String(raw)}`)
}

function normalizeAnthropicFinishReason(raw: unknown, refusal: string | undefined, hasTools: boolean): LLMResult['finishReason'] {
  if (refusal !== undefined || raw === 'refusal') return 'refusal'
  if (raw === undefined) return hasTools ? 'tool_calls' : 'stop'
  if (raw === 'tool_use') { if (!hasTools) throw providerResponseError('tool_use stop reason requires tool calls'); return 'tool_calls' }
  if (raw === 'max_tokens') { if (hasTools) throw providerResponseError('max_tokens stop reason cannot contain tool calls'); return 'length' }
  if (raw === 'end_turn' || raw === 'stop_sequence') { if (hasTools) throw providerResponseError('text stop reason cannot contain tool calls'); return 'stop' }
  throw providerResponseError(`unsupported Anthropic stop reason: ${String(raw)}`)
}

function parseJson(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { throw providerResponseError('INVALID_TOOL_ARGUMENTS') }
}
function parseStructured(value: string): unknown | undefined { if (!value.trim()) return undefined; try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === 'object' ? parsed : undefined } catch { return undefined } }
