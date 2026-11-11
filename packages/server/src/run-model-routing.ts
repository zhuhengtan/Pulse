import type { LocalHostOptions } from './index.js'
import { isReasoningEffort, routeEntry, type ReasoningEffort } from './model-settings.js'

/** A run owns its model order and effort choices. Connection credentials stay in host config. */
export function captureRunModelRouting(options: LocalHostOptions) {
  return {
    schemaVersion: 1,
    activeModel: options.activeModel,
    taskRouting: structuredClone(options.taskRouting ?? {}),
    modelEfforts: Object.fromEntries(Object.entries(options.providerModels ?? {}).map(([id, model]) => [id, model.reasoningEffort ?? null])),
    activeProviderEffort: options.provider?.reasoningEffort ?? null,
    providerEfforts: Object.fromEntries(Object.entries(options.providerProfiles ?? {}).map(([id, profile]) => [id, profile.reasoningEffort ?? null])),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RUN_MODEL_ROUTING_SNAPSHOT_INVALID')
  return value as Record<string, unknown>
}
function restoreEffort<T extends { reasoningEffort?: ReasoningEffort | undefined }>(value: T, saved: unknown): T {
  if (saved === undefined) return value
  const next = { ...value }
  if (saved === null) delete next.reasoningEffort
  else if (isReasoningEffort(saved)) next.reasoningEffort = saved
  else throw new Error('RUN_MODEL_ROUTING_SNAPSHOT_INVALID')
  return next
}

export function restoreRunModelRouting(options: LocalHostOptions, saved: unknown): LocalHostOptions {
  if (saved === undefined) return options
  const snapshot = record(saved)
  if (snapshot.schemaVersion !== 1 || snapshot.activeModel !== undefined && typeof snapshot.activeModel !== 'string') throw new Error('RUN_MODEL_ROUTING_SNAPSHOT_INVALID')
  const taskRouting: NonNullable<LocalHostOptions['taskRouting']> = {}
  const routes = record(snapshot.taskRouting)
  for (const task of ['reason', 'plan', 'merge', 'verify', 'vision'] as const) {
    const route = routes[task]
    if (route === undefined) continue
    if (!Array.isArray(route) || !route.length) throw new Error('RUN_MODEL_ROUTING_SNAPSHOT_INVALID')
    taskRouting[task] = route.map(item => routeEntry(item, model => model))
  }
  const modelEfforts = record(snapshot.modelEfforts), providerEfforts = record(snapshot.providerEfforts)
  const providerModels = Object.fromEntries(Object.entries(options.providerModels ?? {}).map(([id, model]) => [id, restoreEffort(model, Object.hasOwn(modelEfforts, id) ? modelEfforts[id] : undefined)]))
  const providerProfiles = Object.fromEntries(Object.entries(options.providerProfiles ?? {}).map(([id, profile]) => [id, restoreEffort(profile, Object.hasOwn(providerEfforts, id) ? providerEfforts[id] : undefined)]))
  const savedActive = snapshot.activeModel as string | undefined
  const activeModel = savedActive && (providerModels[savedActive] || !Object.hasOwn(modelEfforts, savedActive)) ? savedActive : options.activeModel
  const selection = activeModel ? providerModels[activeModel] : undefined
  for (const task of ['reason', 'plan', 'merge', 'verify', 'vision'] as const) {
    const route = taskRouting[task]?.filter(entry => providerModels[typeof entry === 'string' ? entry : entry.model] !== undefined || (typeof entry === 'string' ? entry : entry.model) === activeModel)
    if (route?.length) taskRouting[task] = route
    else if (route) { if (options.taskRouting?.[task]) taskRouting[task] = options.taskRouting[task]; else delete taskRouting[task] }
  }
  const activeProviderCode = selection?.provider ?? options.activeProviderCode ?? options.provider?.provider
  const currentProviderCode = options.activeProviderCode ?? options.provider?.provider
  const sameActiveModel = selection?.provider === currentProviderCode && selection?.model === options.provider?.defaultModel
  const profile = !selection || sameActiveModel ? options.provider : providerProfiles[selection.provider] ?? (selection.provider === currentProviderCode ? options.provider : undefined)
  if (selection && !profile) return { ...options, taskRouting: options.taskRouting ?? {} }
  const restoredProvider = profile ? restoreEffort(profile, snapshot.activeProviderEffort) : undefined
  return {
    ...options, providerModels, providerProfiles, taskRouting,
    ...(activeModel === undefined ? {} : { activeModel }),
    ...(activeProviderCode === undefined ? {} : { activeProviderCode }),
    ...(restoredProvider === undefined ? {} : { provider: { ...restoredProvider, ...(selection === undefined ? {} : {
      defaultModel: selection.model,
      ...(selection.maxContextTokens === undefined ? {} : { maxContextTokens: selection.maxContextTokens }),
      ...(selection.maxOutputTokens === undefined ? {} : { maxOutputTokens: selection.maxOutputTokens }),
    }) } }),
  }
}
