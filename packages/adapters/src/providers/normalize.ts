import type { LLMResult } from '@hunterzhu/pulse-runtime'

export interface ProviderSseEvent { event?: string; data: any }

export function providerHttpError(status: number, detail?: string): Error & { code: string; retryable: boolean } {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500
  const suffix = detail === undefined || detail.length === 0 ? '' : `: ${detail}`
  return Object.assign(new Error(`PROVIDER_HTTP_${status}${suffix}`), { code: `PROVIDER_HTTP_${status}`, retryable })
}

/** Preserve the provider's actionable error message without copying arbitrary response bodies into logs. */
export async function providerHttpErrorFromResponse(response: Response): Promise<Error & { code: string; retryable: boolean }> {
  let raw = ''
  try { raw = typeof response.text === 'function' ? await response.text() : '' } catch { /* keep the status-only error */ }
  return providerHttpError(response.status, summarizeProviderError(raw))
}

function summarizeProviderError(raw: string): string | undefined {
  if (!raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>
      const error = root.error
      if (typeof error === 'string') return truncateProviderDetail(error)
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        const value = error as Record<string, unknown>
        const fields = [value.message, value.type, value.code, value.param].filter((field): field is string => typeof field === 'string' && field.length > 0)
        if (fields.length > 0) return truncateProviderDetail(fields.join(' | '))
      }
      const message = root.message
      if (typeof message === 'string' && message.length > 0) return truncateProviderDetail(message)
    }
  } catch { /* fall back to a bounded plain-text detail */ }
  return truncateProviderDetail(raw.replace(/\s+/g, ' ').trim())
}

function truncateProviderDetail(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`
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
export async function consumeProviderSse(response: Response, onEvent?: (event: ProviderSseEvent) => void): Promise<ProviderSseEvent[]> {
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
    const event = { ...(eventName === undefined ? {} : { event: eventName }), data }
    events.push(event)
    onEvent?.(event)
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

export function normalizeOpenAIResponse(response: any, toolNameAliases?: ReadonlyMap<string, string>, provider = 'openai'): LLMResult {
  const root = providerRecord(response, 'OpenAI response')
  if (!Array.isArray(root.choices) || root.choices.length === 0) throw providerResponseError('OpenAI response must contain at least one choice')
  const choice = providerRecord(root.choices[0], 'OpenAI choice')
  const message = providerRecord(choice.message, 'OpenAI message')
  const nativeToolCalls = choice.finish_reason === 'length' || message.tool_calls === undefined ? [] : normalizeOpenAIToolCalls(message.tool_calls, toolNameAliases)
  const refusal = message.refusal == null ? undefined : requiredProviderString(message.refusal, 'OpenAI refusal')
  let text = providerText(message.content, 'OpenAI message content')
  let finishReason = normalizeOpenAIFinishReason(choice.finish_reason, refusal, nativeToolCalls.length > 0)
  let toolCalls = nativeToolCalls
  if (provider === 'deepseek' && (finishReason === 'stop' || nativeToolCalls.length > 0)) {
    const recovered = recoverDeepSeekDsml(text, toolNameAliases, nativeToolCalls.length === 0)
    text = recovered.text
    if (nativeToolCalls.length === 0 && recovered.truncated) {
      toolCalls = []
      finishReason = 'length'
    } else if (nativeToolCalls.length === 0 && recovered.calls.length > 0) {
      toolCalls = recovered.calls.map((call, index) => ({ toolCallId: `pulse-tool-${index + 1}`, providerToolCallId: `dsml-${index + 1}`, providerToolName: call.providerToolName, providerToolArguments: call.providerToolArguments, name: call.name, input: call.input }))
      finishReason = 'tool_calls'
    }
  }
  if (provider === 'deepseek' && nativeToolCalls.length === 0 && finishReason === 'stop' && toolCalls.length === 0) {
    const jsonCalls = recoverDeepSeekJsonToolCalls(text, toolNameAliases)
    if (jsonCalls !== undefined) {
      text = ''
      toolCalls = jsonCalls.map((call, index) => ({ toolCallId: `pulse-tool-${index + 1}`, providerToolCallId: `json-${index + 1}`, providerToolName: call.providerToolName, providerToolArguments: call.providerToolArguments, name: call.name, input: call.input }))
      finishReason = 'tool_calls'
    }
  }
  const rawUsage = root.usage === undefined ? undefined : providerRecord(root.usage, 'OpenAI usage')
  const promptDetails = rawUsage?.prompt_tokens_details === undefined ? undefined : providerRecord(rawUsage.prompt_tokens_details, 'OpenAI prompt token details')
  const usage = normalizeUsage(rawUsage === undefined ? undefined : { ...rawUsage, cached_tokens: rawUsage.cached_tokens ?? promptDetails?.cached_tokens ?? rawUsage.cache_read_input_tokens, reasoning_tokens: rawUsage.completion_tokens_details?.reasoning_tokens ?? rawUsage.reasoning_tokens }, { input: 'prompt_tokens', output: 'completion_tokens', cached: 'cached_tokens', reasoning: 'reasoning_tokens' }, 'OpenAI')
  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined
  const measuredUsage = usage === undefined ? undefined : { ...usage, visibleOutputChars: text.length }
  return { text, ...(parseStructured(text) === undefined ? {} : { structured: parseStructured(text) }), toolCalls, ...(refusal === undefined ? {} : { refusal }), finishReason, ...(measuredUsage === undefined ? {} : { usage: measuredUsage }), ...(provider !== 'deepseek' || reasoningContent === undefined ? {} : { providerContinuation: { provider, reasoningContent } }) }
}

/** DeepSeek V4/V4.1 may emit DSML tool markup in content instead of tool_calls. One or more U+FF5C bars are accepted. */
function recoverDeepSeekDsml(text: string, toolNameAliases: ReadonlyMap<string, string> | undefined, parseCalls: boolean): { text: string; calls: Array<{ providerToolName: string; name: string; input: unknown; providerToolArguments: string }>; truncated: boolean } {
  const blocks = takeDsmlBlocks(text)
  if (!blocks.changed) return { text, calls: [], truncated: false }
  if (blocks.truncated || !parseCalls) return { text: blocks.text, calls: [], truncated: blocks.truncated }
  const calls: Array<{ providerToolName: string; name: string; input: unknown; providerToolArguments: string }> = []
  for (const inner of blocks.inners) {
    const parsed = parseDsmlInvokes(inner, toolNameAliases)
    if (parsed === undefined) return { text: blocks.text, calls: [], truncated: true }
    calls.push(...parsed)
  }
  return { text: blocks.text, calls, truncated: false }
}

function takeDsmlBlocks(text: string): { text: string; inners: string[]; truncated: boolean; changed: boolean } {
  const inners: string[] = []
  let cursor = 0
  let cleaned = ''
  let changed = false
  while (cursor < text.length) {
    const open = nextDsmlMatch(DSML_BLOCK_OPEN, text, cursor)
    if (open === undefined) break
    const close = nextDsmlMatch(DSML_BLOCK_CLOSE, text, open.end)
    const nested = nextDsmlMatch(DSML_BLOCK_OPEN, text, open.end)
    cleaned += text.slice(cursor, open.start)
    changed = true
    if (close === undefined || (nested !== undefined && nested.start < close.start)) {
      return { text: cleaned.trim(), inners: [], truncated: true, changed: true }
    }
    inners.push(text.slice(open.end, close.start))
    cursor = close.end
  }
  if (!changed) return { text, inners, truncated: false, changed: false }
  cleaned += text.slice(cursor)
  return { text: cleaned.trim(), inners, truncated: false, changed: true }
}

function parseDsmlInvokes(inner: string, toolNameAliases?: ReadonlyMap<string, string>): Array<{ providerToolName: string; name: string; input: unknown; providerToolArguments: string }> | undefined {
  const opened = countDsmlTags(DSML_INVOKE_OPEN, inner)
  if (opened !== countDsmlTags(DSML_INVOKE_CLOSE, inner)) return undefined
  const calls: Array<{ providerToolName: string; name: string; input: unknown; providerToolArguments: string }> = []
  const invoke = new RegExp(DSML_INVOKE_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = invoke.exec(inner)) !== null) {
    const providerToolName = requiredProviderString(match[1], 'OpenAI tool name')
    const parameters = parseDsmlParameters(match[2] ?? '')
    if (parameters === undefined) return undefined
    calls.push({ providerToolName, name: toolNameAliases?.get(providerToolName) ?? providerToolName, input: parameters, providerToolArguments: JSON.stringify(parameters) })
  }
  return calls.length === opened ? calls : undefined
}

function parseDsmlParameters(body: string): Record<string, unknown> | undefined {
  const opened = countDsmlTags(DSML_PARAMETER_OPEN, body)
  if (opened !== countDsmlTags(DSML_PARAMETER_CLOSE, body)) return undefined
  const input: Record<string, unknown> = {}
  const parameter = new RegExp(DSML_PARAMETER_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = parameter.exec(body)) !== null) {
    const name = requiredProviderString(match[1], 'OpenAI tool name')
    if (match[2] === 'true') input[name] = match[3] ?? ''
    else {
      const parsed = parseDsmlJson(match[3] ?? '')
      if (parsed === undefined) return undefined
      input[name] = parsed
    }
  }
  return Object.keys(input).length === opened ? input : undefined
}

function parseDsmlJson(value: string): unknown | undefined {
  try { return JSON.parse(value) } catch { return undefined }
}

/** DeepSeek sometimes writes tool calls as JSON or markdown fences instead of tool_calls. A bare object still needs an explicit tool name. Argument-shaped JSON, a single tool object after prose, and any trailing prose stay text. */
function recoverDeepSeekJsonToolCalls(text: string, toolNameAliases?: ReadonlyMap<string, string>): Array<{ providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string }> | undefined {
  const trimmed = text.trim()
  return recoverStrictJsonToolCalls(trimmed, toolNameAliases) ?? recoverMarkdownToolFences(trimmed, toolNameAliases)
}

function recoverStrictJsonToolCalls(text: string, toolNameAliases?: ReadonlyMap<string, string>): Array<{ providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string }> | undefined {
  const leading = takeLeadingJsonValues(text)
  if (leading === undefined || leading.values.length === 0 || leading.rest.trim().length > 0) return undefined
  const objects = leading.values.filter((value) => !isEmptyJsonValue(value))
  if (objects.length === 0) return undefined
  if (objects.length === 1 && Array.isArray(objects[0]) && objects[0].every((item) => argumentObject(item) !== undefined)) return toolCallsFrom(objects[0], toolNameAliases)
  if (objects.length === 1 && objects[0] && typeof objects[0] === 'object' && !Array.isArray(objects[0])) {
    const batch = (objects[0] as Record<string, unknown>).tool_calls ?? (objects[0] as Record<string, unknown>).toolCalls
    if (Array.isArray(batch)) return toolCallsFrom(batch, toolNameAliases)
  }
  return toolCallsFrom(objects, toolNameAliases)
}

/** A message that is only `tool.name` headings followed by JSON fences is a tool batch, not a finished answer. */
function recoverMarkdownToolFences(text: string, toolNameAliases?: ReadonlyMap<string, string>): Array<{ providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string }> | undefined {
  const lines = text.split(/\r?\n/)
  const calls: Array<{ providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string }> = []
  let index = 0
  const skipBlank = (): void => { while (index < lines.length && lines[index]!.trim() === '') index++ }
  skipBlank()
  if (index >= lines.length) return undefined
  while (index < lines.length) {
    skipBlank()
    if (index >= lines.length) break
    const providerToolName = lines[index]!.trim()
    if (!/^[A-Za-z][\w-]*(?:\.[\w-]+)+$/.test(providerToolName)) return undefined
    index++
    if (lines[index]?.trim() !== '```json' && lines[index]?.trim() !== '```') return undefined
    index++
    const body: string[] = []
    while (index < lines.length && lines[index]!.trim() !== '```') body.push(lines[index++]!)
    if (index >= lines.length) return undefined
    index++
    let parsed: unknown
    try { parsed = JSON.parse(body.join('\n')) } catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const input = parsed as Record<string, unknown>
    calls.push({ providerToolName, name: toolNameAliases?.get(providerToolName) ?? providerToolName, input, providerToolArguments: JSON.stringify(input) })
  }
  return calls.length > 0 ? calls : undefined
}

function toolCallsFrom(values: unknown[], toolNameAliases?: ReadonlyMap<string, string>): Array<{ providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string }> | undefined {
  const calls = values.map((value) => jsonToolCall(value, toolNameAliases))
  return calls.every((call) => call !== undefined) && calls.length > 0 ? calls as Array<{ providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string }> : undefined
}

function argumentObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const named = typeof record.tool === 'string' && record.tool.length > 0 ? record.tool : typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined
  const raw = record.arguments ?? record.input ?? record.parameters ?? record.args
  if (named === undefined || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function isEmptyJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0
}

function jsonToolCall(value: unknown, toolNameAliases?: ReadonlyMap<string, string>): { providerToolName: string; name: string; input: Record<string, unknown>; providerToolArguments: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const named = typeof record.tool === 'string' && record.tool.length > 0 ? record.tool : typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined
  const providerToolName = named
  if (providerToolName === undefined) return undefined
  const raw = record.arguments ?? record.input ?? record.parameters ?? record.args
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : { ...record }
  if (raw === undefined) {
    delete input.tool
    delete input.name
  }
  return { providerToolName, name: toolNameAliases?.get(providerToolName) ?? providerToolName, input, providerToolArguments: JSON.stringify(input) }
}

function takeLeadingJsonValues(text: string): { values: unknown[]; rest: string } | undefined {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  const values: unknown[] = []
  let cursor = 0
  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++
    if (cursor >= text.length) break
    if (text[cursor] !== '{' && text[cursor] !== '[') break
    const end = jsonValueEnd(text, cursor)
    if (end === undefined) return undefined
    try { values.push(JSON.parse(text.slice(cursor, end))) } catch { return undefined }
    cursor = end
  }
  return values.length > 0 ? { values, rest: text.slice(cursor) } : undefined
}

function jsonValueEnd(text: string, start: number): number | undefined {
  const opening = text[start]
  if (opening !== '{' && opening !== '[') return undefined
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']')
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return undefined
      if (stack.length === 0) return index + 1
    }
  }
  return undefined
}

function countDsmlTags(pattern: RegExp, value: string): number {
  return value.match(new RegExp(pattern.source, 'g'))?.length ?? 0
}

function nextDsmlMatch(pattern: RegExp, value: string, from: number): { start: number; end: number } | undefined {
  const match = new RegExp(pattern.source, 'g').exec(value.slice(from))
  return match === null ? undefined : { start: from + match.index, end: from + match.index + match[0].length }
}

const DSML_BLOCK_OPEN = /<\uFF5C+DSML\uFF5C+\s*(?:tool_calls|calls)>/
const DSML_BLOCK_CLOSE = /<\/\uFF5C+DSML\uFF5C+\s*(?:tool_calls|calls)>/
const DSML_INVOKE_OPEN = /<\uFF5C+DSML\uFF5C+\s*invoke\b/
const DSML_INVOKE_CLOSE = /<\/\uFF5C+DSML\uFF5C+\s*invoke>/
const DSML_INVOKE_PATTERN = /<\uFF5C+DSML\uFF5C+\s*invoke\s+name="([^"]+)"\s*\/?>([\s\S]*?)<\/\uFF5C+DSML\uFF5C+\s*invoke>/
const DSML_PARAMETER_OPEN = /<\uFF5C+DSML\uFF5C+\s*parameter\b/
const DSML_PARAMETER_CLOSE = /<\/\uFF5C+DSML\uFF5C+\s*parameter>/
const DSML_PARAMETER_PATTERN = /<\uFF5C+DSML\uFF5C+\s*parameter\s+name="([^"]+)"\s+string="(true|false)"\s*>([\s\S]*?)<\/\uFF5C+DSML\uFF5C+\s*parameter>/

export function normalizeAnthropicResponse(response: any): LLMResult {
  const root = providerRecord(response, 'Anthropic response')
  if (!Array.isArray(root.content)) throw providerResponseError('Anthropic response content must be an array')
  const blocks = root.content
  const text = blocks.filter((block: any) => providerRecord(block, 'Anthropic content block').type === 'text').map((block: any) => requiredProviderString(providerRecord(block, 'Anthropic text block').text, 'Anthropic text block text')).join('')
  const toolBlocks = blocks.filter((block: any) => providerRecord(block, 'Anthropic content block').type === 'tool_use')
  const toolCalls = (root.stop_reason === 'max_tokens' ? [] : toolBlocks).map((block: any, index: number) => {
    const value = providerRecord(block, 'Anthropic tool block')
    return { toolCallId: `pulse-tool-${index + 1}`, name: requiredProviderString(value.name, 'Anthropic tool name'), input: parseJson(value.input) }
  })
  const refusalBlock = blocks.find((block: any) => block.type === 'refusal' && typeof block.text === 'string')
  const refusal = refusalBlock?.text as string | undefined
  const finishReason = normalizeAnthropicFinishReason(root.stop_reason, refusal, toolCalls.length > 0)
  const usage = normalizeUsage(root.usage, { input: 'input_tokens', output: 'output_tokens', cached: 'cache_read_input_tokens' }, 'Anthropic')
  const measuredUsage = usage === undefined ? undefined : { ...usage, visibleOutputChars: text.length }
  return { text, ...(parseStructured(text) === undefined ? {} : { structured: parseStructured(text) }), toolCalls, ...(refusal === undefined ? {} : { refusal }), finishReason, ...(measuredUsage === undefined ? {} : { usage: measuredUsage }) }
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

function normalizeUsage(raw: unknown, fields: { input: string; output: string; cached: string; reasoning?: string }, provider: string): NonNullable<LLMResult['usage']> | undefined {
  if (raw === undefined) return undefined
  const value = providerRecord(raw, `${provider} usage`)
  const inputTokens = providerMetric(value[fields.input], `${provider} input tokens`)
  const outputTokens = providerMetric(value[fields.output], `${provider} output tokens`)
  const cachedInputTokens = providerMetric(value[fields.cached], `${provider} cached input tokens`)
  const reasoningTokens = fields.reasoning === undefined ? undefined : providerMetric(value[fields.reasoning], `${provider} reasoning tokens`)
  if (inputTokens !== undefined && cachedInputTokens !== undefined && cachedInputTokens > inputTokens) throw providerResponseError(`${provider} cached input tokens exceed input tokens`)
  const cost = value.cost === undefined ? undefined : normalizeCost(value.cost, provider)
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(reasoningTokens === undefined ? {} : { reasoningTokens }), ...(inputTokens !== undefined && cachedInputTokens !== undefined ? { uncachedInputTokens: inputTokens - cachedInputTokens } : {}), ...(cost === undefined ? {} : { cost }) }
}

function normalizeCost(raw: unknown, provider: string): NonNullable<LLMResult['usage']>['cost'] {
  const value = providerRecord(raw, `${provider} cost`)
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0) throw providerResponseError(`${provider} cost amount must be a non-negative number`)
  if (typeof value.currency !== 'string' || value.currency.length === 0) throw providerResponseError(`${provider} cost currency must be a non-empty string`)
  if (value.pricing_version !== undefined && typeof value.pricing_version !== 'string') throw providerResponseError(`${provider} pricing version must be a string`)
  return { amount: value.amount, currency: value.currency, source: 'reported', ...(value.pricing_version === undefined ? {} : { pricingVersion: value.pricing_version }) }
}

function normalizeOpenAIToolCalls(raw: unknown, toolNameAliases?: ReadonlyMap<string, string>): Array<{ toolCallId: string; name: string; input: unknown }> {
  if (!Array.isArray(raw)) throw providerResponseError('OpenAI tool_calls must be an array')
  return raw.map((call: unknown, index: number) => {
    const value = providerRecord(call, 'OpenAI tool call')
    const fn = providerRecord(value.function, 'OpenAI tool function')
    const providerName = requiredProviderString(fn.name, 'OpenAI tool name')
    const providerToolCallId = typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined
    if (typeof fn.arguments !== 'string') throw providerResponseError('OpenAI tool arguments must be a JSON string')
    return { toolCallId: `pulse-tool-${index + 1}`, ...(providerToolCallId === undefined ? {} : { providerToolCallId }), providerToolName: providerName, providerToolArguments: fn.arguments, name: toolNameAliases?.get(providerName) ?? providerName, input: parseJson(fn.arguments) }
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
