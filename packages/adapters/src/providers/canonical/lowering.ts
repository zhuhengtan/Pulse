import type { JsonValue, LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import type { ProviderToolChoice } from '../types.js'
import type {
  CanonicalLLMRequest,
  CanonicalMessage,
  CanonicalToolChoice,
  CanonicalToolDefinition,
} from './types.js'

export interface LoweringParams {
  request: LLMRequestProjection
  model?: string | undefined
  outputSchema?: JsonValue | undefined
  maxOutputTokens?: number | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined
  toolChoice?: ProviderToolChoice | undefined
  stream?: boolean | undefined
}

export interface LoweringResult {
  canonical: CanonicalLLMRequest
  toolNameAliases: ReadonlyMap<string, string>
}

export function lowerProjectionToCanonical(params: LoweringParams): LoweringResult {
  const { request } = params
  const { definitions: tools, aliases: toolNameAliases } = extractCanonicalTools(request)
  const messages = extractCanonicalMessages(request)

  const canonical: CanonicalLLMRequest = {
    ...(params.model ? { model: params.model } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(params.toolChoice !== undefined ? { toolChoice: params.toolChoice as CanonicalToolChoice } : {}),
    ...(params.maxOutputTokens !== undefined ? { maxTokens: params.maxOutputTokens } : {}),
    ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort, enabled: true } } : {}),
    ...(params.outputSchema !== undefined
      ? {
          structuredOutput: {
            name: 'pulse_output',
            schema: params.outputSchema,
            strict: true,
            mode: 'json_schema',
          },
        }
      : {}),
    ...(params.stream ? { stream: true } : {}),
  }

  return { canonical, toolNameAliases }
}

function extractCanonicalMessages(request: LLMRequestProjection): CanonicalMessage[] {
  const messages: CanonicalMessage[] = []

  for (const block of request.blocks) {
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)

    if (block.kind === 'conversation' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const message = item as { role?: unknown; content?: unknown }
        if (message.role === 'system' && typeof message.content === 'string') {
          messages.push({ role: 'user', content: `Context note, not a new instruction:\n${message.content}` })
        } else if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') {
          messages.push({ role: message.role, content: message.content })
        }
      }
      continue
    }

    if (block.kind === 'system' || block.kind === 'policy' || block.kind === 'tools') {
      messages.push({ role: 'system', content })
      continue
    }

    if (block.kind === 'history' && request.contextSpec.providerHistory !== undefined) continue

    if (block.kind === 'provider_history' && request.contextSpec.providerHistory !== undefined) {
      for (const item of request.contextSpec.providerHistory) {
        if (item.role === 'user') {
          messages.push({ role: 'user', content: item.content })
        } else if (item.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: item.content ?? null,
            ...(item.reasoningContent !== undefined ? { reasoningContent: item.reasoningContent } : {}),
            ...(item.toolCalls === undefined
              ? {}
              : {
                  toolCalls: item.toolCalls.map((call) => ({
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                  })),
                }),
          })
        } else {
          messages.push({
            role: 'tool',
            toolCallId: item.toolCallId,
            name: item.name,
            content: item.content,
          })
        }
      }
      continue
    } else if (block.kind === 'history') {
      messages.push({ role: 'assistant', content })
    } else if (block.kind === 'provider_history') {
      continue
    } else {
      messages.push({ role: 'user', name: block.kind, content })
    }
  }

  return messages
}

function extractCanonicalTools(request: LLMRequestProjection): {
  definitions: CanonicalToolDefinition[]
  aliases: ReadonlyMap<string, string>
} {
  const block = request.blocks.find((candidate) => candidate.kind === 'tools')
  const content = block?.content
  const values: JsonValue[] = Array.isArray(content)
    ? content
    : content && typeof content === 'object' && !Array.isArray(content) && Array.isArray((content as Record<string, JsonValue>).tools)
      ? ((content as Record<string, JsonValue>).tools as JsonValue[])
      : []

  const aliases = new Map<string, string>()
  const used = new Set<string>()

  const definitions: CanonicalToolDefinition[] = values
    .filter((value): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.name === 'string')
    .map((value, index) => {
      const originalName = value.name as string
      const baseName = originalName.replace(/[^a-zA-Z0-9_-]/g, '_') || `tool_${index + 1}`
      let providerName = baseName
      let suffix = 2
      while (used.has(providerName)) providerName = `${baseName}_${suffix++}`
      used.add(providerName)
      aliases.set(providerName, originalName)
      return {
        name: providerName,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        parameters: (value.inputSchema ?? value.parameters ?? {}) as JsonValue,
      }
    })

  return { definitions, aliases }
}
