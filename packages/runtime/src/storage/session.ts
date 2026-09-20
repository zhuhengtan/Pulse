import type { AgentRecord, EffectRecord, JsonValue, LaneRecord, MergeProposal, ResultRecord, RuntimeEvent, RuntimeEventInput, RuntimeState, WaitRecord } from '../core/types.js'
import { createRuntimeState } from '../core/types.js'
import { normalizeRuntimeEvent } from '../core/events.js'

export interface SessionSnapshot {
  schemaVersion: 1
  state: {
    now: number
    agents: Array<[string, Omit<AgentRecord, 'globalVersions'> & { globalVersions: Array<[number, JsonValue]> }]>
    lanes: Array<[string, Omit<LaneRecord, 'children' | 'ownedEffectIds'> & { children: string[]; ownedEffectIds: string[] }]>
    effects: Array<[string, EffectRecord]>
    waits: Array<[string, WaitRecord]>
    results: Array<[string, ResultRecord]>
    mergeProposals: Array<[string, MergeProposal]>
    events: RuntimeEvent[]
    nextIds: RuntimeState['nextIds']
    maxTotalLanes: number
    maxQueuedEffects: number
    maxRunning: Record<'llm' | 'tool' | 'agent' | 'none', number | 'Infinity'>
    forkAffinity?: 'off' | 'advise'
    historySoftTokens?: number
    historyHardTokens?: number
  }
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
      agents: [...state.agents.entries()].map(([id, agent]) => [id, { ...agent, globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => [version, structuredClone(value)] as [number, JsonValue]) }] as [string, Omit<AgentRecord, 'globalVersions'> & { globalVersions: Array<[number, JsonValue]> }]),
      lanes: [...state.lanes.entries()].map(([id, lane]) => [id, { ...lane, children: [...lane.children], ownedEffectIds: [...lane.ownedEffectIds] }] as [string, Omit<LaneRecord, 'children' | 'ownedEffectIds'> & { children: string[]; ownedEffectIds: string[] }]),
      effects: [...state.effects.entries()].map(([id, effect]) => [id, structuredClone(effect)]),
      waits: [...state.waits.entries()].map(([id, wait]) => [id, structuredClone(wait)]),
      results: [...state.results.entries()].map(([id, result]) => [id, structuredClone(result)]),
      mergeProposals: [...state.mergeProposals.entries()].map(([id, proposal]) => [id, structuredClone(proposal)]),
      events: state.events.map((event) => normalizeRuntimeEvent(event as unknown as RuntimeEventInput, event.seq, { sessionId: event.sessionId, timestamp: event.timestamp })),
      nextIds: { ...state.nextIds },
      maxTotalLanes: state.maxTotalLanes,
      maxQueuedEffects: state.maxQueuedEffects,
      maxRunning: { llm: encodeNumber(state.maxRunning.llm), tool: encodeNumber(state.maxRunning.tool), agent: encodeNumber(state.maxRunning.agent), none: encodeNumber(state.maxRunning.none) },
      forkAffinity: state.forkAffinity,
      historySoftTokens: state.historySoftTokens,
      historyHardTokens: state.historyHardTokens,
    },
  }
}

export function serializeRuntimeState(state: RuntimeState): JsonValue { return exportRuntimeState(state) as unknown as JsonValue }

export function importRuntimeState(snapshot: SessionSnapshot | JsonValue): RuntimeState {
  const value = snapshot as SessionSnapshot
  if (!value || value.schemaVersion !== 1 || !value.state || !Array.isArray(value.state.agents) || !Array.isArray(value.state.lanes) || !Array.isArray(value.state.effects) || !Array.isArray(value.state.waits) || !Array.isArray(value.state.results) || !Array.isArray(value.state.events)) throw new Error('INVALID_SESSION_SNAPSHOT')
  const state = createRuntimeState(value.state.maxTotalLanes, { maxQueuedEffects: value.state.maxQueuedEffects, maxRunning: { llm: decodeNumber(value.state.maxRunning.llm), tool: decodeNumber(value.state.maxRunning.tool), agent: decodeNumber(value.state.maxRunning.agent), none: decodeNumber(value.state.maxRunning.none) }, forkAffinity: value.state.forkAffinity ?? 'off', ...(value.state.historySoftTokens === undefined ? {} : { historySoftTokens: value.state.historySoftTokens }), ...(value.state.historyHardTokens === undefined ? {} : { historyHardTokens: value.state.historyHardTokens }) })
  state.now = value.state.now
  state.nextIds = { ...value.state.nextIds, proposal: value.state.nextIds.proposal ?? 1 }
  for (const [id, agent] of value.state.agents) state.agents.set(id, { ...agent, globalVersions: new Map(agent.globalVersions.map(([version, context]) => [version, structuredClone(context)] as [number, JsonValue])) })
  for (const [id, lane] of value.state.lanes) state.lanes.set(id, { ...lane, children: new Set(lane.children), ownedEffectIds: new Set(lane.ownedEffectIds) })
  for (const [id, effect] of value.state.effects) state.effects.set(id, structuredClone(effect))
  for (const [id, wait] of value.state.waits) state.waits.set(id, structuredClone(wait))
  for (const [id, result] of value.state.results) state.results.set(id, structuredClone(result))
  for (const [id, proposal] of value.state.mergeProposals ?? []) state.mergeProposals.set(id, structuredClone(proposal))
  state.events = value.state.events.map((event) => normalizeRuntimeEvent(event as unknown as RuntimeEventInput, (event as RuntimeEvent).seq, { sessionId: (event as RuntimeEvent).sessionId, timestamp: (event as RuntimeEvent).timestamp }))
  return state
}
