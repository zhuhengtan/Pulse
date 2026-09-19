import type { RuntimeEvent, RuntimeState, RuntimeError, ContextVersion, JsonValue, LaneRecord, EffectRecord, WaitRecord, ResultRecord, ContextDelta, LaneId, WaitId, EffectId } from './types.js'

export type Mutation =
  | { op: 'setLane'; laneId: LaneId; record: LaneRecord }
  | { op: 'setEffect'; effectId: EffectId; record: EffectRecord }
  | { op: 'setWait'; waitId: WaitId; record: WaitRecord }
  | { op: 'insertLane'; record: LaneRecord }
  | { op: 'insertEffect'; record: EffectRecord }
  | { op: 'insertWait'; record: WaitRecord }
  | { op: 'publishResult'; record: ResultRecord }
  | { op: 'setGlobal'; agentId: string; version: ContextVersion; value: JsonValue }
  | { op: 'setLaneContext'; laneId: LaneId; value: JsonValue; version: ContextVersion }
  | { op: 'appendEvent'; event: Omit<RuntimeEvent, 'seq'> }
  | { op: 'setNow'; now: number }

export interface ValidationSuccess { mutations: Mutation[] }
export interface ValidationFailure { rejection: RuntimeError }
export type ValidationResult = ValidationSuccess | ValidationFailure

export function apply(state: RuntimeState, mutations: Mutation[]): void {
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
      case 'setLaneContext': { const lane = state.lanes.get(mutation.laneId)!; lane.context = { ...lane.context, state: mutation.value, version: mutation.version }; break }
      case 'appendEvent': { const seq = state.nextIds.event++; state.events.push({ ...mutation.event, seq, id: mutation.event.id ?? `event-${seq}` }); break }
      case 'setNow': state.now = mutation.now; break
    }
  }
}
