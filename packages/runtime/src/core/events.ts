import type { RuntimeEvent, RuntimeEventInput, RuntimeState } from './types.js'

export type { RuntimeEvent, RuntimeEventInput, ResumeInput, WaitResolution, Outcome } from './types.js'

export function normalizeRuntimeEvent(input: RuntimeEventInput, seq: number, defaults: { sessionId?: string; timestamp?: number } = {}): RuntimeEvent {
  const payload = input.payload ?? input.data ?? null
  return {
    id: input.id ?? `event-${seq}`,
    schemaVersion: input.schemaVersion ?? 1,
    sessionId: input.sessionId ?? defaults.sessionId ?? 'session-unknown',
    seq,
    timestamp: input.timestamp ?? defaults.timestamp ?? 0,
    type: input.type,
    ...(input.txId === undefined ? {} : { txId: input.txId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.laneId === undefined ? {} : { laneId: input.laneId }),
    ...(input.effectId === undefined ? {} : { effectId: input.effectId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    payload,
    ...(input.data === undefined ? { data: payload } : { data: input.data }),
  }
}

export function appendRuntimeEvent(state: RuntimeState, input: RuntimeEventInput, defaults: { sessionId?: string; timestamp?: number } = {}): RuntimeEvent {
  const event = normalizeRuntimeEvent(input, state.nextIds.event++, { ...(defaults.sessionId === undefined ? {} : { sessionId: defaults.sessionId }), timestamp: defaults.timestamp ?? state.now })
  state.events.push(event)
  return event
}
