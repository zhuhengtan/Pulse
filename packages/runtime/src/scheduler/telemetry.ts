import type { JsonValue, RuntimeState } from '../core/types.js'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

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

export interface RuntimeTelemetryEnvelope {
  schemaVersion: 1
  timestamp: number
  snapshot: RuntimeTelemetrySnapshot
}

export interface RuntimeTelemetryExporter {
  publish(envelope: RuntimeTelemetryEnvelope): Promise<void> | void
}

export interface RuntimeTelemetryAlertRule {
  id: string
  metric: string
  threshold: number
  direction: 'above' | 'below'
  cooldownMs?: number
}

export interface RuntimeTelemetryAlert {
  ruleId: string
  metric: string
  value: number
  threshold: number
  direction: RuntimeTelemetryAlertRule['direction']
  timestamp: number
}

export interface RuntimeTelemetryAggregateSnapshot {
  schemaVersion: 1
  sampleCount: number
  firstTimestamp?: number
  lastTimestamp?: number
  latest?: RuntimeTelemetryEnvelope
  peaks: Record<string, number>
  alerts: RuntimeTelemetryAlert[]
}

function metricValue(snapshot: RuntimeTelemetrySnapshot, path: string): number | undefined {
  let current: unknown = snapshot
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined
}

/** Aggregates exported samples without retaining the full telemetry stream in Runtime state. */
export class RuntimeTelemetryAggregator {
  private sampleCount = 0
  private firstTimestamp: number | undefined
  private lastTimestamp: number | undefined
  private latest: RuntimeTelemetryEnvelope | undefined
  private readonly peaks = new Map<string, number>()
  private readonly alerts: RuntimeTelemetryAlert[] = []
  private readonly lastAlertAt = new Map<string, number>()
  constructor(readonly rules: readonly RuntimeTelemetryAlertRule[] = []) {}
  ingest(envelope: RuntimeTelemetryEnvelope): RuntimeTelemetryAlert[] {
    if (envelope.schemaVersion !== 1 || !Number.isFinite(envelope.timestamp)) throw new Error('INVALID_TELEMETRY_ENVELOPE')
    const emitted: RuntimeTelemetryAlert[] = []
    this.sampleCount++
    this.firstTimestamp ??= envelope.timestamp
    this.lastTimestamp = envelope.timestamp
    this.latest = structuredClone(envelope)
    for (const rule of this.rules) {
      const value = metricValue(envelope.snapshot, rule.metric)
      if (value === undefined) continue
      this.peaks.set(rule.metric, Math.max(this.peaks.get(rule.metric) ?? Number.NEGATIVE_INFINITY, value))
      const matched = rule.direction === 'above' ? value >= rule.threshold : value <= rule.threshold
      const last = this.lastAlertAt.get(rule.id)
      if (!matched || (last !== undefined && envelope.timestamp - last < (rule.cooldownMs ?? 0))) continue
      const alert: RuntimeTelemetryAlert = { ruleId: rule.id, metric: rule.metric, value, threshold: rule.threshold, direction: rule.direction, timestamp: envelope.timestamp }
      this.lastAlertAt.set(rule.id, envelope.timestamp)
      this.alerts.push(alert)
      emitted.push(alert)
    }
    return emitted
  }
  snapshot(): RuntimeTelemetryAggregateSnapshot {
    return { schemaVersion: 1, sampleCount: this.sampleCount, ...(this.firstTimestamp === undefined ? {} : { firstTimestamp: this.firstTimestamp }), ...(this.lastTimestamp === undefined ? {} : { lastTimestamp: this.lastTimestamp }), ...(this.latest === undefined ? {} : { latest: structuredClone(this.latest) }), peaks: Object.fromEntries(this.peaks.entries()), alerts: structuredClone(this.alerts) }
  }
}

/** A durable, append-only exporter suitable for a local host or sidecar collector. */
export class FileRuntimeTelemetryExporter implements RuntimeTelemetryExporter {
  private pending: Promise<void> = Promise.resolve()
  constructor(readonly filePath: string) {}
  async publish(envelope: RuntimeTelemetryEnvelope): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const handle = await open(this.filePath, 'a', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}

export interface HttpRuntimeTelemetryExporterOptions {
  endpoint: string
  headers?: Record<string, string>
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/** Sends complete envelopes to an external collector without changing Runtime state. */
export class HttpRuntimeTelemetryExporter implements RuntimeTelemetryExporter {
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetcher: typeof globalThis.fetch
  constructor(options: HttpRuntimeTelemetryExporterOptions) {
    if (!options.endpoint) throw new Error('TELEMETRY_ENDPOINT_REQUIRED')
    this.endpoint = options.endpoint
    this.headers = { 'content-type': 'application/json', ...(options.headers ?? {}) }
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('INVALID_TELEMETRY_TIMEOUT')
    this.fetcher = options.fetch ?? globalThis.fetch
  }
  async publish(envelope: RuntimeTelemetryEnvelope): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(this.endpoint, { method: 'POST', headers: this.headers, body: JSON.stringify(envelope), signal: controller.signal })
      if (!response.ok) throw new Error(`TELEMETRY_HTTP_${response.status}`)
    } catch (cause) {
      if (controller.signal.aborted) throw new Error('TELEMETRY_HTTP_TIMEOUT')
      throw cause
    } finally { clearTimeout(timer) }
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
