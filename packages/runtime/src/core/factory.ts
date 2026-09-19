import type { AgentRecord, LaneRecord, ResumePoint, RuntimeState, JsonValue } from './types.js'

export function createAgent(state: RuntimeState, goal: string, resume: ResumePoint, options: { agentId?: string; maxActiveLanes?: number; initialGlobal?: JsonValue } = {}): { agent: AgentRecord; root: LaneRecord } {
  const agentId = options.agentId ?? `agent-${state.nextIds.agent++}`
  const rootId = `lane-${state.nextIds.lane++}`
  const agent: AgentRecord = { id: agentId, rootLaneId: rootId, goal, state: 'created', globalVersions: new Map([[0, structuredClone(options.initialGlobal ?? {})]]), latestGlobalVersion: 0, maxActiveLanes: options.maxActiveLanes ?? 64 }
  const root: LaneRecord = { id: rootId, agentId, status: 'ready', version: 0, goal, resume, contextSnapshotVersion: 0, context: { version: 0, history: [], state: {} }, children: new Set(), priority: 0, enqueueSeq: 0, readySince: state.now, ownedEffectIds: new Set() }
  state.agents.set(agentId, agent)
  state.lanes.set(rootId, root)
  return { agent, root }
}
