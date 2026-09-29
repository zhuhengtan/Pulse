import type { ModelCapabilityProfile } from './types.js'

export const DEFAULT_OPENAI_PROFILE: ModelCapabilityProfile = {
  id: 'openai-default',
  provider: 'openai',
  structuredOutput: 'native_strict',
  reasoning: 'effort_param',
  constraints: {
    disallowTemperatureWithReasoning: false,
    maxTokensParamName: 'max_tokens',
    supportsSystemMessage: true,
    supportsParallelTools: true,
  },
}

export const OPENAI_REASONING_PROFILE: ModelCapabilityProfile = {
  id: 'openai-reasoning',
  provider: 'openai',
  structuredOutput: 'native_strict',
  reasoning: 'effort_param',
  constraints: {
    disallowTemperatureWithReasoning: true,
    defaultTemperatureWithReasoning: 1.0,
    maxTokensParamName: 'max_completion_tokens',
    supportsSystemMessage: true,
    supportsParallelTools: true,
  },
}

export const ANTHROPIC_THINKING_PROFILE: ModelCapabilityProfile = {
  id: 'anthropic-thinking',
  provider: 'anthropic',
  structuredOutput: 'native_loose',
  reasoning: 'budget_tokens',
  constraints: {
    disallowTemperatureWithReasoning: true,
    defaultTemperatureWithReasoning: 1.0,
    maxTokensParamName: 'max_tokens',
    supportsSystemMessage: true,
    supportsParallelTools: true,
  },
}

export const DEFAULT_ANTHROPIC_PROFILE: ModelCapabilityProfile = {
  id: 'anthropic-default',
  provider: 'anthropic',
  structuredOutput: 'native_loose',
  reasoning: 'unsupported',
  constraints: {
    disallowTemperatureWithReasoning: false,
    maxTokensParamName: 'max_tokens',
    supportsSystemMessage: true,
    supportsParallelTools: true,
  },
}

export const DEEPSEEK_PROFILE: ModelCapabilityProfile = {
  id: 'deepseek-default',
  provider: 'deepseek',
  structuredOutput: 'json_object_only',
  reasoning: 'effort_param',
  constraints: {
    disallowTemperatureWithReasoning: false,
    maxTokensParamName: 'max_tokens',
    supportsSystemMessage: true,
    supportsParallelTools: true,
  },
}

export const DEFAULT_COMPATIBLE_PROFILE: ModelCapabilityProfile = {
  id: 'openai-compatible-default',
  provider: 'openai-compatible',
  structuredOutput: 'native_strict',
  reasoning: 'effort_param',
  constraints: {
    disallowTemperatureWithReasoning: false,
    maxTokensParamName: 'max_tokens',
    supportsSystemMessage: true,
    supportsParallelTools: true,
  },
}

class CapabilityRegistry {
  private readonly customProfiles = new Map<string, Partial<ModelCapabilityProfile>>()

  registerProfile(pattern: string, profile: Partial<ModelCapabilityProfile>): void {
    const key = pattern.trim().toLowerCase()
    if (!key) return
    this.customProfiles.set(key, profile)
  }

  unregisterProfile(pattern: string): void {
    this.customProfiles.delete(pattern.trim().toLowerCase())
  }

  resolve(model?: string, provider?: string, override?: Partial<ModelCapabilityProfile>): ModelCapabilityProfile {
    const normProvider = (provider ?? 'openai').toLowerCase()
    const normModel = (model ?? '').toLowerCase()
    const custom = this.matchCustom(normProvider, normModel)
    const base = this.resolveBase(normModel, normProvider)
    return this.mergeProfile(base, custom, override)
  }

  private matchCustom(normProvider: string, normModel: string): Partial<ModelCapabilityProfile> | undefined {
    let best: { length: number; profile: Partial<ModelCapabilityProfile> } | undefined
    for (const [pattern, profile] of this.customProfiles) {
      if (!profileMatches(normProvider, normModel, pattern)) continue
      if (!best || pattern.length > best.length) best = { length: pattern.length, profile }
    }
    return best?.profile
  }

  private resolveBase(normModel: string, normProvider: string): ModelCapabilityProfile {
    if (normProvider === 'anthropic') {
      if (normModel.includes('claude-3-7') || normModel.includes('thinking')) {
        return { ...ANTHROPIC_THINKING_PROFILE, provider: normProvider, id: `anthropic:${normModel}` }
      }
      return { ...DEFAULT_ANTHROPIC_PROFILE, provider: normProvider, id: `anthropic:${normModel || 'default'}` }
    }

    // DeepSeek json_object mode follows the protocol id. A model name that
    // merely contains "deepseek" keeps the caller's structured-output contract.
    if (normProvider === 'deepseek') {
      return { ...DEEPSEEK_PROFILE, provider: normProvider, id: `deepseek:${normModel || 'default'}` }
    }

    if (normProvider === 'openai' || normProvider === 'openai-compatible') {
      if (isOpenAIReasoningModel(normModel)) {
        return { ...OPENAI_REASONING_PROFILE, provider: normProvider, id: `${normProvider}:${normModel}` }
      }
      return { ...DEFAULT_OPENAI_PROFILE, provider: normProvider, id: `${normProvider}:${normModel || 'default'}` }
    }

    return { ...DEFAULT_COMPATIBLE_PROFILE, provider: normProvider, id: `${normProvider}:${normModel || 'default'}` }
  }

  private mergeProfile(base: ModelCapabilityProfile, ...overrides: Array<Partial<ModelCapabilityProfile> | undefined>): ModelCapabilityProfile {
    let result = { ...base, constraints: { ...base.constraints } }
    for (const over of overrides) {
      if (!over) continue
      result = {
        ...result,
        ...over,
        constraints: {
          ...result.constraints,
          ...(over.constraints ?? {}),
        },
      }
    }
    return result
  }
}

export const capabilityRegistry = new CapabilityRegistry()

export function resolveModelCapability(model?: string, provider?: string, override?: Partial<ModelCapabilityProfile>): ModelCapabilityProfile {
  return capabilityRegistry.resolve(model, provider, override)
}

/** o1/o3 and their suffixed ids. `o10` and `gpt-4o` do not match. */
function isOpenAIReasoningModel(model: string): boolean {
  return /^o[13](?:$|[-_.])/.test(model)
}

function profileMatches(provider: string, model: string, pattern: string): boolean {
  if (!pattern) return false
  if (pattern === `${provider}:${model}`) return true
  return modelMatchesPattern(model, pattern)
}

function modelMatchesPattern(model: string, pattern: string): boolean {
  if (!pattern || !model) return false
  if (model === pattern) return true
  if (!model.startsWith(pattern)) return false
  const next = model.charAt(pattern.length)
  return next === '-' || next === '_' || next === '.' || next === '/' || next === ':'
}
