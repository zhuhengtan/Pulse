import type { JsonValue, RuntimeState } from '../core/types.js'
import { exportRuntimeState, importRuntimeState, type SessionSnapshot } from './session.js'
import { EffectOutbox, type OutboxSnapshot } from './outbox.js'
import { MutationLog, type MutationLogSnapshot } from './mutation-log.js'

export interface RuntimePersistenceSnapshot {
  schemaVersion: 1
  state: SessionSnapshot
  mutationLog: MutationLogSnapshot
  outbox: OutboxSnapshot
}

export function exportRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox): RuntimePersistenceSnapshot {
  return { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: mutationLog.snapshot(), outbox: outbox.snapshot() }
}

export function serializeRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox): JsonValue {
  return exportRuntimePersistence(state, mutationLog, outbox) as unknown as JsonValue
}

export function importRuntimePersistence(snapshot: RuntimePersistenceSnapshot | JsonValue): { state: RuntimeState; mutationLog: MutationLog; outbox: EffectOutbox } {
  const value = snapshot as RuntimePersistenceSnapshot
  if (!value || value.schemaVersion !== 1 || !value.state || !value.mutationLog || !value.outbox) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  return { state: importRuntimeState(value.state), mutationLog: MutationLog.fromSnapshot(value.mutationLog), outbox: EffectOutbox.fromSnapshot(value.outbox) }
}
