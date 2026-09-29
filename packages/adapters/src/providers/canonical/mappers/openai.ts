import type { CanonicalLLMRequest, CanonicalStreamEvent, ModelCapabilityProfile } from '../types.js'

export function toOpenAIPayload(
  canonical: CanonicalLLMRequest,
  capability: ModelCapabilityProfile,
  provider = 'openai',
): Record<string, unknown> {
  const messages = canonical.messages.map((msg) => {
    const base: Record<string, unknown> = {
      role: msg.role,
      content: msg.content === null ? null : typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    }
    if (msg.name) base.name = msg.name
    if (msg.toolCallId) base.tool_call_id = msg.toolCallId
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      base.tool_calls = msg.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      }))
    }
    if (provider === 'deepseek' && msg.reasoningContent !== undefined) {
      base.reasoning_content = msg.reasoningContent
    }
    return base
  })

  const body: Record<string, unknown> = {
    ...(canonical.model ? { model: canonical.model } : {}),
    messages,
  }

  // Token limits
  if (canonical.maxTokens !== undefined) {
    if (capability.constraints.maxTokensParamName === 'max_completion_tokens') {
      body.max_completion_tokens = canonical.maxTokens
    } else {
      body.max_tokens = canonical.maxTokens
    }
  }

  // Sampling hyperparameters
  if (canonical.temperature !== undefined) {
    body.temperature = canonical.temperature
  }
  if (canonical.topP !== undefined) {
    body.top_p = canonical.topP
  }
  if (canonical.stop) {
    body.stop = canonical.stop
  }

  // Reasoning
  if (canonical.reasoning?.effort) {
    body.reasoning_effort = canonical.reasoning.effort
  }

  // Tools
  if (canonical.tools && canonical.tools.length > 0) {
    body.tools = canonical.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    }))
    if (canonical.toolChoice !== undefined) {
      body.tool_choice = canonical.toolChoice
    }
  }

  // Structured output
  if (canonical.structuredOutput) {
    if (canonical.structuredOutput.mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: canonical.structuredOutput.name ?? 'pulse_output',
          strict: canonical.structuredOutput.strict ?? true,
          schema: canonical.structuredOutput.schema,
        },
      }
    } else if (canonical.structuredOutput.mode === 'json_object') {
      body.response_format = { type: 'json_object' }
    }
  }

  // Streaming
  if (canonical.stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }

  return body
}

export function parseOpenAISseEvents(raw: unknown): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = []
  if (!raw || typeof raw !== 'object') return events
  const root = raw as Record<string, unknown>

  if (root.usage && typeof root.usage === 'object') {
    const u = root.usage as Record<string, unknown>
    events.push({
      type: 'usage',
      usage: {
        ...(typeof u.prompt_tokens === 'number' ? { inputTokens: u.prompt_tokens } : {}),
        ...(typeof u.completion_tokens === 'number' ? { outputTokens: u.completion_tokens } : {}),
        ...(typeof (u.completion_tokens_details as any)?.reasoning_tokens === 'number'
          ? { reasoningTokens: (u.completion_tokens_details as any).reasoning_tokens }
          : {}),
        ...(typeof (u.prompt_tokens_details as any)?.cached_tokens === 'number'
          ? { cachedInputTokens: (u.prompt_tokens_details as any).cached_tokens }
          : {}),
      },
    })
  }

  if (Array.isArray(root.choices) && root.choices.length > 0) {
    const choice = root.choices[0] as Record<string, unknown>
    const delta = choice.delta as Record<string, unknown> | undefined

    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'text_delta', text: delta.content })
    }
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      events.push({ type: 'reasoning_delta', text: delta.reasoning_content })
    }
    if (typeof delta?.refusal === 'string' && delta.refusal.length > 0) {
      events.push({ type: 'refusal_delta', refusal: delta.refusal })
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const call of delta.tool_calls as Array<Record<string, unknown>>) {
        const fn = call.function as Record<string, unknown> | undefined
        events.push({
          type: 'tool_call_delta',
          index: typeof call.index === 'number' ? call.index : 0,
          ...(typeof call.id === 'string' ? { id: call.id } : {}),
          ...(typeof fn?.name === 'string' ? { name: fn.name } : {}),
          argumentsDelta: typeof fn?.arguments === 'string' ? fn.arguments : '',
        })
      }
    }
    if (typeof choice.finish_reason === 'string') {
      events.push({ type: 'finish', reason: choice.finish_reason })
    }
  }

  return events
}
