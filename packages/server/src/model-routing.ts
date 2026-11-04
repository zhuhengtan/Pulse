import { candidateOutputTokens, routeEntry, routeModelId, resolveReasoningSupport, type ModelRouteEntry, type ReasoningEffort } from './model-settings.js'
import { InMemoryModelRegistry, ModelRouter, type ModelCandidate } from '@hunterzhu/pulse-runtime'
import { createProviderAdapter, type ProviderAdapter, type ProviderPresetConfig } from '@hunterzhu/pulse-adapters'

export type HostModelTask = 'reason' | 'plan' | 'merge' | 'verify' | 'vision'

export interface HostModelRouteOptions {
  activeModel: string
  activeProviderCode?: string
  activeProvider: ProviderPresetConfig
  providerProfiles?: Record<string, ProviderPresetConfig>
  providerModels?: Record<string, { provider: string; model: string; remote?: boolean; tools?: 'supported' | 'unsupported' | 'unknown'; structuredOutput?: 'supported' | 'unsupported' | 'unknown'; maxContextTokens?: number; maxOutputTokens?: number; imageInput?: 'supported' | 'unsupported' | 'unknown'
  reasoningEffort?: ReasoningEffort; supportedReasoningEfforts?: ReasoningEffort[] }>
  taskRouting?: Partial<Record<HostModelTask, ModelRouteEntry[]>>
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
        : createProviderAdapter({ ...profile, continuationNamespace: selection.provider })
      providers.set(selection.provider, adapter)
    }
    const isActive = displayName === options.activeModel && selection.provider === activeCode
    const maxContextTokens = selection.maxContextTokens ?? profile.maxContextTokens ?? 32_000
    const maxOutputTokens = candidateOutputTokens(selection.maxOutputTokens ?? profile.maxOutputTokens ?? options.activeProvider.maxOutputTokens, maxContextTokens)
    const reasoningEffort = selection.reasoningEffort ?? profile.reasoningEffort
    const support = resolveReasoningSupport(profile.provider, selection.model, selection.supportedReasoningEfforts)
    const reasoning = support.verified ? support.levels.some(level => level === 'high' || level === 'xhigh' || level === 'max') ? 'high' : support.levels.includes('medium') ? 'medium' : 'low' : 'medium'
    candidates.push({
      id: displayName,
      providerId: selection.provider,
      tasks: ['reason', 'plan', 'merge', 'verify', 'vision'],
      priority: isActive ? 100 : 10,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(selection.supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts: selection.supportedReasoningEfforts }),
      capabilities: {
        imageInput: selection.imageInput === 'supported',
        toolCalling: selection.tools !== 'unsupported',
        structuredOutput: true,
        reasoning,
        maxContextTokens,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
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
      releaseConnectionScope: scope => { adapter.releaseConnectionScope?.(scope); for (const child of modelAdapters.values()) child.releaseConnectionScope?.(scope) },
      dispose: () => { adapter.dispose?.(); for (const child of modelAdapters.values()) child.dispose?.(); modelAdapters.clear() },
      executeAttempt: (params) => {
        const selection = params.model ? providerModels[params.model] : undefined
        let selectedAdapter = adapter
        if (selection?.structuredOutput === 'unsupported' || selection?.remote) {
          selectedAdapter = modelAdapters.get(params.model!) ?? createProviderAdapter({ ...profiles[providerCode]!, continuationNamespace: providerCode, ...(selection.remote ? { remote: true } : {}), ...(selection.structuredOutput === 'unsupported' ? { capabilityProfile: { ...profiles[providerCode]?.capabilityProfile, structuredOutput: 'unsupported' as const } } : {}) })
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
    const entries = configured === undefined ? [options.activeModel] : configured.map(item => routeEntry(item, model => model))
    const route = entries.map(routeModelId)
    if (route.length === 0) throw new Error(`EMPTY_MODEL_ROUTE:${task}`)
    if (new Set(route).size !== route.length) throw new Error(`DUPLICATE_MODEL_ROUTE_CANDIDATE:${task}`)
    const reasoningEfforts: Record<string, ReasoningEffort> = Object.create(null)
    for (const entry of entries) {
      const id = routeModelId(entry), selected = providerModels[id]
      if (!selected || !modelCodeById.has(id)) throw new Error(`UNKNOWN_MODEL_ROUTE_CANDIDATE:${task}:${id}`)
      if (typeof entry === 'string' || entry.reasoningEffort === undefined) continue
      const support = resolveReasoningSupport(profiles[selected.provider]!.provider, selected.model, selected.supportedReasoningEfforts)
      if (!support.levels.includes(entry.reasoningEffort)) throw new Error(`MODEL_ROUTE_REASONING_UNSUPPORTED:${task}:${id}:${entry.reasoningEffort}`)
      reasoningEfforts[id] = entry.reasoningEffort
    }
    router.register({ task, candidates: route, reasoningEfforts })
  }
  return { models, router, providers, candidates }
}
