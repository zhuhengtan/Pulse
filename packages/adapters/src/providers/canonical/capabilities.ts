import type { ModelCapabilityProfile, PromptCacheCapability } from './types.js'

export const DEFAULT_OPENAI_PROFILE: ModelCapabilityProfile = {
  id: 'openai-default',
  provider: 'openai',
  structuredOutput: 'native_strict',
  reasoning: 'effort_param',
  promptCache: 'openai_prompt_cache_key',
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
  promptCache: 'openai_prompt_cache_key',
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
  promptCache: 'anthropic_ephemeral',
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
  promptCache: 'anthropic_ephemeral',
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
  promptCache: 'none',
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
  promptCache: 'none',
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

    // A compatible transport does not imply strict JSON or reasoning parameter support.
    if (['ollama', 'ollama-cloud', 'ollama-remote'].includes(normProvider)) {
      return { ...DEFAULT_COMPATIBLE_PROFILE, provider: normProvider, id: `${normProvider}:${normModel || 'default'}`, structuredOutput: normProvider === 'ollama-cloud' || /(?:-cloud|:cloud)$/.test(normModel) ? 'unsupported' : 'native_strict', reasoning: 'effort_param' }
    }
    if (['minimax', 'zhipu', 'gemini', 'bailian', 'volcengine', 'moonshot', 'siliconflow', 'openrouter'].includes(normProvider)) {
      return { ...DEFAULT_COMPATIBLE_PROFILE, provider: normProvider, id: `${normProvider}:${normModel || 'default'}`, structuredOutput: normProvider === 'gemini' ? 'native_strict' : ['zhipu', 'bailian', 'moonshot'].includes(normProvider) ? 'json_object_only' : 'unsupported', reasoning: normProvider === 'minimax' && /m3/i.test(normModel) ? 'effort_param' : 'unsupported' }
    }

    if (normProvider === 'openai' || normProvider === 'openai-compatible') {
      const base = isOpenAIReasoningModel(normModel) ? OPENAI_REASONING_PROFILE : DEFAULT_OPENAI_PROFILE
      const profile = { ...base, provider: normProvider, id: `${normProvider}:${normModel || 'default'}` }
      return normProvider === 'openai-compatible' ? { ...profile, promptCache: 'none' } : profile
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

export function resolveModelCapability(model?: string, provider?: string, override?: Partial<ModelCapabilityProfile>, baseURL?: string): ModelCapabilityProfile {
  const profile = capabilityRegistry.resolve(model, provider, override)
  const promptCache = promptCacheForTransport(profile, { provider, baseURL, explicit: override?.promptCache })
  return promptCache === profile.promptCache ? profile : { ...profile, promptCache }
}

/** Official hosts keep their profile cache. A compatible name or any other host does not. An explicit capabilityProfile.promptCache still wins. */
export function promptCacheForTransport(profile: ModelCapabilityProfile, input: { provider?: string | undefined; baseURL?: string | undefined; explicit?: PromptCacheCapability | undefined }): PromptCacheCapability {
  if (input.explicit) return input.explicit
  const provider = (input.provider ?? profile.provider).toLowerCase()
  const profileCache = profile.promptCache ?? 'none'
  if (provider === 'openai-compatible') return 'none'
  if (input.baseURL === undefined) return profileCache
  let host = ''
  try { host = new URL(input.baseURL).hostname.toLowerCase() } catch { return 'none' }
  if (provider === 'openai' && host === 'api.openai.com') return profileCache
  if (provider === 'anthropic' && host === 'api.anthropic.com') return profileCache
  if (provider === 'openai' || provider === 'anthropic') return 'none'
  return profileCache
}

/** Reasoning model families use completion-token budgets, including their dated aliases. */
function isOpenAIReasoningModel(model: string): boolean {
  return /^(?:o[134]|gpt-[56](?:\.\d+)?)(?:$|[-_.])/.test(model)
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
