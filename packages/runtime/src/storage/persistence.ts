import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JsonValue, RuntimeState } from '../core/types.js'
import { exportRuntimeState, importRuntimeState, type SessionSnapshot } from './session.js'
import { EffectOutbox, type OutboxSnapshot } from './outbox.js'
import { MutationLog, type MutationLogSnapshot } from './mutation-log.js'
import type { QuarantineEntry, QuarantineScope } from '../lifecycle/scopes.js'

export interface RuntimePersistenceSnapshot {
  schemaVersion: 1
  state: SessionSnapshot
  mutationLog: MutationLogSnapshot
  outbox: OutboxSnapshot
  quarantine?: QuarantineEntry[]
  checkpoint?: { schemaVersion: 1; logWatermark: number; state: SessionSnapshot }
}

export interface RuntimePersistenceBackend {
  load(): Promise<RuntimePersistenceSnapshot | undefined>
  save(snapshot: RuntimePersistenceSnapshot): Promise<void>
}

export class FileRuntimePersistenceBackend implements RuntimePersistenceBackend {
  private pending: Promise<void> = Promise.resolve()
  constructor(readonly filePath: string) {}
  async load(): Promise<RuntimePersistenceSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as RuntimePersistenceSnapshot }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async save(snapshot: RuntimePersistenceSnapshot): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString()}`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporaryPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify(snapshot), 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporaryPath, this.filePath)
        try {
          const directory = await open(dirname(this.filePath), 'r')
          try { await directory.sync() } finally { await directory.close() }
        } catch {
          // Directory fsync is not available on every supported filesystem; the rename remains atomic.
        }
      } finally {
        if (handle) await handle.close().catch(() => undefined)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}

export function exportRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope): RuntimePersistenceSnapshot {
  return { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: mutationLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }) }
}

export function exportRuntimeCheckpoint(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope): RuntimePersistenceSnapshot {
  const watermark = mutationLog.lastSequence
  const checkpointLog = new MutationLog([], watermark)
  return { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: checkpointLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), checkpoint: { schemaVersion: 1, logWatermark: watermark, state: exportRuntimeState(state) } }
}

export function serializeRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox): JsonValue {
  return exportRuntimePersistence(state, mutationLog, outbox) as unknown as JsonValue
}

export function importRuntimePersistence(snapshot: RuntimePersistenceSnapshot | JsonValue): { state: RuntimeState; mutationLog: MutationLog; outbox: EffectOutbox; quarantine?: QuarantineEntry[] } {
  const value = snapshot as RuntimePersistenceSnapshot
  if (!value || value.schemaVersion !== 1 || !value.state || !value.mutationLog || !value.outbox) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  const mutationLog = MutationLog.fromSnapshot(value.mutationLog)
  const state = importRuntimeState(value.checkpoint?.state ?? value.state)
  if (value.checkpoint) mutationLog.replay(state)
  return { state, mutationLog, outbox: EffectOutbox.fromSnapshot(value.outbox), ...(value.quarantine === undefined ? {} : { quarantine: value.quarantine.map((entry) => ({ ...entry })) }) }
}
