import type { AgentRecord, LaneRecord, ResumePoint, RuntimeState, JsonValue } from './types.js'

export interface AgentBuildResult { agent: AgentRecord; root: LaneRecord; nextIds: RuntimeState['nextIds'] }

export function buildAgent(state: RuntimeState, goal: string, resume: ResumePoint, options: { agentId?: string; maxActiveLanes?: number; initialGlobal?: JsonValue; initialGlobalPrivacy?: import('./types.js').PrivacyMetadata; parentAgentId?: string; depth?: number; inheritedFloor?: number } = {}): AgentBuildResult {
  let agentSequence = state.nextIds.agent
  let agentId = options.agentId ?? `agent-${agentSequence}`
  if (options.agentId === undefined) while (state.agents.has(agentId)) { agentSequence++; agentId = `agent-${agentSequence}` }
  let laneSequence = state.nextIds.lane
  let rootId = `lane-${laneSequence}`
  while (state.lanes.has(rootId)) { laneSequence++; rootId = `lane-${laneSequence}` }
  const initialPrivacy = structuredClone(options.initialGlobalPrivacy ?? { privacy: 'public' as const })
  const agent: AgentRecord = { id: agentId, rootLaneId: rootId, goal, state: 'created', globalVersions: new Map([[0, structuredClone(options.initialGlobal ?? {})]]), globalPrivacy: new Map([[0, initialPrivacy]]), latestGlobalVersion: 0, maxActiveLanes: options.maxActiveLanes ?? 64, ...(options.parentAgentId === undefined ? {} : { parentAgentId: options.parentAgentId }), ...(options.depth === undefined ? {} : { depth: options.depth }) }
  const root: LaneRecord = { id: rootId, agentId, status: 'ready', version: 0, goal, resume, contextSnapshotVersion: 0, context: { version: 0, history: [], state: {}, privacy: 'public' }, visibleResultRefs: new Set(), children: new Set(), priority: 0, ...(options.inheritedFloor === undefined ? {} : { inheritedFloor: options.inheritedFloor }), enqueueSeq: 0, readySince: state.now, ownedEffectIds: new Set() }
  return { agent, root, nextIds: { ...state.nextIds, agent: Math.max(state.nextIds.agent + 1, agentSequence + 1), lane: laneSequence + 1 } }
}

export function createAgent(state: RuntimeState, goal: string, resume: ResumePoint, options: { agentId?: string; maxActiveLanes?: number; initialGlobal?: JsonValue; initialGlobalPrivacy?: import('./types.js').PrivacyMetadata; parentAgentId?: string; depth?: number; inheritedFloor?: number } = {}): { agent: AgentRecord; root: LaneRecord } {
  const built = buildAgent(state, goal, resume, options)
  state.nextIds = built.nextIds
  const { agent, root } = built
  state.agents.set(agent.id, agent)
  state.lanes.set(root.id, root)
  return { agent, root }
}
