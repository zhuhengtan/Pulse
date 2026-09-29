import type {
  AdaptedCanonicalRequest,
  CanonicalLLMRequest,
  CanonicalMessage,
  ModelCapabilityProfile,
} from './types.js'

export class DynamicCapabilityProbe {
  private readonly unsupportedReasoning = new Set<string>()

  private key(provider: string, model?: string): string {
    return `${provider.toLowerCase()}:${(model ?? '').toLowerCase()}`
  }

  isReasoningUnsupported(provider: string, model?: string): boolean {
    return this.unsupportedReasoning.has(this.key(provider, model))
  }

  markReasoningUnsupported(provider: string, model?: string): void {
    this.unsupportedReasoning.add(this.key(provider, model))
  }

  reasoningParameterRejected(cause: unknown): boolean {
    if (!(cause instanceof Error)) return false
    const code = (cause as { code?: unknown }).code
    if (code !== 'PROVIDER_HTTP_400') return false
    return /reasoning_effort/i.test(cause.message)
  }
}

export const globalProbe = new DynamicCapabilityProbe()

export function adaptCanonicalRequest(
  original: CanonicalLLMRequest,
  capability: ModelCapabilityProfile,
  probe: DynamicCapabilityProbe = globalProbe,
  toolNameAliases: ReadonlyMap<string, string> = new Map(),
): AdaptedCanonicalRequest {
  const messages: CanonicalMessage[] = [...original.messages.map((m) => ({ ...m }))]
  const request: CanonicalLLMRequest = {
    ...original,
    messages,
    ...(original.tools ? { tools: [...original.tools] } : {}),
  }

  let clientSchemaValidationRequired = false

  // 1. Structured Output Adaptation
  if (request.structuredOutput) {
    if (capability.structuredOutput === 'json_object_only') {
      const schemaPrompt = `Return only a JSON object matching this schema. The application will validate the result:\n${JSON.stringify(request.structuredOutput.schema)}`
      injectSystemInstruction(messages, schemaPrompt)
      request.structuredOutput = {
        ...request.structuredOutput,
        mode: 'json_object',
      }
      clientSchemaValidationRequired = true
    } else if (capability.structuredOutput === 'unsupported') {
      const schemaPrompt = `Return only a JSON object matching this schema. The application will validate the result:\n${JSON.stringify(request.structuredOutput.schema)}`
      injectSystemInstruction(messages, schemaPrompt)
      delete request.structuredOutput
      clientSchemaValidationRequired = true
    } else {
      request.structuredOutput = {
        ...request.structuredOutput,
        mode: 'json_schema',
      }
      if (capability.structuredOutput === 'native_loose') {
        clientSchemaValidationRequired = true
      }
    }
  }

  // 2. Reasoning / Thinking Adaptation
  const reasoningDisabled =
    probe.isReasoningUnsupported(capability.provider, request.model) ||
    capability.reasoning === 'unsupported'

  if (reasoningDisabled || !request.reasoning?.effort) {
    delete request.reasoning
  } else if (capability.reasoning === 'budget_tokens') {
    const maxTokens = request.maxTokens ?? 4096
    const requested = request.reasoning.effort === 'high' ? 8_000 : request.reasoning.effort === 'medium' ? 2_048 : 1_024
    const budget = Math.min(requested, maxTokens - 1_024)
    if (budget >= 1_024 && budget < maxTokens) {
      request.reasoning = {
        ...request.reasoning,
        budgetTokens: budget,
        enabled: true,
      }
      if (capability.constraints.disallowTemperatureWithReasoning) {
        request.temperature = capability.constraints.defaultTemperatureWithReasoning ?? 1.0
      }
    } else {
      delete request.reasoning
    }
  } else if (capability.reasoning === 'effort_param') {
    if (capability.constraints.disallowTemperatureWithReasoning) {
      delete request.temperature
    }
  } else if (capability.reasoning === 'prompt_mode') {
    delete request.reasoning
  }

  return {
    request,
    capability,
    clientSchemaValidationRequired,
    toolNameAliases,
  }
}

function injectSystemInstruction(messages: CanonicalMessage[], instruction: string): void {
  messages.unshift({ role: 'system', content: instruction })
}
