import type { CanonicalContentPart, CanonicalLLMRequest, CanonicalStreamEvent, ModelCapabilityProfile } from '../types.js'

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export function toAnthropicPayload(
  canonical: CanonicalLLMRequest,
  _capability: ModelCapabilityProfile,
): Record<string, unknown> {
  const systemParts: string[] = []
  const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> = []

  const appendBlocks = (role: 'user' | 'assistant', blocks: AnthropicContentBlock[]): void => {
    if (blocks.length === 0) return
    const previous = messages.at(-1)
    if (previous?.role === role) previous.content.push(...blocks)
    else messages.push({ role, content: [...blocks] })
  }

  for (const msg of canonical.messages) {
    if (msg.role === 'system') {
      const text = textFromContent(msg.content)
      if (text !== undefined) systemParts.push(text)
      continue
    }

    if (msg.role === 'tool') {
      appendBlocks('user', [{ type: 'tool_result', tool_use_id: msg.toolCallId ?? '', content: textFromContent(msg.content) ?? '' }])
      continue
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []
      const text = textFromContent(msg.content)
      if (text !== undefined) blocks.push({ type: 'text', text })
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.arguments) })
      }
      appendBlocks('assistant', blocks)
      continue
    }

    const text = textFromContent(msg.content)
    if (text !== undefined) appendBlocks('user', [{ type: 'text', text }])
  }

  const system = systemParts.join('\n')
  const maxTokens = canonical.maxTokens ?? 4096

  const body: Record<string, unknown> = {
    ...(canonical.model ? { model: canonical.model } : {}),
    max_tokens: maxTokens,
    ...(canonical.temperature !== undefined ? { temperature: canonical.temperature } : {}),
    ...(system.length > 0 ? { system } : {}),
    messages,
  }

  // Thinking
  if (canonical.reasoning?.budgetTokens) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: canonical.reasoning.budgetTokens,
    }
  }

  // Tools
  if (canonical.tools && canonical.tools.length > 0) {
    body.tools = canonical.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.parameters,
    }))
    const toolChoice = canonical.toolChoice === undefined ? undefined : mapAnthropicToolChoice(canonical.toolChoice)
    if (toolChoice !== undefined) body.tool_choice = toolChoice
  }

  // Structured output
  if (canonical.structuredOutput?.schema) {
    body.output_format = {
      type: 'json_schema',
      schema: canonical.structuredOutput.schema,
    }
  }

  // Streaming
  if (canonical.stream) {
    body.stream = true
  }

  return body
}

function textFromContent(content: string | null | CanonicalContentPart[] | undefined): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
  return text.length > 0 ? text : undefined
}

function parseToolInput(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return { arguments: parsed }
  } catch {
    return { arguments: argumentsText }
  }
}

function mapAnthropicToolChoice(choice: NonNullable<CanonicalLLMRequest['toolChoice']>): Record<string, string> | undefined {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') return undefined
  if (typeof choice === 'object' && 'function' in choice) {
    return { type: 'tool', name: choice.function.name }
  }
  return undefined
}

export function parseAnthropicSseEvents(event: { event?: string; data: any }): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = []
  if (!event.data || typeof event.data !== 'object') return events
  const data = event.data

  if (event.event === 'content_block_delta' && data.delta && typeof data.delta === 'object') {
    if (data.delta.type === 'text_delta' && typeof data.delta.text === 'string') {
      events.push({ type: 'text_delta', text: data.delta.text })
    }
    if (data.delta.type === 'thinking_delta' && typeof data.delta.thinking === 'string') {
      events.push({ type: 'reasoning_delta', text: data.delta.thinking })
    }
    if (data.delta.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') {
      events.push({
        type: 'tool_call_delta',
        index: Number(data.index ?? 0),
        argumentsDelta: data.delta.partial_json,
      })
    }
  }

  if (event.event === 'message_delta') {
    if (typeof data.delta?.stop_reason === 'string') {
      events.push({ type: 'finish', reason: data.delta.stop_reason })
    }
    if (data.usage && typeof data.usage === 'object') {
      events.push({
        type: 'usage',
        usage: {
          ...(typeof data.usage.output_tokens === 'number' ? { outputTokens: data.usage.output_tokens } : {}),
        },
      })
    }
  }

  if (event.event === 'message_start' && data.message?.usage && typeof data.message.usage === 'object') {
    events.push({
      type: 'usage',
      usage: {
        ...(typeof data.message.usage.input_tokens === 'number' ? { inputTokens: data.message.usage.input_tokens } : {}),
        ...(typeof data.message.usage.output_tokens === 'number' ? { outputTokens: data.message.usage.output_tokens } : {}),
      },
    })
  }

  return events
}
