import type { RuntimeEventInput, RuntimeState, RuntimeError, ContextVersion, JsonValue, LaneRecord, EffectRecord, WaitRecord, ResultRecord, ContextDelta, LaneId, WaitId, EffectId, HistoryRecord } from './types.js'
import { appendRuntimeEvent } from './events.js'

export type Mutation =
  | { op: 'setLane'; laneId: LaneId; record: LaneRecord }
  | { op: 'setEffect'; effectId: EffectId; record: EffectRecord }
  | { op: 'setWait'; waitId: WaitId; record: WaitRecord }
  | { op: 'insertLane'; record: LaneRecord }
  | { op: 'insertEffect'; record: EffectRecord }
  | { op: 'insertWait'; record: WaitRecord }
  | { op: 'publishResult'; record: ResultRecord }
  | { op: 'setGlobal'; agentId: string; version: ContextVersion; value: JsonValue }
  | { op: 'setLaneContext'; laneId: LaneId; value: JsonValue; version: ContextVersion; history?: HistoryRecord[] }
  | { op: 'appendEvent'; event: RuntimeEventInput }
  | { op: 'setNow'; now: number }

export interface ValidationSuccess { mutations: Mutation[] }
export interface ValidationFailure { rejection: RuntimeError }
export type ValidationResult = ValidationSuccess | ValidationFailure

export function apply(state: RuntimeState, mutations: Mutation[], defaults: { sessionId?: string; timestamp?: number } = {}): void {
  for (const mutation of mutations) {
    switch (mutation.op) {
      case 'setLane': state.lanes.set(mutation.laneId, mutation.record); break
      case 'setEffect': state.effects.set(mutation.effectId, mutation.record); break
      case 'setWait': state.waits.set(mutation.waitId, mutation.record); break
      case 'insertLane': state.lanes.set(mutation.record.id, mutation.record); break
      case 'insertEffect': state.effects.set(mutation.record.id, mutation.record); break
      case 'insertWait': state.waits.set(mutation.record.id, mutation.record); break
      case 'publishResult': state.results.set(mutation.record.id, mutation.record); break
      case 'setGlobal': state.agents.get(mutation.agentId)!.globalVersions.set(mutation.version, mutation.value); state.agents.get(mutation.agentId)!.latestGlobalVersion = mutation.version; break
      case 'setLaneContext': { const lane = state.lanes.get(mutation.laneId)!; lane.context = { ...lane.context, state: mutation.value, version: mutation.version, ...(mutation.history === undefined ? {} : { history: structuredClone(mutation.history) }) }; break }
      case 'appendEvent': appendRuntimeEvent(state, mutation.event, defaults); break
      case 'setNow': state.now = mutation.now; break
    }
  }
}
