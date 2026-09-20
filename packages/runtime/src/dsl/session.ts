import type { PulseRuntime } from '../scheduler/runtime.js'
import type { JsonValue, Outcome, RuntimeEvent } from '../core/types.js'

export type SessionEventKind = 'fact' | 'observation' | 'gap' | 'snapshot'
/**
 * Session events use the DSL's `kind` field. `type` remains as a compatibility
 * alias for the initial runtime API and is emitted with the same value.
 */
export interface SessionEvent { kind: SessionEventKind; type: SessionEventKind; seq: number; event?: RuntimeEvent; observation?: JsonValue; fromSeq?: number; toSeq?: number; snapshot?: JsonValue }
export interface PulseSessionSnapshot { schemaVersion: 1; agentId: string; now: number; eventSeq: number; agent: JsonValue; lanes: unknown[]; effects: unknown[]; waits: unknown[]; results: unknown[]; mergeProposals: unknown[]; quarantine: unknown[]; observationsPending: number }

export class PulseSession {
  private readonly execution: Promise<Outcome>
  constructor(private readonly runtime: PulseRuntime, readonly agentId: string) {
    this.execution = runtime.runAgent(agentId).then((result) => {
      const root = runtime.state.lanes.get(runtime.state.agents.get(agentId)?.rootLaneId ?? '')
      return {
        status: result.status,
        ...(root?.resultRef === undefined ? {} : { resultRef: root.resultRef }),
        ...(root?.failure === undefined ? {} : { error: root.failure.error }),
        ...(result.status === 'cancelled' && root?.cancelReason !== undefined ? { reason: root.cancelReason } : {}),
        ...(result.unresolvedEffectIds.length ? { unresolvedEffectIds: [...result.unresolvedEffectIds] } : {}),
      }
    })
  }
  private ownsEvent(event: RuntimeEvent): boolean {
    if (event.agentId === this.agentId) return true
    if (event.laneId !== undefined) return this.runtime.state.lanes.get(event.laneId)?.agentId === this.agentId
    if (event.effectId !== undefined) return this.runtime.state.effects.get(event.effectId)?.agentId === this.agentId
    return false
  }
  async *stream(fromSeq = 0): AsyncIterable<SessionEvent> {
    let cursor = fromSeq
    while (true) {
      const oldest = this.runtime.state.events[0]?.seq
      const compactedThrough = this.runtime.state.eventsCompactedThrough ?? 0
      const gapEnd = oldest === undefined ? compactedThrough : oldest - 1
      if (cursor < gapEnd) {
        yield { kind: 'gap', type: 'gap', seq: gapEnd, fromSeq: cursor + 1, toSeq: gapEnd }
        cursor = gapEnd
      }
      const events = this.runtime.state.events.filter((event) => event.seq > cursor)
      for (const event of events) { cursor = event.seq; if (this.ownsEvent(event)) yield { kind: 'fact', type: 'fact', seq: event.seq, event } }
      for (const observation of this.runtime.observationInbox.drain(this.agentId)) yield { kind: 'observation', type: 'observation', seq: observation.seq, observation: observation as unknown as JsonValue }
      const root = [...this.runtime.state.lanes.values()].find((lane) => lane.agentId === this.agentId && lane.ownerLaneId === undefined)
      if (root && ['succeeded', 'failed', 'cancelled'].includes(root.status) && (this.runtime.state.events.at(-1)?.seq ?? compactedThrough) === cursor) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  async snapshot(): Promise<PulseSessionSnapshot> {
    const agent = this.runtime.state.agents.get(this.agentId)
    const laneIds = new Set([...this.runtime.state.lanes.values()].filter((lane) => lane.agentId === this.agentId).map((lane) => lane.id))
    const effects = [...this.runtime.state.effects.values()].filter((effect) => effect.agentId === this.agentId)
    const effectIds = new Set(effects.map((effect) => effect.id))
    return {
      schemaVersion: 1,
      agentId: this.agentId,
      now: this.runtime.state.now,
      eventSeq: this.runtime.state.events.at(-1)?.seq ?? 0,
      agent: agent ? structuredClone({ id: agent.id, goal: agent.goal ?? null, state: agent.state ?? null, latestGlobalVersion: agent.latestGlobalVersion, globalVersions: [...agent.globalVersions.entries()].map(([version, value]) => ({ version, value, ...(agent.globalPrivacy?.get(version) === undefined ? {} : { privacy: agent.globalPrivacy.get(version) as unknown as JsonValue }) })) }) as unknown as JsonValue : null,
      lanes: [...this.runtime.state.lanes.values()].filter((lane) => laneIds.has(lane.id)).map((lane) => structuredClone({ id: lane.id, agentId: lane.agentId, ownerLaneId: lane.ownerLaneId ?? null, status: lane.status, cancelReason: lane.cancelReason ?? null, failure: lane.failure ?? null, version: lane.version, goal: lane.goal, priority: lane.priority, inheritedFloor: lane.inheritedFloor ?? null, readySince: lane.readySince, resume: lane.resume, pendingResumeInput: lane.pendingResumeInput ?? null, contextSnapshotVersion: lane.contextSnapshotVersion, context: lane.context, visibleResultRefs: lane.visibleResultRefs ? [...lane.visibleResultRefs] : [], historyPressure: lane.historyPressure ?? null, activeWaitId: lane.activeWaitId ?? null, children: [...lane.children], ownedEffectIds: [...lane.ownedEffectIds], resultRef: lane.resultRef ?? null, closingResult: lane.closingResult ?? null, consecutiveControlErrors: lane.consecutiveControlErrors ?? 0, unresolvedEffectIds: lane.unresolvedEffectIds ?? [], progressWatchdog: lane.progressWatchdog ?? null })),
      effects: effects.map((effect) => structuredClone(effect)),
      waits: [...this.runtime.state.waits.values()].filter((wait) => laneIds.has(wait.laneId)).map((wait) => structuredClone(wait)),
      results: [...this.runtime.state.results.values()].filter((result) => (result.effectId !== undefined && effectIds.has(result.effectId)) || [...this.runtime.state.lanes.values()].some((lane) => laneIds.has(lane.id) && lane.resultRef === result.id)).map((result) => structuredClone(result)),
      mergeProposals: [...this.runtime.state.mergeProposals.values()].filter((proposal) => proposal.agentId === this.agentId).map((proposal) => structuredClone(proposal)),
      quarantine: structuredClone(this.runtime.quarantine.snapshot().filter((entry) => effectIds.has(entry.effectId))),
      observationsPending: this.runtime.observationInbox.snapshot().filter((observation) => observation.agentId === this.agentId).length,
    }
  }
  async outcome(): Promise<Outcome> { return this.execution }
  async reply(effectId: string, value: JsonValue): Promise<void> {
    const effect = this.runtime.state.effects.get(effectId)
    if (!effect || effect.agentId !== this.agentId) throw new Error('EFFECT_NOT_OWNED')
    if (effect.kind !== 'human' || effect.outcome) throw new Error('EFFECT_NOT_REPLYABLE')
    this.runtime.enqueueHostCommand({ type: 'reply', agentId: this.agentId, effectId, value })
  }
  async cancel(reason: string): Promise<void> { this.runtime.requestCancel(this.agentId, reason) }
}
