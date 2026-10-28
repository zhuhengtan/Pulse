export interface ModelDefinition {
  remote?: boolean
  tools?: 'supported' | 'unsupported' | 'unknown'
  structuredOutput?: 'supported' | 'unsupported' | 'unknown'
  discovery?: import('./providers/types.js').DiscoveredModel
  verification?: import('./providers/types.js').ProviderProbe & { checkedAt: string }
  displayName?: string
  modelCode: string
  maxContextTokens?: number
  maxOutputTokens?: number
  imageInput?: 'supported' | 'unsupported' | 'unknown'
  reasoningEffort?: 'low' | 'medium' | 'high'
  pricing?: { currency: string; inputPerMillion: number; outputPerMillion: number; version: string }
}

export interface ProviderDefinition {
  presetId?: string
  connectionVariant?: string
  credentialRef?: string
  provider: string
  name?: string
  baseURL?: string
  apiKeyEnv?: string
  maxContextTokens?: number
  maxOutputTokens?: number
  imageInput?: 'supported' | 'unsupported' | 'unknown'
  reasoningEffort?: 'low' | 'medium' | 'high'
  toolChoice?: unknown
  models?: Record<string, ModelDefinition>
  [key: string]: unknown
}

export type ModelConfig = Record<string, any>

export function modelSelectionId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

export function parseModelSelectionId(value: string): { providerId: string; modelId: string } | undefined {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) }
}

/** Normalize legacy flat model entries and inline feature models without mutating the caller's config. */
export function normalizeModelConfig<T extends Record<string, any>>(input: T): T {
  const config: ModelConfig = structuredClone(input)
  const providers: Record<string, any> = config.providers ?? (config.providers = {})
  const aliases = new Map<string, string[]>()
  const addAlias = (alias: unknown, id: string) => {
    if (typeof alias !== 'string' || !alias.trim()) return
    const current = aliases.get(alias) ?? []
    if (!current.includes(id)) current.push(id)
    aliases.set(alias, current)
  }

  for (const [providerId, provider] of Object.entries(providers) as Array<[string, any]>) {
    provider.models ??= {}
    for (const [modelId, model] of Object.entries(provider.models) as Array<[string, any]>) {
      const id = modelSelectionId(providerId, modelId)
      addAlias(id, id)
      addAlias(modelId, id)
      addAlias(model.displayName, id)
      addAlias(model.modelCode, id)
    }
  }

  for (const [legacyId, raw] of Object.entries(config.models ?? {}) as Array<[string, any]>) {
    const providerId = typeof raw.provider === 'string' ? raw.provider : ''
    if (!providerId) continue
    let provider = providers[providerId]
    if (!provider) continue
    provider.models ??= {}
    const modelId = legacyId
    if (!provider.models[modelId]) {
      const modelCode = typeof raw.modelCode === 'string' ? raw.modelCode : modelId
      provider.models[modelId] = {
        ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
        modelCode,
        ...(typeof raw.maxContextTokens === 'number' ? { maxContextTokens: raw.maxContextTokens } : {}),
        ...(typeof raw.maxOutputTokens === 'number' ? { maxOutputTokens: raw.maxOutputTokens } : {}),
        ...(raw.reasoningEffort === 'low' || raw.reasoningEffort === 'medium' || raw.reasoningEffort === 'high' ? { reasoningEffort: raw.reasoningEffort } : {}),
        ...(raw.imageInput === 'supported' || raw.imageInput === 'unsupported' || raw.imageInput === 'unknown' ? { imageInput: raw.imageInput } : {}),
        ...(raw.pricing && typeof raw.pricing === 'object' ? { pricing: raw.pricing as ModelDefinition['pricing'] } : {}),
      }
    }
    const id = modelSelectionId(providerId, modelId)
    addAlias(legacyId, id)
    addAlias(raw.displayName, id)
    addAlias(raw.modelCode, id)
  }

  const resolve = (value: unknown, legacyProvider?: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) return undefined
    if (parseModelSelectionId(value)) return value
    if (typeof legacyProvider === 'string' && providers[legacyProvider]) {
      const provider = providers[legacyProvider]!
      const direct = (Object.entries(provider.models ?? {}) as Array<[string, any]>).find(([modelId, model]) => modelId === value || model.modelCode === value)
      if (direct) return modelSelectionId(legacyProvider, direct[0])
    }
    const matches = aliases.get(value) ?? []
    return matches.length === 1 ? matches[0] : value
  }

  config.activeModel = resolve(config.activeModel)
  config.assistantModel = resolve(config.assistantModel)
  if (config.taskRouting && typeof config.taskRouting === 'object') {
    for (const [task, route] of Object.entries(config.taskRouting)) if (Array.isArray(route)) config.taskRouting[task] = route.map(item => resolve(item) ?? item)
  }

  for (const key of ['frontModel', 'approvalReview'] as const) {
    const feature = config[key]
    if (!feature || typeof feature !== 'object') continue
    const providerId = typeof feature.provider === 'string' ? feature.provider : key === 'approvalReview' ? 'ollama' : undefined
    const legacyModel = typeof feature.model === 'string' ? feature.model : undefined
    if (legacyModel && parseModelSelectionId(legacyModel)) {
      feature.model = resolve(legacyModel) ?? legacyModel
    } else if (legacyModel && providerId) {
      if (!providers[providerId]) {
        providers[providerId] = {
          provider: providerId,
          name: providerId === 'ollama' ? 'Ollama' : providerId,
          ...(typeof feature.baseURL === 'string' ? { baseURL: feature.baseURL } : {}),
          models: {},
        }
      }
      const provider = providers[providerId]!
      provider.models ??= {}
      const found = (Object.entries(provider.models) as Array<[string, any]>).find(([modelId, model]) => modelId === legacyModel || model.modelCode === legacyModel)
      if (!found) provider.models[legacyModel] = { modelCode: legacyModel, displayName: legacyModel }
      feature.model = modelSelectionId(providerId, found?.[0] ?? legacyModel)
    } else if (legacyModel) {
      feature.model = resolve(legacyModel) ?? legacyModel
    }
    delete feature.provider
    delete feature.baseURL
  }

  delete config.models
  return config as T
}

export function resolveModelSelection(config: ModelConfig, reference: string): { id: string; providerId: string; modelId: string; provider: ProviderDefinition; model: ModelDefinition } | undefined {
  const parsed = parseModelSelectionId(reference)
  if (!parsed) return undefined
  const provider = config.providers?.[parsed.providerId]
  const model = provider?.models?.[parsed.modelId]
  if (!provider || !model) return undefined
  return { id: reference, ...parsed, provider, model }
}

export function resolveModelReference(config: ModelConfig, reference: string): string {
  const direct = resolveModelSelection(config, reference)
  if (direct) return direct.id
  const matches: string[] = []
  for (const [providerId, provider] of Object.entries(config.providers ?? {}) as Array<[string, any]>) {
    for (const [modelId, model] of Object.entries(provider.models ?? {}) as Array<[string, any]>) {
      if (modelId === reference || model.displayName === reference || model.modelCode === reference) matches.push(modelSelectionId(providerId, modelId))
    }
  }
  const unique = [...new Set(matches)]
  if (unique.length === 1) return unique[0]!
  if (unique.length > 1) throw new Error(`AMBIGUOUS_MODEL_REFERENCE:${reference}:${unique.join(',')}`)
  throw new Error(`UNKNOWN_MODEL_REFERENCE:${reference}`)
}
