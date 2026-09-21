import type { AgentRecord, ArtifactRecord, EffectRecord, JsonValue, LaneRecord, MergeProposal, PrivacyLabel, PrivacyMetadata, ResultRecord, RuntimeEvent, RuntimeEventInput, RuntimeState, WaitRecord, ToolCallCorrelation } from '../core/types.js'
import { privacyRank } from '../core/types.js'
import { createRuntimeState } from '../core/types.js'
import { normalizeRuntimeEvent } from '../core/events.js'

export interface SessionSnapshot {
  schemaVersion: 1
  state: {
    now: number
    agents: Array<[string, Omit<AgentRecord, 'globalVersions' | 'globalPrivacy'> & { globalVersions: Array<[number, JsonValue]>; globalPrivacy?: Array<[number, PrivacyMetadata]> }]>
    lanes: Array<[string, Omit<LaneRecord, 'children' | 'ownedEffectIds' | 'visibleResultRefs'> & { children: string[]; ownedEffectIds: string[]; visibleResultRefs?: string[] }]>
    effects: Array<[string, EffectRecord]>
    waits: Array<[string, WaitRecord]>
    results: Array<[string, ResultRecord]>
    artifacts?: Array<[string, ArtifactRecord]>
    toolCallCorrelations?: Array<[string, ToolCallCorrelation]>
    mergeProposals: Array<[string, MergeProposal]>
    events: RuntimeEvent[]
    eventsCompactedThrough?: number
    nextIds: RuntimeState['nextIds']
    maxTotalLanes: number
    maxQueuedEffects: number
    maxRunning: Record<'llm' | 'tool' | 'agent' | 'none', number | 'Infinity'>
    forkAffinity?: 'off' | 'advise' | 'coalesce'
    historySoftTokens?: number
    historyHardTokens?: number
    maxResultSummaryBytes?: number
    trustedSanitizerIds?: string[]
  }
}

export interface RuntimeWarmStartSnapshot {
  schemaVersion: 1
  sessionId: string
  agent: {
    rootLaneId: string
    latestGlobalVersion: number
    globalVersions: Array<[number, JsonValue]>
    globalPrivacy?: Array<[number, PrivacyMetadata]>
  }
  visibleResultRefs: string[]
  results: Array<[string, ResultRecord]>
}

export interface RuntimeSessionStore {
  get(sessionId: string): RuntimeWarmStartSnapshot | undefined
  put(snapshot: RuntimeWarmStartSnapshot): void
}

export class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly snapshots = new Map<string, RuntimeWarmStartSnapshot>()
  get(sessionId: string): RuntimeWarmStartSnapshot | undefined { const snapshot = this.snapshots.get(sessionId); return snapshot === undefined ? undefined : structuredClone(snapshot) }
  put(snapshot: RuntimeWarmStartSnapshot): void { this.snapshots.set(snapshot.sessionId, structuredClone(snapshot)) }
}

export interface SessionLogExportOptions { maxPrivacy?: PrivacyLabel }
export type SessionLogResult = Omit<ResultRecord, 'value' | 'summary'> & { value?: JsonValue; summary?: JsonValue; redacted?: boolean }
export type SessionLogArtifact = Omit<ArtifactRecord, 'contentBase64'> & { contentBase64?: string; redacted?: boolean }
export interface SessionLogExport {
  schemaVersion: 1
  maxPrivacy: PrivacyLabel
  events: RuntimeEvent[]
  results: SessionLogResult[]
  artifacts: SessionLogArtifact[]
}

function encodeNumber(value: number): number | 'Infinity' { return Number.isFinite(value) ? value : 'Infinity' }
function decodeNumber(value: unknown): number {
  if (value === 'Infinity') return Number.POSITIVE_INFINITY
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error('INVALID_SESSION_SNAPSHOT')
  return value
}

export function exportRuntimeState(state: RuntimeState): SessionSnapshot {
  return {
    schemaVersion: 1,
    state: {
      now: state.now,
      agents: [...state.agents.entries()].map(([id, agent]) => [id, { ...agent, globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, JsonValue]), ...(agent.globalPrivacy === undefined ? {} : { globalPrivacy: [...agent.globalPrivacy.entries()].map(([version, metadata]) => [version, structuredClone(metadata)] as [number, PrivacyMetadata]) }) }] as [string, Omit<AgentRecord, 'globalVersions' | 'globalPrivacy'> & { globalVersions: Array<[number, JsonValue]>; globalPrivacy?: Array<[number, PrivacyMetadata]> }]),
      lanes: [...state.lanes.entries()].map(([id, lane]) => [id, { ...structuredClone(lane), children: [...lane.children], ownedEffectIds: [...lane.ownedEffectIds], ...(lane.visibleResultRefs === undefined ? {} : { visibleResultRefs: [...lane.visibleResultRefs] }) }] as [string, Omit<LaneRecord, 'children' | 'ownedEffectIds' | 'visibleResultRefs'> & { children: string[]; ownedEffectIds: string[]; visibleResultRefs?: string[] }]),
      effects: [...state.effects.entries()].map(([id, effect]) => [id, structuredClone(effect)]),
      waits: [...state.waits.entries()].map(([id, wait]) => [id, structuredClone(wait)]),
      results: [...state.results.entries()].map(([id, result]) => [id, structuredClone(result)]),
      artifacts: [...state.artifacts.entries()].map(([ref, artifact]) => [ref, structuredClone(artifact)]),
      toolCallCorrelations: [...state.toolCallCorrelations.entries()].map(([id, correlation]) => [id, structuredClone(correlation)]),
      mergeProposals: [...state.mergeProposals.entries()].map(([id, proposal]) => [id, structuredClone(proposal)]),
      events: state.events.map((event) => normalizeRuntimeEvent(event as unknown as RuntimeEventInput, event.seq, { sessionId: event.sessionId, timestamp: event.timestamp })),
      ...(state.eventsCompactedThrough === undefined ? {} : { eventsCompactedThrough: state.eventsCompactedThrough }),
      nextIds: { ...state.nextIds },
      maxTotalLanes: state.maxTotalLanes,
      maxQueuedEffects: state.maxQueuedEffects,
      maxRunning: { llm: encodeNumber(state.maxRunning.llm), tool: encodeNumber(state.maxRunning.tool), agent: encodeNumber(state.maxRunning.agent), none: encodeNumber(state.maxRunning.none) },
      forkAffinity: state.forkAffinity,
      historySoftTokens: state.historySoftTokens,
      historyHardTokens: state.historyHardTokens,
      maxResultSummaryBytes: state.maxResultSummaryBytes,
      trustedSanitizerIds: [...state.trustedSanitizerIds].sort(),
    },
  }
}

export function exportWarmStartSession(state: RuntimeState, sessionId: string): RuntimeWarmStartSnapshot {
  const agent = state.agents.get(sessionId)
  if (!agent) throw new Error(`WARM_START_SOURCE_NOT_FOUND:${sessionId}`)
  const root = state.lanes.get(agent.rootLaneId)
  const laneIds = new Set([...state.lanes.values()].filter((lane) => lane.agentId === sessionId).map((lane) => lane.id))
  const effectIds = new Set([...state.effects.values()].filter((effect) => effect.agentId === sessionId).map((effect) => effect.id))
  const results = [...state.results.entries()].filter(([ref, result]) => (root?.visibleResultRefs?.has(ref) ?? false) || (result.effectId !== undefined && effectIds.has(result.effectId)) || (result.producer?.kind === 'lane' && laneIds.has(result.producer.id)) || (result.producer?.kind === 'effect' && effectIds.has(result.producer.id))).map(([ref, result]) => [ref, structuredClone(result)] as [string, ResultRecord])
  return {
    schemaVersion: 1,
    sessionId,
    agent: {
      rootLaneId: agent.rootLaneId,
      latestGlobalVersion: agent.latestGlobalVersion,
      globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, JsonValue]),
      ...(agent.globalPrivacy === undefined ? {} : { globalPrivacy: [...agent.globalPrivacy.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, PrivacyMetadata]) }),
    },
    visibleResultRefs: [...(root?.visibleResultRefs ?? [])],
    results,
  }
}

function relatedEventPrivacy(state: RuntimeState, event: RuntimeEvent): PrivacyLabel {
  const labels: PrivacyLabel[] = []
  const effect = event.effectId === undefined ? undefined : state.effects.get(event.effectId)
  if (effect?.input && typeof effect.input === 'object' && !Array.isArray(effect.input)) {
    const inputPrivacy = (effect.input as Record<string, JsonValue>).privacy
    if (inputPrivacy === 'public' || inputPrivacy === 'cloud_allowed' || inputPrivacy === 'local_only') labels.push(inputPrivacy)
  }
  const resultRefs: string[] = []
  if (effect?.outcome?.resultRef !== undefined) resultRefs.push(effect.outcome.resultRef)
  if (event.type === 'lane.succeeded' && typeof event.data === 'string') resultRefs.push(event.data)
  if (event.type === 'privacy.downgraded' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const outputRef = (event.data as Record<string, JsonValue>).outputRef
    if (typeof outputRef === 'string') resultRefs.push(outputRef)
  }
  for (const ref of resultRefs) {
    const result = state.results.get(ref)
    if (result) labels.push(result.privacy)
  }
  return labels.length === 0 ? 'local_only' : labels.reduce<PrivacyLabel>((current, next) => privacyRank(next) > privacyRank(current) ? next : current, 'public')
}

function redactEvent(event: RuntimeEvent, privacy: PrivacyLabel): RuntimeEvent {
  return { ...structuredClone(event), payload: { redacted: true, privacy }, data: { redacted: true, privacy } }
}

/** Export audit/log data with an explicit privacy ceiling; this is not a recovery snapshot. */
export function exportRuntimeLog(state: RuntimeState, options: SessionLogExportOptions = {}): SessionLogExport {
  const maxPrivacy = options.maxPrivacy ?? 'public'
  const allowed = (privacy: PrivacyLabel): boolean => privacyRank(privacy) <= privacyRank(maxPrivacy)
  const results = [...state.results.values()].map((result) => {
    const copy = structuredClone(result)
    if (allowed(copy.privacy)) return copy
    const { value: _value, summary: _summary, ...metadata } = copy
    return { ...metadata, redacted: true }
  })
  const artifacts = [...state.artifacts.values()].map((artifact) => {
    const copy = structuredClone(artifact)
    if (allowed(copy.privacy)) return copy
    const { contentBase64: _content, ...metadata } = copy
    return { ...metadata, redacted: true }
  })
  const events = state.events.map((event) => {
    const privacy = relatedEventPrivacy(state, event)
    return allowed(privacy) ? structuredClone(event) : redactEvent(event, privacy)
  })
  return { schemaVersion: 1, maxPrivacy, events, results, artifacts }
}

export function serializeRuntimeState(state: RuntimeState): JsonValue { return exportRuntimeState(state) as unknown as JsonValue }

export function importRuntimeState(snapshot: SessionSnapshot | JsonValue): RuntimeState {
  const value = snapshot as SessionSnapshot
  if (!value || value.schemaVersion !== 1 || !value.state || !Array.isArray(value.state.agents) || !Array.isArray(value.state.lanes) || !Array.isArray(value.state.effects) || !Array.isArray(value.state.waits) || !Array.isArray(value.state.results) || !Array.isArray(value.state.events) || (value.state.eventsCompactedThrough !== undefined && (!Number.isInteger(value.state.eventsCompactedThrough) || value.state.eventsCompactedThrough < 0))) throw new Error('INVALID_SESSION_SNAPSHOT')
  const state = createRuntimeState(value.state.maxTotalLanes, { maxQueuedEffects: value.state.maxQueuedEffects, maxRunning: { llm: decodeNumber(value.state.maxRunning.llm), tool: decodeNumber(value.state.maxRunning.tool), agent: decodeNumber(value.state.maxRunning.agent), none: decodeNumber(value.state.maxRunning.none) }, forkAffinity: value.state.forkAffinity ?? 'advise', ...(value.state.historySoftTokens === undefined ? {} : { historySoftTokens: value.state.historySoftTokens }), ...(value.state.historyHardTokens === undefined ? {} : { historyHardTokens: value.state.historyHardTokens }), ...(value.state.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: value.state.maxResultSummaryBytes }), ...(value.state.trustedSanitizerIds === undefined ? {} : { trustedSanitizerIds: value.state.trustedSanitizerIds }) })
  state.now = value.state.now
  state.nextIds = { ...value.state.nextIds, artifact: value.state.nextIds.artifact ?? 1, proposal: value.state.nextIds.proposal ?? 1 }
  for (const [id, agent] of value.state.agents) {
    const { globalVersions, globalPrivacy, ...agentValue } = agent
    state.agents.set(id, { ...agentValue, globalVersions: new Map(globalVersions.map(([version, context]) => [version, structuredClone(context)] as [number, JsonValue])), ...(globalPrivacy === undefined ? {} : { globalPrivacy: new Map(globalPrivacy.map(([version, metadata]) => [version, structuredClone(metadata)] as [number, PrivacyMetadata])) }) })
  }
  for (const [id, lane] of value.state.lanes) {
    const { visibleResultRefs, ...laneValue } = lane
    state.lanes.set(id, { ...laneValue, children: new Set(lane.children), ownedEffectIds: new Set(lane.ownedEffectIds), ...(visibleResultRefs === undefined ? {} : { visibleResultRefs: new Set(visibleResultRefs) }) })
  }
  for (const [id, effect] of value.state.effects) state.effects.set(id, structuredClone(effect))
  for (const [id, wait] of value.state.waits) state.waits.set(id, structuredClone(wait))
  for (const [id, result] of value.state.results) state.results.set(id, { ...structuredClone(result), storageState: result.storageState ?? 'memory', pinCount: result.pinCount ?? 0 })
  for (const [ref, artifact] of value.state.artifacts ?? []) state.artifacts.set(ref, structuredClone(artifact))
  for (const [id, correlation] of value.state.toolCallCorrelations ?? []) state.toolCallCorrelations.set(id, structuredClone(correlation))
  for (const [id, proposal] of value.state.mergeProposals ?? []) state.mergeProposals.set(id, structuredClone(proposal))
  state.events = value.state.events.map((event) => normalizeRuntimeEvent(event as unknown as RuntimeEventInput, (event as RuntimeEvent).seq, { sessionId: (event as RuntimeEvent).sessionId, timestamp: (event as RuntimeEvent).timestamp }))
  if (value.state.eventsCompactedThrough !== undefined) state.eventsCompactedThrough = value.state.eventsCompactedThrough
  return state
}
