import type { PulseRuntime } from '../scheduler/runtime.js'
import type { JsonValue, RuntimeEvent } from '../core/types.js'

export interface SessionEvent { type: 'fact' | 'observation' | 'gap' | 'snapshot'; seq: number; event?: RuntimeEvent; observation?: JsonValue; fromSeq?: number; toSeq?: number; snapshot?: JsonValue }
export interface PulseSessionSnapshot { schemaVersion: 1; agentId: string; now: number; eventSeq: number; agent: JsonValue; lanes: unknown[]; effects: unknown[]; waits: unknown[]; results: unknown[]; mergeProposals: unknown[]; quarantine: unknown[]; observationsPending: number }

export class PulseSession {
  private readonly execution: Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }>
  constructor(private readonly runtime: PulseRuntime, readonly agentId: string) { this.execution = runtime.run() }
  async *stream(fromSeq = 0): AsyncIterable<SessionEvent> {
    let cursor = fromSeq
    while (true) {
      const oldest = this.runtime.state.events[0]?.seq
      if (oldest !== undefined && cursor + 1 < oldest) {
        yield { type: 'gap', seq: oldest, fromSeq: cursor + 1, toSeq: oldest - 1 }
        cursor = oldest - 1
      }
      const events = this.runtime.state.events.filter((event) => event.seq > cursor)
      for (const event of events) { cursor = event.seq; yield { type: 'fact', seq: event.seq, event } }
      for (const observation of this.runtime.observationInbox.drain(this.agentId)) yield { type: 'observation', seq: observation.seq, observation: observation as unknown as JsonValue }
      const root = [...this.runtime.state.lanes.values()].find((lane) => lane.agentId === this.agentId && lane.ownerLaneId === undefined)
      if (root && ['succeeded', 'failed', 'cancelled'].includes(root.status) && this.runtime.state.events.at(-1)?.seq === cursor) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  snapshot(): PulseSessionSnapshot {
    const agent = this.runtime.state.agents.get(this.agentId)
    const laneIds = new Set([...this.runtime.state.lanes.values()].filter((lane) => lane.agentId === this.agentId).map((lane) => lane.id))
    const effects = [...this.runtime.state.effects.values()].filter((effect) => effect.agentId === this.agentId)
    const effectIds = new Set(effects.map((effect) => effect.id))
    return {
      schemaVersion: 1,
      agentId: this.agentId,
      now: this.runtime.state.now,
      eventSeq: this.runtime.state.events.at(-1)?.seq ?? 0,
      agent: agent ? { id: agent.id, goal: agent.goal ?? null, state: agent.state ?? null, latestGlobalVersion: agent.latestGlobalVersion, globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => ({ version, value })) } : null,
      lanes: [...this.runtime.state.lanes.values()].filter((lane) => laneIds.has(lane.id)).map((lane) => ({ id: lane.id, agentId: lane.agentId, ownerLaneId: lane.ownerLaneId ?? null, status: lane.status, version: lane.version, goal: lane.goal, priority: lane.priority, inheritedFloor: lane.inheritedFloor ?? null, readySince: lane.readySince, resume: lane.resume, pendingResumeInput: lane.pendingResumeInput ?? null, contextSnapshotVersion: lane.contextSnapshotVersion, context: lane.context, historyPressure: lane.historyPressure ?? null, activeWaitId: lane.activeWaitId ?? null, children: [...lane.children], ownedEffectIds: [...lane.ownedEffectIds], resultRef: lane.resultRef ?? null, closingResult: lane.closingResult ?? null, consecutiveControlErrors: lane.consecutiveControlErrors ?? 0, unresolvedEffectIds: lane.unresolvedEffectIds ?? [], progressWatchdog: lane.progressWatchdog ?? null })),
      effects: effects.map((effect) => ({ ...effect })),
      waits: [...this.runtime.state.waits.values()].filter((wait) => laneIds.has(wait.laneId)).map((wait) => ({ ...wait })),
      results: [...this.runtime.state.results.values()].filter((result) => (result.effectId !== undefined && effectIds.has(result.effectId)) || [...this.runtime.state.lanes.values()].some((lane) => laneIds.has(lane.id) && lane.resultRef === result.id)).map((result) => ({ ...result })),
      mergeProposals: [...this.runtime.state.mergeProposals.values()].filter((proposal) => proposal.agentId === this.agentId).map((proposal) => ({ ...proposal, delta: { ...proposal.delta, ops: proposal.delta.ops.map((op) => ({ ...op })) } })),
      quarantine: this.runtime.quarantine.snapshot().filter((entry) => effectIds.has(entry.effectId)),
      observationsPending: this.runtime.observationInbox.snapshot().filter((observation) => observation.agentId === this.agentId).length,
    }
  }
  async outcome(): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> { return this.execution }
  reply(effectId: string, value: JsonValue): Promise<void> { this.runtime.enqueueHostCommand({ type: 'reply', effectId, value }); return Promise.resolve() }
  cancel(reason: string): Promise<void> { this.runtime.enqueueHostCommand({ type: 'cancel', agentId: this.agentId, reason }); return Promise.resolve() }
}
