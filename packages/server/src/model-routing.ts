import { InMemoryModelRegistry, ModelRouter, type ModelCandidate } from '@hunterzhu/pulse-runtime'
import { createProviderAdapter, type ProviderAdapter, type ProviderPresetConfig } from '@hunterzhu/pulse-adapters'

export type HostModelTask = 'reason' | 'plan' | 'merge' | 'verify' | 'vision'

export interface HostModelRouteOptions {
  activeModel: string
  activeProviderCode?: string
  activeProvider: ProviderPresetConfig
  providerProfiles?: Record<string, ProviderPresetConfig>
  providerModels?: Record<string, { provider: string; model: string; remote?: boolean; tools?: 'supported' | 'unsupported' | 'unknown'; structuredOutput?: 'supported' | 'unsupported' | 'unknown'; maxContextTokens?: number; maxOutputTokens?: number; imageInput?: 'supported' | 'unsupported' | 'unknown'
  reasoningEffort?: 'low' | 'medium' | 'high' }>
  taskRouting?: Partial<Record<HostModelTask, string[]>>
  /** Reuse the active provider instance (notably the scripted Mock adapter). */
  activeAdapter?: ProviderAdapter
}

export interface HostModelRouting {
  models: InMemoryModelRegistry
  router: ModelRouter
  providers: Map<string, ProviderAdapter>
  candidates: ModelCandidate[]
}

export function isLocalModelProvider(profile: ProviderPresetConfig, model = profile.defaultModel): boolean {
  if (profile.provider === 'mock') return true
  if (profile.provider !== 'ollama' || profile.remote || /(?:-cloud|:cloud)$/.test(model ?? '')) return false
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.baseURL ?? 'http://127.0.0.1:11434').hostname) } catch { return false }
}

/** Build deterministic per-task candidate lists from the user's named model catalog. */
export function createHostModelRouting(options: HostModelRouteOptions): HostModelRouting {
  const profiles = { ...(options.providerProfiles ?? {}) }
  const activeCode = options.activeProviderCode ?? options.activeProvider.provider
  profiles[activeCode] ??= options.activeProvider

  const providerModels = { ...(options.providerModels ?? {}) }
  providerModels[options.activeModel] ??= {
    provider: activeCode,
    model: options.activeProvider.defaultModel ?? options.activeModel,
  }

  const providers = new Map<string, ProviderAdapter>()
  const modelCodeById = new Map<string, string>()
  const candidates: ModelCandidate[] = []

  for (const [displayName, selection] of Object.entries(providerModels)) {
    const profile = profiles[selection.provider]
    if (!profile) throw new Error(`MODEL_PROVIDER_NOT_FOUND:${selection.provider}`)
    if (!displayName.trim() || !selection.model.trim()) throw new Error(`INVALID_MODEL_SELECTION:${displayName}`)
    let adapter = providers.get(selection.provider)
    if (!adapter) {
      adapter = selection.provider === activeCode && options.activeAdapter
        ? options.activeAdapter
        : createProviderAdapter(profile)
      providers.set(selection.provider, adapter)
    }
    const isActive = displayName === options.activeModel && selection.provider === activeCode
    const maxContextTokens = selection.maxContextTokens ?? profile.maxContextTokens ?? options.activeProvider.maxContextTokens ?? 32_000
    const maxOutputTokens = selection.maxOutputTokens ?? profile.maxOutputTokens ?? options.activeProvider.maxOutputTokens ?? 4_096
    const requestedReasoning = selection.reasoningEffort ?? profile.reasoningEffort ?? 'medium'
    candidates.push({
      id: displayName,
      providerId: selection.provider,
      tasks: ['reason', 'plan', 'merge', 'verify', 'vision'],
      priority: isActive ? 100 : 10,
      capabilities: {
        imageInput: selection.imageInput === 'supported',
        toolCalling: selection.tools !== 'unsupported',
        structuredOutput: true,
        reasoning: requestedReasoning === 'none' ? 'low' : requestedReasoning,
        maxContextTokens,
        maxOutputTokens,
        local: selection.remote !== true && isLocalModelProvider(profile, selection.model),
      },
    })
    modelCodeById.set(displayName, selection.model)
  }

  if (!candidates.some((candidate) => candidate.id === options.activeModel)) {
    throw new Error(`ACTIVE_MODEL_NOT_REGISTERED:${options.activeModel}`)
  }

  // ProviderAdapter's model field is the provider-specific model code. The
  // Runtime routes using the user's stable display name, so translate at the
  // provider boundary while preserving cancellation and streaming callbacks.
  for (const [providerCode, adapter] of providers) {
    const modelAdapters = new Map<string, ProviderAdapter>()
    const translated: ProviderAdapter = {
      id: providerCode,
      name: adapter.name,
      executeAttempt: (params) => {
        const selection = params.model ? providerModels[params.model] : undefined
        let selectedAdapter = adapter
        if (selection?.structuredOutput === 'unsupported' || selection?.remote) {
          selectedAdapter = modelAdapters.get(params.model!) ?? createProviderAdapter({ ...profiles[providerCode]!, ...(selection.remote ? { remote: true } : {}), ...(selection.structuredOutput === 'unsupported' ? { capabilityProfile: { structuredOutput: 'unsupported' as const } } : {}) })
          modelAdapters.set(params.model!, selectedAdapter)
        }
        let request = params.request
        if (selection?.tools === 'unsupported') {
          const { providerHistory: _history, ...contextSpec } = request.contextSpec
          request = { ...request, contextSpec, blocks: request.blocks.filter(block => block.kind !== 'tools' && block.kind !== 'provider_history') }
        }
        return selectedAdapter.executeAttempt({ ...params, request, ...(params.model === undefined ? {} : { model: modelCodeById.get(params.model) ?? params.model }) })
      },
    }
    providers.set(providerCode, translated)
  }

  const models = new InMemoryModelRegistry()
  for (const candidate of candidates) models.register(candidate)
  const router = new ModelRouter(models)
  const routes = options.taskRouting ?? {}
  for (const task of ['reason', 'plan', 'merge', 'verify', 'vision'] as const) {
    const configured = routes[task]
    const route = configured === undefined ? [options.activeModel] : [...configured]
    if (route.length === 0) throw new Error(`EMPTY_MODEL_ROUTE:${task}`)
    if (new Set(route).size !== route.length) throw new Error(`DUPLICATE_MODEL_ROUTE_CANDIDATE:${task}`)
    for (const model of route) if (!modelCodeById.has(model)) throw new Error(`UNKNOWN_MODEL_ROUTE_CANDIDATE:${task}:${model}`)
    router.register({ task, candidates: route })
  }
  return { models, router, providers, candidates }
}
