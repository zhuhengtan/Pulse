import { createHash } from 'node:crypto'
import type { JsonValue, LLMResult } from '@hunterzhu/pulse-runtime'
import type { CanonicalLLMRequest, CanonicalMessage, ModelCapabilityProfile } from './canonical/types.js'
import { adaptCanonicalRequest, DynamicCapabilityProbe, lowerProjectionToCanonical, resolveModelCapability } from './canonical/index.js'
import { consumeProviderSse, normalizeOpenAIResponse, parseProviderJson, providerHttpErrorFromResponse, providerNetworkError, providerResponseError } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, field: string): string => { if (typeof value !== 'string') throw providerResponseError(`Invalid Responses ${field}`); return value }
const CONTINUATION = 'pulse-responses-v2'
const MAX_CONTINUATION_BYTES = 262144
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Explicit stateless Responses protocol. Never retries using another endpoint or protocol. */
export class ResponsesAdapter implements ProviderAdapter {
  readonly name = 'OpenAI Responses'
  private readonly endpoint: string
  private readonly probe = new DynamicCapabilityProbe()
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) {
    if (!['openai', 'openai-compatible'].includes(config.provider)) throw new Error('PROVIDER_RESPONSES_UNSUPPORTED')
    this.endpoint = `${(config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`
  }
  private scope(model: string | undefined): string {
    // Only this digest is persisted. Neither credentials nor arbitrary headers enter continuation metadata.
    return digest([CONTINUATION, this.id, this.endpoint, model, this.config])
  }
  async executeAttempt(params: Parameters<ProviderAdapter['executeAttempt']>[0]): Promise<LLMResult> {
    const streaming = params.onObservation !== undefined || params.onReasoning !== undefined
    const { canonical, toolNameAliases } = lowerProjectionToCanonical({ request: params.request, model: params.model ?? this.config.defaultModel, outputSchema: params.outputSchema, maxOutputTokens: params.maxOutputTokens ?? this.config.maxOutputTokens, reasoningEffort: params.reasoningEffort ?? this.config.reasoningEffort, toolChoice: this.config.toolChoice, stream: streaming })
    const capability = resolveModelCapability(canonical.model, this.config.provider, this.config.capabilityProfile, this.config.baseURL)
    // This adapter never probes by retrying. Chat capability rejection caches
    // must not suppress features on an explicitly selected Responses service.
    const { request: adapted } = adaptCanonicalRequest(canonical, capability, this.probe, toolNameAliases)
    const scope = this.scope(canonical.model)
    const body = responsesPayload(adapted, scope, capability)
    try {
      const response = await fetch(this.endpoint, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...this.config.extraHeaders }, body: JSON.stringify(body) })
      if (!response.ok) throw await providerHttpErrorFromResponse(response)
      let terminal: unknown
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        await consumeProviderSse(response, event => {
          if (params.signal.aborted) throw providerResponseError('PROVIDER_REQUEST_CANCELLED')
          const frame = record(event.data)
          const type = frame?.type ?? event.event
          if (event.data === '[DONE]') return
          if (terminal !== undefined) throw providerResponseError('PROVIDER_RESPONSES_EVENT_AFTER_TERMINAL')
          if (type === 'response.output_text.delta' && typeof frame?.delta === 'string') params.onObservation?.(frame.delta)
          if (type === 'response.refusal.delta' && typeof frame?.delta === 'string') params.onObservation?.(frame.delta)
          if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof frame?.delta === 'string') params.onReasoning?.(frame.delta)
          if (type === 'response.failed' || type === 'response.cancelled') throw providerResponseError('PROVIDER_RESPONSES_FAILED')
          if (type === 'error') throw providerResponseError('PROVIDER_RESPONSES_STREAM_ERROR')
          if (type === 'response.completed' || type === 'response.incomplete') {
            if (record(frame?.response)?.status !== (type === 'response.completed' ? 'completed' : 'incomplete')) throw providerResponseError('PROVIDER_RESPONSES_TERMINAL_MISMATCH')
            terminal = frame?.response
          }
        })
        if (terminal === undefined) throw providerResponseError('PROVIDER_STREAM_INCOMPLETE')
      } else terminal = await parseProviderJson(response)
      if (params.signal.aborted) throw Object.assign(new Error('Provider request was cancelled.'), { code: 'PROVIDER_REQUEST_CANCELLED', retryable: false })
      return normalizeResponses(terminal, toolNameAliases, scope)
    } catch (cause) {
      if (params.signal.aborted) throw Object.assign(new Error('Provider request was cancelled.'), { code: 'PROVIDER_REQUEST_CANCELLED', retryable: false, cause })
      if (cause instanceof Error && 'code' in cause && 'retryable' in cause) throw cause
      throw providerNetworkError(cause)
    }
  }
}

/** An ordered allow-list, never a raw response, id lookup, or server-side state. */
function nativeItems(value: unknown): Array<Record<string, JsonValue>> {
  if (!Array.isArray(value)) throw providerResponseError('PROVIDER_RESPONSES_ITEMS_INVALID')
  const items: Array<Record<string, JsonValue>> = []
  for (const raw of value) {
    const item = record(raw)
    if (!item || item.status !== undefined && item.status !== 'completed') throw providerResponseError('PROVIDER_RESPONSES_ITEM_INCOMPLETE')
    const id = typeof item.id === 'string' ? { id: item.id } : {}
    if (item.type === 'reasoning') {
      if (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string') throw providerResponseError('PROVIDER_RESPONSES_REASONING_INVALID')
      const summary = Array.isArray(item.summary) ? item.summary.map(value => {
        const part = record(value)
        if (part?.type !== 'summary_text') throw providerResponseError('PROVIDER_RESPONSES_REASONING_INVALID')
        return { type: 'summary_text', text: text(part.text, 'summary') }
      }) : []
      // Plain reasoning is never retained or projected into ordinary history.
      if (item.encrypted_content) items.push({ type: 'reasoning', ...id, summary, encrypted_content: item.encrypted_content as string })
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) throw providerResponseError('PROVIDER_RESPONSES_MESSAGE_INVALID')
      if (item.phase !== undefined && !['commentary', 'partial_answer', 'final_answer'].includes(String(item.phase))) throw providerResponseError('PROVIDER_RESPONSES_PHASE_UNSUPPORTED')
      const content = item.content.map(value => {
        const part = record(value)
        if (part?.type === 'output_text') return { type: 'output_text', text: text(part.text, 'output_text'), annotations: [] }
        if (part?.type === 'refusal') return { type: 'refusal', refusal: text(part.refusal, 'refusal') }
        throw providerResponseError('PROVIDER_RESPONSES_CONTENT_UNSUPPORTED')
      })
      items.push({ type: 'message', ...id, role: 'assistant', status: 'completed', content, ...(item.phase === undefined ? {} : { phase: item.phase as string }) })
    } else if (item.type === 'function_call') {
      items.push({ type: 'function_call', ...id, call_id: text(item.call_id, 'call_id'), name: text(item.name, 'name'), arguments: text(item.arguments, 'arguments'), status: 'completed' })
    } else throw providerResponseError('PROVIDER_RESPONSES_OUTPUT_UNSUPPORTED')
  }
  if (Buffer.byteLength(JSON.stringify(items)) > MAX_CONTINUATION_BYTES) throw providerResponseError('PROVIDER_RESPONSES_CONTINUATION_TOO_LARGE')
  return items
}
function visibleDigest(content: CanonicalMessage['content'], calls: CanonicalMessage['toolCalls']): string {
  return digest([content ?? '', (calls ?? []).map(call => [call.id, call.name, call.arguments])])
}
function nativeDigest(items: Array<Record<string, JsonValue>>): string {
  const content = items.flatMap(item => item.type === 'message' && Array.isArray(item.content) ? item.content.flatMap(value => {
    const part = record(value); return part?.type === 'output_text' ? [String(part.text)] : []
  }) : []).join('')
  const calls = items.filter(item => item.type === 'function_call').map(item => ({ id: String(item.call_id), name: String(item.name), arguments: String(item.arguments) }))
  return visibleDigest(content, calls)
}

function responsesPayload(canonical: CanonicalLLMRequest, scope: string, capability: ModelCapabilityProfile): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = []
  for (const message of canonical.messages) {
    if (message.role === 'assistant' && message.continuationProvider === CONTINUATION) {
      const metadata = record(message.providerMetadata)
      if (metadata?.scope === scope && metadata.digest === visibleDigest(message.content, message.toolCalls)) {
        try {
          const items = nativeItems(metadata.items)
          if (items.length && nativeDigest(items) === metadata.digest) { input.push(...items); continue }
        } catch { /* Invalid private replay is discarded; canonical history remains. */ }
      }
    }
    if (message.role === 'tool') {
      if (!message.toolCallId) throw providerResponseError('Missing Responses tool call_id')
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) })
      continue
    }
    if (message.content !== null && (typeof message.content !== 'string' || message.content.length > 0)) {
      const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text } : { type: 'input_image', image_url: part.source.type === 'url' ? part.source.data : `data:${part.source.mediaType};base64,${part.source.data}` })
      input.push({ role: message.role, content })
    }
    for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
  }
  const format = canonical.structuredOutput
  return {
    model: canonical.model, input, store: false, stream: canonical.stream === true, include: ['reasoning.encrypted_content'],
    ...(canonical.maxTokens === undefined ? {} : { max_output_tokens: canonical.maxTokens }),
    ...(canonical.reasoning?.effort === undefined ? {} : { reasoning: { effort: canonical.reasoning.effort } }),
    ...(canonical.temperature === undefined ? {} : { temperature: canonical.temperature }),
    ...(canonical.topP === undefined ? {} : { top_p: canonical.topP }),
    ...(canonical.tools?.length ? { tools: canonical.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.parameters, strict: false })) } : {}),
    ...(canonical.toolChoice === undefined ? {} : { tool_choice: typeof canonical.toolChoice === 'object' ? { type: 'function', name: canonical.toolChoice.function.name } : canonical.toolChoice }),
    ...(format === undefined ? {} : { text: { format: format.mode === 'json_object' ? { type: 'json_object' } : { type: 'json_schema', name: format.name ?? 'pulse_output', schema: format.schema, strict: capability.structuredOutput === 'native_loose' ? false : format.strict ?? true } } }),
  }
}

function normalizeResponses(raw: unknown, aliases: ReadonlyMap<string, string>, scope: string): LLMResult {
  const response = record(raw)
  if (!response || !['completed', 'incomplete'].includes(String(response.status)) || !Array.isArray(response.output)) throw providerResponseError('PROVIDER_RESPONSES_TERMINAL_INVALID')
  const incomplete = response.status === 'incomplete'
  const content: string[] = [], refusal: string[] = [], calls: Array<Record<string, unknown>> = []
  const ids = new Set<string>()
  for (const value of response.output) {
    const item = record(value)
    if (!item) throw providerResponseError('PROVIDER_RESPONSES_ITEM_INVALID')
    if (!incomplete && item.status !== undefined && item.status !== 'completed') throw providerResponseError('PROVIDER_RESPONSES_ITEM_INCOMPLETE')
    if (item.type === 'reasoning') continue
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) throw providerResponseError('PROVIDER_RESPONSES_MESSAGE_INVALID')
      for (const value of item.content) {
        const part = record(value)
        if (part?.type === 'output_text') content.push(text(part.text, 'output_text'))
        else if (part?.type === 'refusal') refusal.push(text(part.refusal, 'refusal'))
        else throw providerResponseError('PROVIDER_RESPONSES_CONTENT_UNSUPPORTED')
      }
    } else if (item.type === 'function_call') {
      if (incomplete) continue // Partial arguments are never executable, even if an earlier call was complete.
      const id = text(item.call_id, 'call_id')
      if (!id || ids.has(id)) throw providerResponseError('PROVIDER_RESPONSES_CALL_ID_INVALID')
      ids.add(id)
      calls.push({ id, type: 'function', function: { name: text(item.name, 'function name'), arguments: text(item.arguments, 'function arguments') } })
    } else throw providerResponseError('PROVIDER_RESPONSES_OUTPUT_UNSUPPORTED')
  }
  const usage = record(response.usage)
  const result = normalizeOpenAIResponse({ choices: [{ message: { content: content.join(''), ...(refusal.length ? { refusal: refusal.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: incomplete ? 'length' : calls.length ? 'tool_calls' : 'stop' }], ...(usage ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, prompt_tokens_details: usage.input_tokens_details, completion_tokens_details: usage.output_tokens_details } } : {}) }, aliases)
  if (refusal.length && calls.length) throw providerResponseError('PROVIDER_RESPONSES_REFUSAL_WITH_TOOLS')
  const items = incomplete ? [] : nativeItems(response.output)
  return { ...result, ...(items.length ? { providerContinuation: { provider: CONTINUATION, metadata: { scope, digest: nativeDigest(items), items } } } : {}) }

}
