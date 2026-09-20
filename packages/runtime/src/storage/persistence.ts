import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

export interface RuntimePersistenceBackend {
  load(): Promise<RuntimePersistenceSnapshot | undefined>
  save(snapshot: RuntimePersistenceSnapshot): Promise<void>
}

export class FileRuntimePersistenceBackend implements RuntimePersistenceBackend {
  constructor(readonly filePath: string) {}
  async load(): Promise<RuntimePersistenceSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as RuntimePersistenceSnapshot }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async save(snapshot: RuntimePersistenceSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8')
    await rename(temporaryPath, this.filePath)
  }
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
