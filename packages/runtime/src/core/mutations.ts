import type { RuntimeEventInput, RuntimeState, RuntimeError, ContextVersion, JsonValue, AgentRecord, LaneRecord, EffectRecord, WaitRecord, ResultRecord, FindingRecord, ArtifactRecord, ContextDelta, LaneId, WaitId, EffectId, HistoryRecord, MergeProposal, ToolCallCorrelation, PrivacyMetadata } from './types.js'
import { appendRuntimeEvent } from './events.js'

export type Mutation =
  | { op: 'setAgent'; agentId: string; record: AgentRecord }
  | { op: 'setLane'; laneId: LaneId; record: LaneRecord }
  | { op: 'setEffect'; effectId: EffectId; record: EffectRecord }
  | { op: 'setWait'; waitId: WaitId; record: WaitRecord }
  | { op: 'insertLane'; record: LaneRecord }
  | { op: 'insertEffect'; record: EffectRecord }
  | { op: 'insertWait'; record: WaitRecord }
  | { op: 'publishResult'; record: ResultRecord }
  | { op: 'publishFinding'; record: FindingRecord }
  | { op: 'publishArtifact'; record: ArtifactRecord }
  | { op: 'setToolCallCorrelation'; record: ToolCallCorrelation }
  | { op: 'insertMergeProposal'; proposal: MergeProposal }
  | { op: 'removeMergeProposal'; proposalId: string }
  | { op: 'setGlobal'; agentId: string; version: ContextVersion; value: JsonValue; metadata?: PrivacyMetadata }
  | { op: 'setLaneContext'; laneId: LaneId; value: JsonValue; version: ContextVersion; history?: HistoryRecord[]; metadata?: PrivacyMetadata }
  | { op: 'setNextIds'; nextIds: RuntimeState['nextIds'] }
  | { op: 'appendEvent'; event: RuntimeEventInput }
  | { op: 'setNow'; now: number }

export interface ValidationSuccess { mutations: Mutation[] }
export interface ValidationFailure { rejection: RuntimeError }
export type ValidationResult = ValidationSuccess | ValidationFailure

/** Shallow-fork maps and clone only records `apply()` mutates in place. */
export function forkRuntimeStateForAdmission(state: RuntimeState, mutations: Mutation[]): RuntimeState {
  const dirtyAgents = new Set<string>()
  const dirtyLanes = new Set<string>()
  for (const mutation of mutations) {
    if (mutation.op === 'setGlobal') dirtyAgents.add(mutation.agentId)
    else if (mutation.op === 'setLaneContext') dirtyLanes.add(mutation.laneId)
    else if (mutation.op === 'publishFinding') dirtyLanes.add(mutation.record.laneId)
  }
  const agents = new Map(state.agents)
  const lanes = new Map(state.lanes)
  for (const id of dirtyAgents) {
    const agent = agents.get(id)
    if (agent) agents.set(id, { ...agent, globalVersions: new Map(agent.globalVersions), ...(agent.globalPrivacy === undefined ? {} : { globalPrivacy: new Map(agent.globalPrivacy) }) })
  }
  for (const id of dirtyLanes) {
    const lane = lanes.get(id)
    if (lane) lanes.set(id, { ...lane, ...(lane.visibleResultRefs === undefined ? {} : { visibleResultRefs: new Set(lane.visibleResultRefs) }) })
  }
  return {
    ...state,
    agents,
    lanes,
    effects: new Map(state.effects),
    waits: new Map(state.waits),
    results: new Map(state.results),
    artifacts: new Map(state.artifacts),
    toolCallCorrelations: new Map(state.toolCallCorrelations),
    mergeProposals: new Map(state.mergeProposals),
    events: state.events.slice(),
    nextIds: { ...state.nextIds },
    trustedSanitizerIds: new Set(state.trustedSanitizerIds),
  }
}

export function apply(state: RuntimeState, mutations: Mutation[], defaults: { sessionId?: string; timestamp?: number } = {}): void {
  for (const mutation of mutations) {
    switch (mutation.op) {
      case 'setAgent': state.agents.set(mutation.agentId, mutation.record); break
      case 'setLane': state.lanes.set(mutation.laneId, mutation.record); break
      case 'setEffect': state.effects.set(mutation.effectId, mutation.record); break
      case 'setWait': state.waits.set(mutation.waitId, mutation.record); break
      case 'insertLane': state.lanes.set(mutation.record.id, mutation.record); break
      case 'insertEffect': state.effects.set(mutation.record.id, mutation.record); break
      case 'insertWait': state.waits.set(mutation.record.id, mutation.record); break
      case 'publishResult': {
        state.results.set(mutation.record.id, mutation.record)
        const match = /^result-(\d+)$/.exec(mutation.record.id)
        if (match) state.nextIds.result = Math.max(state.nextIds.result, Number(match[1]) + 1)
        break
      }
      case 'publishFinding': {
        state.results.set(mutation.record.id, mutation.record)
        const lane = state.lanes.get(mutation.record.laneId)
        if (lane?.visibleResultRefs) lane.visibleResultRefs.add(mutation.record.id)
        else if (lane) lane.visibleResultRefs = new Set([mutation.record.id])
        const match = /^finding-(\d+)$/.exec(mutation.record.id)
        if (match) state.nextIds.result = Math.max(state.nextIds.result, Number(match[1]) + 1)
        break
      }
      case 'publishArtifact': {
        state.artifacts.set(mutation.record.ref, mutation.record)
        const match = /^artifact-(\d+)$/.exec(mutation.record.ref)
        if (match) state.nextIds.artifact = Math.max(state.nextIds.artifact, Number(match[1]) + 1)
        break
      }
      case 'setToolCallCorrelation': state.toolCallCorrelations.set(mutation.record.toolCallId, mutation.record); break
      case 'insertMergeProposal': state.mergeProposals.set(mutation.proposal.id, mutation.proposal); break
      case 'removeMergeProposal': state.mergeProposals.delete(mutation.proposalId); break
      case 'setGlobal': { const agent = state.agents.get(mutation.agentId)!; agent.globalVersions.set(mutation.version, mutation.value); if (mutation.metadata) { if (!agent.globalPrivacy) agent.globalPrivacy = new Map(); agent.globalPrivacy.set(mutation.version, structuredClone(mutation.metadata)) } agent.latestGlobalVersion = mutation.version; break }
      case 'setLaneContext': { const lane = state.lanes.get(mutation.laneId)!; lane.context = { ...lane.context, state: mutation.value, version: mutation.version, ...(mutation.history === undefined ? {} : { history: structuredClone(mutation.history) }), ...(mutation.metadata === undefined ? {} : structuredClone(mutation.metadata)) }; break }
      case 'setNextIds': state.nextIds = { ...mutation.nextIds }; break
      case 'appendEvent': appendRuntimeEvent(state, mutation.event, defaults); break
      case 'setNow': state.now = mutation.now; break
    }
  }
}
