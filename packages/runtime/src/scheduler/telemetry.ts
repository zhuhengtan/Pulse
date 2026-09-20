import type { JsonValue, RuntimeState } from '../core/types.js'

export interface RuntimeTelemetryAttempt {
  effectId: string
  agentId: string | null
  laneId: string | null
  attemptId: string
  attemptNo: number
  modelId: string
  providerId: string
  slotWaitMs?: number
  usage?: JsonValue
}

export interface RuntimeTelemetrySnapshot {
  eventCounts: Record<string, number>
  agents: { total: number; byState: Record<string, number> }
  lanes: { total: number; byStatus: Record<string, number> }
  effects: { total: number; byState: Record<string, number>; byKind: Record<string, number> }
  llm: {
    effects: number
    metadataEvents: number
    attempts: RuntimeTelemetryAttempt[]
    routeRejections: Record<string, number>
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; uncachedInputTokens: number; latencyMs: number; costByCurrency: Record<string, number> }
  }
}

function count(target: Record<string, number>, key: string): void { target[key] = (target[key] ?? 0) + 1 }
function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

export function collectRuntimeTelemetry(state: RuntimeState): RuntimeTelemetrySnapshot {
  const eventCounts: Record<string, number> = {}
  for (const event of state.events) count(eventCounts, event.type)
  const agentStates: Record<string, number> = {}
  for (const agent of state.agents.values()) count(agentStates, agent.state ?? 'unknown')
  const laneStatuses: Record<string, number> = {}
  for (const lane of state.lanes.values()) count(laneStatuses, lane.status)
  const effectStates: Record<string, number> = {}
  const effectKinds: Record<string, number> = {}
  for (const effect of state.effects.values()) { count(effectStates, effect.state); count(effectKinds, effect.kind) }
  const attempts: RuntimeTelemetryAttempt[] = []
  const routeRejections: Record<string, number> = {}
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, latencyMs: 0, costByCurrency: {} as Record<string, number> }
  let metadataEvents = 0
  for (const event of state.events) {
    if (event.type !== 'effect.execution_metadata' || !event.effectId) continue
    metadataEvents++
    const metadata = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, JsonValue> : {}
    const routeList = Array.isArray(metadata.routes) ? metadata.routes : []
    for (const route of routeList) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) continue
      const item = route as Record<string, JsonValue>
      if (item.accepted === false && Array.isArray(item.reasons)) for (const reason of item.reasons) if (typeof reason === 'string') count(routeRejections, reason)
    }
    const recorded = Array.isArray(metadata.attempts) ? metadata.attempts : []
    const effect = state.effects.get(event.effectId)
    for (const item of recorded) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const value = item as Record<string, JsonValue>
      if (typeof value.attemptId !== 'string' || typeof value.attemptNo !== 'number' || typeof value.modelId !== 'string' || typeof value.providerId !== 'string') continue
      const attempt: RuntimeTelemetryAttempt = { effectId: event.effectId, agentId: effect?.agentId ?? null, laneId: effect?.ownerLaneId ?? null, attemptId: value.attemptId, attemptNo: value.attemptNo, modelId: value.modelId, providerId: value.providerId, ...(typeof value.slotWaitMs === 'number' ? { slotWaitMs: value.slotWaitMs } : {}), ...(value.usage === undefined ? {} : { usage: value.usage }) }
      attempts.push(attempt)
      const attemptUsage = value.usage
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'latencyMs'] as const) usage[field] += numberField(attemptUsage, field) ?? 0
      if (attemptUsage && typeof attemptUsage === 'object' && !Array.isArray(attemptUsage)) {
        const cost = (attemptUsage as Record<string, JsonValue>).cost
        if (cost && typeof cost === 'object' && !Array.isArray(cost)) {
          const amount = numberField(cost, 'amount')
          const currency = (cost as Record<string, JsonValue>).currency
          if (amount !== undefined && typeof currency === 'string') usage.costByCurrency[currency] = (usage.costByCurrency[currency] ?? 0) + amount
        }
      }
    }
  }
  return { eventCounts, agents: { total: state.agents.size, byState: agentStates }, lanes: { total: state.lanes.size, byStatus: laneStatuses }, effects: { total: state.effects.size, byState: effectStates, byKind: effectKinds }, llm: { effects: [...state.effects.values()].filter((effect) => effect.kind === 'llm').length, metadataEvents, attempts, routeRejections, usage } }
}
