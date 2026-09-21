import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { parseContextSnapshotRef, provenanceRefId, provenanceRefKind } from '../core/types.js'
import type { DataRef, JsonValue, ProvenanceRef, ResultRecord, RuntimeEvent, RuntimeState } from '../core/types.js'
import { stableSerialize } from '../context/builder.js'
import { FactInbox, type FactInboxSnapshot } from '../core/inbox.js'
import { exportRuntimeState, FileRuntimeSessionStore, importRuntimeState, SqliteRuntimeSessionStore, type RuntimeSessionStore, type SessionSnapshot } from './session.js'
import { EffectOutbox, type OutboxSnapshot } from './outbox.js'
import { MutationLog, type MutationLogSnapshot } from './mutation-log.js'
import type { QuarantineEntry, QuarantineScope } from '../lifecycle/scopes.js'
import { SessionStoragePolicy, type StoragePolicySnapshot } from './policy.js'

export interface RuntimePersistenceSnapshot {
  schemaVersion: 1
  state: SessionSnapshot
  mutationLog: MutationLogSnapshot
  outbox: OutboxSnapshot
  quarantine?: QuarantineEntry[]
  storage?: StoragePolicySnapshot
  factInbox?: FactInboxSnapshot
  snapshotBodies?: 'inline' | 'external'
  externalSnapshotRefs?: string[]
  checkpoint?: { schemaVersion: 1; logWatermark: number; eventWatermark?: number; state: SessionSnapshot }
  resultBodies?: 'inline' | 'external'
  externalResultRefs?: string[]
  eventArchive?: { through: number }
  compatibility?: RuntimePersistenceCompatibility
  integrity?: { algorithm: 'sha256'; digest: string }
}

export interface RuntimePersistenceCompatibility {
  schemaVersion: 1
  programVersions: Record<string, string>
  toolVersions: Record<string, string>
  policyVersion?: string
  routerVersion?: string
}

export interface RuntimeResultStore {
  save(ref: string, value: JsonValue): Promise<void>
  load(ref: string): Promise<JsonValue | undefined>
}

export interface RuntimeSnapshotStore {
  save(ref: string, value: JsonValue): Promise<void>
  load(ref: string): Promise<JsonValue | undefined>
}

export interface RuntimeEventArchive {
  append(events: RuntimeEvent[]): Promise<void>
  read(fromSeq: number, toSeq?: number): Promise<RuntimeEvent[]>
}

interface RuntimeContentEnvelope {
  schemaVersion: 1
  ref: string
  value: JsonValue
}

/** Atomic, idempotent file-backed body store usable as both ResultStore and SnapshotStore. */
export class FileRuntimeContentStore implements RuntimeResultStore, RuntimeSnapshotStore {
  constructor(readonly directory: string) {}

  async save(ref: string, value: JsonValue): Promise<void> {
    if (!ref) throw new Error('INVALID_RUNTIME_CONTENT_REF')
    await mkdir(this.directory, { recursive: true })
    const target = this.pathFor(ref)
    await this.withLock(target, async () => {
      const existing = await this.readEnvelope(target)
      if (existing !== undefined) {
        if (existing.ref !== ref) throw new Error('RUNTIME_CONTENT_REF_COLLISION')
        if (stableSerialize(existing.value) !== stableSerialize(value)) throw new Error('RUNTIME_CONTENT_CONFLICT')
        return
      }
      const temporaryPath = `${target}.tmp-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString()}`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporaryPath, 'wx', 0o600)
        const envelope: RuntimeContentEnvelope = { schemaVersion: 1, ref, value: structuredClone(value) }
        await handle.writeFile(JSON.stringify(envelope), 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporaryPath, target)
      } finally {
        if (handle) await handle.close().catch(() => undefined)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
    })
  }

  async load(ref: string): Promise<JsonValue | undefined> {
    if (!ref) throw new Error('INVALID_RUNTIME_CONTENT_REF')
    const envelope = await this.readEnvelope(this.pathFor(ref))
    if (envelope === undefined) return undefined
    if (envelope.ref !== ref) throw new Error('RUNTIME_CONTENT_REF_COLLISION')
    return structuredClone(envelope.value)
  }

  private pathFor(ref: string): string { return join(this.directory, `${createHash('sha256').update(ref).digest('hex')}.json`) }

  private async readEnvelope(path: string): Promise<RuntimeContentEnvelope | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as RuntimeContentEnvelope
      if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.ref !== 'string' || parsed.value === undefined) throw new Error('INVALID_RUNTIME_CONTENT')
      return parsed
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (cause instanceof Error && cause.message === 'INVALID_RUNTIME_CONTENT') throw cause
      throw new Error('INVALID_RUNTIME_CONTENT')
    }
  }

  private async withLock<T>(target: string, work: () => Promise<T>): Promise<T> {
    const lockPath = `${target}.lock`
    const deadline = Date.now() + 30_000
    let lock: Awaited<ReturnType<typeof open>> | undefined
    while (lock === undefined) {
      try { lock = await open(lockPath, 'wx', 0o600) }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        const lockStat = await stat(lockPath).catch(() => undefined)
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue }
        if (Date.now() >= deadline) throw new Error('RUNTIME_CONTENT_LOCK_TIMEOUT')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try { return await work() } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
  }
}

interface RuntimeSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
  run(...params: unknown[]): unknown
}

interface RuntimeSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): RuntimeSqliteStatement
  close(): void
}

type RuntimeSqliteDatabaseConstructor = new (path: string) => RuntimeSqliteDatabase

/** SQLite-backed result/snapshot body store with idempotent writes and conflict detection. */
export class SqliteRuntimeContentStore implements RuntimeResultStore, RuntimeSnapshotStore {
  private database: RuntimeSqliteDatabase | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string, readonly namespace: 'result' | 'snapshot') {}

  async save(ref: string, value: JsonValue): Promise<void> {
    if (!ref) throw new Error('INVALID_RUNTIME_CONTENT_REF')
    await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const database = this.open()
      database.exec('BEGIN IMMEDIATE')
      try {
        const current = database.prepare('SELECT payload FROM runtime_content WHERE namespace = ? AND ref = ?').get(this.namespace, ref)
        if (current && typeof current.payload === 'string') {
          if (stableSerialize(JSON.parse(current.payload) as JsonValue) !== stableSerialize(value)) throw new Error(`RUNTIME_CONTENT_CONFLICT:${this.namespace}:${ref}`)
        } else database.prepare('INSERT INTO runtime_content (namespace, ref, payload) VALUES (?, ?, ?)').run(this.namespace, ref, JSON.stringify(value))
        database.exec('COMMIT')
      } catch (cause) {
        try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
        throw cause
      }
    })
  }

  async load(ref: string): Promise<JsonValue | undefined> {
    if (!ref) throw new Error('INVALID_RUNTIME_CONTENT_REF')
    return await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const row = this.open().prepare('SELECT payload FROM runtime_content WHERE namespace = ? AND ref = ?').get(this.namespace, ref)
      if (!row || typeof row.payload !== 'string') return undefined
      return structuredClone(JSON.parse(row.payload) as JsonValue)
    })
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.database?.close()
      this.database = undefined
    })
  }

  private open(): RuntimeSqliteDatabase {
    if (this.database) return this.database
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: RuntimeSqliteDatabaseConstructor }
    this.database = new DatabaseSync(this.filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS runtime_content (namespace TEXT NOT NULL, ref TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (namespace, ref))')
    return this.database
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work, work)
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

/** SQLite-backed fact event archive with idempotent sequence append and range reads. */
export class SqliteRuntimeEventArchive implements RuntimeEventArchive {
  private database: RuntimeSqliteDatabase | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async append(events: RuntimeEvent[]): Promise<void> {
    if (events.length === 0) return
    const incoming = new Map<number, RuntimeEvent>()
    for (const event of events) {
      if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE')
      const previous = incoming.get(event.seq)
      if (previous && stableSerialize(previous) !== stableSerialize(event)) throw new Error('RUNTIME_EVENT_ARCHIVE_CONFLICT')
      incoming.set(event.seq, structuredClone(event))
    }
    await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const database = this.open()
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const [seq, event] of incoming) {
          const current = database.prepare('SELECT payload FROM runtime_event_archive WHERE seq = ?').get(seq)
          if (current && typeof current.payload === 'string') {
            if (stableSerialize(JSON.parse(current.payload) as RuntimeEvent) !== stableSerialize(event)) throw new Error('RUNTIME_EVENT_ARCHIVE_CONFLICT')
          } else database.prepare('INSERT INTO runtime_event_archive (seq, payload) VALUES (?, ?)').run(seq, JSON.stringify(event))
        }
        database.exec('COMMIT')
      } catch (cause) {
        try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
        throw cause
      }
    })
  }

  async read(fromSeq: number, toSeq = Number.POSITIVE_INFINITY): Promise<RuntimeEvent[]> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || Number.isNaN(toSeq)) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE_RANGE')
    return await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const statement = toSeq === Number.POSITIVE_INFINITY
        ? this.open().prepare('SELECT payload FROM runtime_event_archive WHERE seq >= ? ORDER BY seq')
        : this.open().prepare('SELECT payload FROM runtime_event_archive WHERE seq >= ? AND seq <= ? ORDER BY seq')
      const rows = toSeq === Number.POSITIVE_INFINITY ? statement.all(fromSeq) : statement.all(fromSeq, toSeq)
      return rows.filter((row) => typeof row.payload === 'string').map((row) => structuredClone(JSON.parse(row.payload as string) as RuntimeEvent))
    })
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.database?.close()
      this.database = undefined
    })
  }

  private open(): RuntimeSqliteDatabase {
    if (this.database) return this.database
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: RuntimeSqliteDatabaseConstructor }
    this.database = new DatabaseSync(this.filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS runtime_event_archive (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
    return this.database
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work, work)
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

/** Atomic file-backed EventArchive with idempotent sequence append and range reads. */
export class FileRuntimeEventArchive implements RuntimeEventArchive {
  private readonly filePath: string

  constructor(readonly directory: string) { this.filePath = join(directory, 'events.json') }

  async append(events: RuntimeEvent[]): Promise<void> {
    if (events.length === 0) return
    const incoming = new Map<number, RuntimeEvent>()
    for (const event of events) {
      if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE')
      const previous = incoming.get(event.seq)
      if (previous && stableSerialize(previous) !== stableSerialize(event)) throw new Error('RUNTIME_EVENT_ARCHIVE_CONFLICT')
      incoming.set(event.seq, structuredClone(event))
    }
    await mkdir(this.directory, { recursive: true })
    await this.withLock(async () => {
      const existing = await this.readEnvelope()
      const bySeq = new Map(existing.map((event) => [event.seq, event]))
      for (const [seq, event] of incoming) {
        const previous = bySeq.get(seq)
        if (previous && stableSerialize(previous) !== stableSerialize(event)) throw new Error('RUNTIME_EVENT_ARCHIVE_CONFLICT')
        bySeq.set(seq, event)
      }
      await this.writeEnvelope([...bySeq.values()].sort((left, right) => left.seq - right.seq))
    })
  }

  async read(fromSeq: number, toSeq = Number.POSITIVE_INFINITY): Promise<RuntimeEvent[]> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || Number.isNaN(toSeq)) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE_RANGE')
    const events = await this.readEnvelope()
    return events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq).map((event) => structuredClone(event))
  }

  private async readEnvelope(): Promise<RuntimeEvent[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { schemaVersion: 1; events: RuntimeEvent[] }
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.events)) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE')
      return parsed.events.map((event) => {
        if (!event || !Number.isInteger(event.seq) || event.seq < 1) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE')
        return structuredClone(event)
      })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      if (cause instanceof Error && cause.message === 'INVALID_RUNTIME_EVENT_ARCHIVE') throw cause
      throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE')
    }
  }

  private async writeEnvelope(events: RuntimeEvent[]): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, events }), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
    } finally {
      if (handle) await handle.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`
    const deadline = Date.now() + 30_000
    let lock: Awaited<ReturnType<typeof open>> | undefined
    while (lock === undefined) {
      try { lock = await open(lockPath, 'wx', 0o600) }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        const lockStat = await stat(lockPath).catch(() => undefined)
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue }
        if (Date.now() >= deadline) throw new Error('RUNTIME_EVENT_ARCHIVE_LOCK_TIMEOUT')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try { return await work() } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
  }
}

export interface RuntimePersistenceBackend {
  load(): Promise<RuntimePersistenceSnapshot | undefined>
  save(snapshot: RuntimePersistenceSnapshot, expectedDigest?: string): Promise<void>
  sessionStore?: RuntimeSessionStore
  resultStore?: RuntimeResultStore
  snapshotStore?: RuntimeSnapshotStore
  eventArchive?: RuntimeEventArchive
}

function hasTarget(state: SessionSnapshot['state'], target: { kind: string; id: string }): boolean {
  return target.kind === 'lane' ? state.lanes.some(([id]) => id === target.id) : target.kind === 'effect' ? state.effects.some(([id]) => id === target.id) : false
}

function withoutIntegrity(snapshot: RuntimePersistenceSnapshot | JsonValue): JsonValue {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot as JsonValue
  const copy = structuredClone(snapshot) as Record<string, JsonValue>
  delete copy.integrity
  return copy as JsonValue
}

function integrityDigest(snapshot: RuntimePersistenceSnapshot | JsonValue): string {
  return createHash('sha256').update(JSON.stringify(withoutIntegrity(snapshot))).digest('hex')
}

export function withRuntimePersistenceIntegrity(snapshot: RuntimePersistenceSnapshot): RuntimePersistenceSnapshot {
  const copy = structuredClone(snapshot)
  delete copy.integrity
  return { ...copy, integrity: { algorithm: 'sha256', digest: integrityDigest(copy) } }
}

function hasDerivedReference(ref: ProvenanceRef, ownerLaneId: string, agents: Map<string, any>, lanes: Map<string, any>, results: Map<string, any>, artifacts: Map<string, any>): boolean {
  const id = provenanceRefId(ref)
  const kind = provenanceRefKind(ref)
  if (kind !== 'artifact' && results.has(id)) return true
  const artifact = kind === 'result' ? undefined : artifacts.get(id)
  if (artifact) {
    const lane = lanes.get(ownerLaneId)
    return artifact.agentId === undefined || artifact.agentId === lane?.agentId
  }
  if (kind === 'result' || kind === 'artifact') return false
  const parsed = parseContextSnapshotRef(id)
  if (!parsed) return false
  if (parsed.kind === 'global') {
    const lane = lanes.get(ownerLaneId)
    const agent = lane ? agents.get(lane.agentId) : undefined
    return Boolean(agent && (parsed.agentId === undefined || parsed.agentId === agent.id) && agent.globalVersions.some(([version]: [number, JsonValue]) => version === parsed.version))
  }
  const lane = lanes.get(ownerLaneId)
  return Boolean(lane && parsed.laneId === lane.id && lane.context.version === parsed.version)
}

function validateExternalBodyReferences(snapshot: RuntimePersistenceSnapshot): void {
  const sessions = [snapshot.state, ...(snapshot.checkpoint === undefined ? [] : [snapshot.checkpoint.state])]
  if (snapshot.snapshotBodies === 'external') {
    const refs = snapshot.externalSnapshotRefs
    if (!Array.isArray(refs) || refs.length !== new Set(refs).size || refs.some((ref) => typeof ref !== 'string' || ref.length === 0)) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
    for (const session of sessions) {
      for (const [agentId, agent] of session.state.agents) for (const entry of agent.globalVersions) if (entry[1] === null && !refs.includes(`global:${agentId}:${entry[0]}`)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:global:${agentId}:${entry[0]}`)
      for (const [laneId, lane] of session.state.lanes) if (lane.context.state === null && !refs.includes(`lane:${laneId}:${lane.context.version}`)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane:${laneId}:${lane.context.version}`)
    }
  }
  if (snapshot.resultBodies === 'external') {
    const refs = snapshot.externalResultRefs
    if (!Array.isArray(refs) || refs.length !== new Set(refs).size || refs.some((ref) => typeof ref !== 'string' || ref.length === 0)) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
    for (const session of sessions) for (const [ref, result] of session.state.results) if (result.value === undefined && !refs.includes(ref)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:result:${ref}`)
  }
}

export function validateRuntimePersistenceSnapshot(snapshot: RuntimePersistenceSnapshot | JsonValue): void {
  const value = snapshot as RuntimePersistenceSnapshot
  if (value?.compatibility !== undefined) {
    const compatibility = value.compatibility
    if (compatibility.schemaVersion !== 1 || !compatibility.programVersions || !compatibility.toolVersions || Object.entries(compatibility.programVersions).some(([key, version]) => !key || typeof version !== 'string' || version.length === 0) || Object.entries(compatibility.toolVersions).some(([key, version]) => !key || typeof version !== 'string' || version.length === 0) || (compatibility.policyVersion !== undefined && typeof compatibility.policyVersion !== 'string') || (compatibility.routerVersion !== undefined && typeof compatibility.routerVersion !== 'string')) throw new Error('INVALID_RUNTIME_PERSISTENCE_COMPATIBILITY')
  }
  if (value?.checkpoint?.eventWatermark !== undefined && (!Number.isInteger(value.checkpoint.eventWatermark) || value.checkpoint.eventWatermark < 0)) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  if (value?.factInbox !== undefined) try { FactInbox.fromSnapshot(value.factInbox) } catch { throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT') }
  const state = value?.checkpoint?.state?.state ?? value?.state?.state
  if (!value || value.schemaVersion !== 1 || !value.state || !value.state.state || !value.mutationLog || !value.outbox || !Array.isArray(state?.agents) || !Array.isArray(state?.lanes) || !Array.isArray(state?.effects) || !Array.isArray(state?.waits) || !Array.isArray(state?.results) || !Array.isArray(state?.mergeProposals)) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  const agents = new Map(state.agents)
  const lanes = new Map(state.lanes)
  const effects = new Map(state.effects)
  const waits = new Map(state.waits)
  const results = new Map(state.results)
  const artifacts = new Map(state.artifacts ?? [])
  validateExternalBodyReferences(value)
  for (const [id, agent] of agents) if (!lanes.has(agent.rootLaneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:agent.rootLaneId:${id}`)
  for (const [ref, artifact] of artifacts) {
    if (artifact.ref !== ref || !artifact.mediaType || !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || typeof artifact.contentBase64 !== 'string' || typeof artifact.contentHash !== 'string' || artifact.pinCount < 0) throw new Error(`INVALID_RUNTIME_PERSISTENCE_ARTIFACT:${ref}`)
    if (artifact.agentId !== undefined && !agents.has(artifact.agentId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:artifact.agentId:${ref}`)
  }
  for (const [id, result] of results) {
    if (result.id !== id || (result.kind === 'finding' && (!result.statement || !Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0))) throw new Error(`INVALID_RUNTIME_PERSISTENCE_RESULT:${id}`)
    if (result.kind === 'finding') for (const ref of result.evidenceRefs ?? []) if (!ref || (ref.kind !== 'result' && ref.kind !== 'artifact') || !hasDerivedReference(ref, (result as ResultRecord & { laneId?: string }).laneId ?? (result.effectId ? effects.get(result.effectId)?.ownerLaneId ?? '' : ''), agents, lanes, results, artifacts)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:finding.evidenceRefs:${id}`)
  }
  for (const [id, lane] of lanes) {
    if (!agents.has(lane.agentId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.agentId:${id}`)
    if (lane.ownerLaneId !== undefined && !lanes.has(lane.ownerLaneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.ownerLaneId:${id}`)
    if (lane.activeWaitId !== undefined && !waits.has(lane.activeWaitId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.activeWaitId:${id}`)
    if (lane.resultRef !== undefined && !results.has(lane.resultRef)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.resultRef:${id}`)
    for (const childId of lane.children) if (!lanes.has(childId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.children:${id}`)
    for (const effectId of lane.ownedEffectIds) if (!effects.has(effectId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.ownedEffectIds:${id}`)
    for (const resultRef of lane.visibleResultRefs ?? []) if (!results.has(resultRef)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane.visibleResultRefs:${id}`)
  }
  for (const [id, effect] of effects) {
    if (!lanes.has(effect.ownerLaneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:effect.ownerLaneId:${id}`)
    if (effect.childAgentId !== undefined && !agents.has(effect.childAgentId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:effect.childAgentId:${id}`)
    for (const resultRef of effect.derivedFrom ?? []) if (!hasDerivedReference(resultRef, effect.ownerLaneId, agents, lanes, results, artifacts)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:effect.derivedFrom:${id}`)
  }
  for (const [id, wait] of waits) {
    if (!lanes.has(wait.laneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:wait.laneId:${id}`)
    for (const dependency of wait.spec.dependencies) if (!hasTarget(state, dependency.target as { kind: string; id: string })) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:wait.target:${id}`)
    if (wait.resolution) for (const dependency of Object.values(wait.resolution.dependencies)) if (!hasTarget(state, dependency.target)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:wait.resolution:${id}`)
  }
  for (const [id, proposal] of new Map(state.mergeProposals)) {
    if (!agents.has(proposal.agentId) || !lanes.has(proposal.sourceLaneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:mergeProposal:${id}`)
    for (const ref of proposal.delta.derivedFrom ?? []) if (!hasDerivedReference(ref, proposal.sourceLaneId, agents, lanes, results, artifacts)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:mergeProposal.derivedFrom:${id}`)
  }
  for (const entry of value.quarantine ?? []) if (!effects.has(entry.effectId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:quarantine:${entry.effectId}`)
  if (value.integrity !== undefined && (value.integrity.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(value.integrity.digest) || value.integrity.digest !== integrityDigest(value))) throw new Error('INVALID_RUNTIME_PERSISTENCE_INTEGRITY')
}

export class FileRuntimePersistenceBackend implements RuntimePersistenceBackend {
  private pending: Promise<void> = Promise.resolve()
  readonly sessionStore: FileRuntimeSessionStore
  constructor(readonly filePath: string) { this.sessionStore = new FileRuntimeSessionStore(`${filePath}.sessions.json`) }
  async load(): Promise<RuntimePersistenceSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as RuntimePersistenceSnapshot }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async save(snapshot: RuntimePersistenceSnapshot, expectedDigest?: string): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const lockPath = `${this.filePath}.lock`
      let lock: Awaited<ReturnType<typeof open>> | undefined
      const lockDeadline = Date.now() + 30_000
      while (lock === undefined) {
        try { lock = await open(lockPath, 'wx', 0o600) }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
          const lockStat = await stat(lockPath).catch(() => undefined)
          if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue }
          if (Date.now() >= lockDeadline) throw new Error('RUNTIME_PERSISTENCE_LOCK_TIMEOUT')
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      }
      try {
        const current = await this.load()
        if (expectedDigest !== undefined && (current === undefined || current.integrity?.digest !== expectedDigest)) throw new Error('RUNTIME_PERSISTENCE_CONFLICT')
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
      } finally {
        await lock.close().catch(() => undefined)
        await rm(lockPath, { force: true }).catch(() => undefined)
      }
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase

/** Durable single-snapshot backend using Node's built-in SQLite transaction support. */
export class SqliteRuntimePersistenceBackend implements RuntimePersistenceBackend {
  private database: SqliteDatabase | undefined
  private tail: Promise<void> = Promise.resolve()
  readonly resultStore: SqliteRuntimeContentStore
  readonly snapshotStore: SqliteRuntimeContentStore
  readonly eventArchive: SqliteRuntimeEventArchive
  readonly sessionStore: SqliteRuntimeSessionStore

  constructor(readonly filePath: string) {
    this.resultStore = new SqliteRuntimeContentStore(filePath, 'result')
    this.snapshotStore = new SqliteRuntimeContentStore(filePath, 'snapshot')
    this.eventArchive = new SqliteRuntimeEventArchive(filePath)
    this.sessionStore = new SqliteRuntimeSessionStore(filePath)
  }

  async load(): Promise<RuntimePersistenceSnapshot | undefined> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const row = this.open().prepare('SELECT payload FROM runtime_snapshot WHERE id = 1').get()
      if (!row) return undefined
      if (typeof row.payload !== 'string') throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
      return JSON.parse(row.payload) as RuntimePersistenceSnapshot
    })
  }

  async save(snapshot: RuntimePersistenceSnapshot, expectedDigest?: string): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const database = this.open()
      database.exec('BEGIN IMMEDIATE')
      try {
        const current = database.prepare('SELECT digest FROM runtime_snapshot WHERE id = 1').get()
        const currentDigest = current && typeof current.digest === 'string' ? current.digest : undefined
        if (expectedDigest !== undefined && currentDigest !== expectedDigest) throw new Error('RUNTIME_PERSISTENCE_CONFLICT')
        const payload = JSON.stringify(snapshot)
        database.prepare('INSERT INTO runtime_snapshot (id, payload, digest) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, digest = excluded.digest').run(payload, snapshot.integrity?.digest ?? null)
        database.exec('COMMIT')
      } catch (cause) {
        try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
        throw cause
      }
    })
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.database?.close()
      this.database = undefined
    })
    await Promise.all([this.resultStore.close(), this.snapshotStore.close(), this.eventArchive.close()])
    this.sessionStore.close()
  }

  private open(): SqliteDatabase {
    if (this.database) return this.database
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: SqliteDatabaseConstructor }
    this.database = new DatabaseSync(this.filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS runtime_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, digest TEXT)')
    return this.database
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work, work)
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

export function exportRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope, storagePolicy?: SessionStoragePolicy, factInbox?: FactInboxSnapshot, compatibility?: RuntimePersistenceCompatibility): RuntimePersistenceSnapshot {
  const snapshot: RuntimePersistenceSnapshot = { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: mutationLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), ...(storagePolicy === undefined ? {} : { storage: storagePolicy.snapshot() }), ...(factInbox === undefined ? {} : { factInbox: structuredClone(factInbox) }), ...(compatibility === undefined ? {} : { compatibility: structuredClone(compatibility) }) }
  return { ...snapshot, integrity: { algorithm: 'sha256', digest: integrityDigest(snapshot) } }
}

export function exportRuntimeCheckpoint(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope, storagePolicy?: SessionStoragePolicy, options: { compactEventsThrough?: number } = {}, factInbox?: FactInboxSnapshot, compatibility?: RuntimePersistenceCompatibility): RuntimePersistenceSnapshot {
  const watermark = mutationLog.lastSequence
  const checkpointLog = new MutationLog([], watermark)
  const checkpointState = exportRuntimeState(state)
  const eventWatermark = options.compactEventsThrough
  if (eventWatermark !== undefined) {
    checkpointState.state.events = checkpointState.state.events.filter((event) => event.seq > eventWatermark)
    checkpointState.state.eventsCompactedThrough = Math.max(checkpointState.state.eventsCompactedThrough ?? 0, eventWatermark)
  }
  const snapshot: RuntimePersistenceSnapshot = { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: checkpointLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), ...(storagePolicy === undefined ? {} : { storage: storagePolicy.snapshot() }), ...(factInbox === undefined ? {} : { factInbox: structuredClone(factInbox) }), ...(compatibility === undefined ? {} : { compatibility: structuredClone(compatibility) }), checkpoint: { schemaVersion: 1, logWatermark: watermark, ...(eventWatermark === undefined ? {} : { eventWatermark }), state: checkpointState } }
  return { ...snapshot, integrity: { algorithm: 'sha256', digest: integrityDigest(snapshot) } }
}

export async function externalizeRuntimeResultBodies(snapshot: RuntimePersistenceSnapshot, store: RuntimeResultStore): Promise<RuntimePersistenceSnapshot> {
  const copy = structuredClone(snapshot)
  const refs = new Set<string>(copy.externalResultRefs ?? [])
  const states = [copy.state, ...(copy.checkpoint === undefined ? [] : [copy.checkpoint.state])]
  for (const session of states) {
    for (const [ref, result] of session.state.results) {
      if (result.value === undefined) continue
      await store.save(ref, result.value)
      delete result.value
      refs.add(ref)
    }
  }
  copy.resultBodies = 'external'
  copy.externalResultRefs = [...refs].sort()
  delete copy.integrity
  return withRuntimePersistenceIntegrity(copy)
}

function snapshotSessions(snapshot: RuntimePersistenceSnapshot): SessionSnapshot[] { return [snapshot.state, ...(snapshot.checkpoint === undefined ? [] : [snapshot.checkpoint.state])] }

export async function externalizeRuntimeSnapshotBodies(snapshot: RuntimePersistenceSnapshot, store: RuntimeSnapshotStore): Promise<RuntimePersistenceSnapshot> {
  const copy = structuredClone(snapshot)
  const refs = new Set<string>(copy.externalSnapshotRefs ?? [])
  for (const session of snapshotSessions(copy)) {
    for (const [agentId, agent] of session.state.agents) {
      for (const entry of agent.globalVersions) {
        const version = entry[0]
        const ref = `global:${agentId}:${version}`
        await store.save(ref, entry[1])
        entry[1] = null
        refs.add(ref)
      }
    }
    for (const [laneId, lane] of session.state.lanes) {
      const ref = `lane:${laneId}:${lane.context.version}`
      await store.save(ref, lane.context.state)
      lane.context.state = null
      refs.add(ref)
    }
  }
  copy.snapshotBodies = 'external'
  copy.externalSnapshotRefs = [...refs].sort()
  delete copy.integrity
  return withRuntimePersistenceIntegrity(copy)
}

export async function hydrateRuntimeSnapshotBodies(snapshot: RuntimePersistenceSnapshot, store: RuntimeSnapshotStore): Promise<RuntimePersistenceSnapshot> {
  if (snapshot.snapshotBodies !== 'external') return snapshot
  const copy = structuredClone(snapshot)
  validateExternalBodyReferences(copy)
  const refs = new Set(copy.externalSnapshotRefs ?? [])
  for (const session of snapshotSessions(copy)) {
    for (const [agentId, agent] of session.state.agents) {
      for (const entry of agent.globalVersions) {
        const ref = `global:${agentId}:${entry[0]}`
        if (!refs.has(ref)) throw new Error(`RUNTIME_SNAPSHOT_REFERENCE_MISSING:${ref}`)
        const value = await store.load(ref)
        if (value === undefined) throw new Error(`RUNTIME_SNAPSHOT_NOT_FOUND:${ref}`)
        entry[1] = value
      }
    }
    for (const [laneId, lane] of session.state.lanes) {
      const ref = `lane:${laneId}:${lane.context.version}`
      if (!refs.has(ref)) throw new Error(`RUNTIME_SNAPSHOT_REFERENCE_MISSING:${ref}`)
      const value = await store.load(ref)
      if (value === undefined) throw new Error(`RUNTIME_SNAPSHOT_NOT_FOUND:${ref}`)
      lane.context.state = value
    }
  }
  copy.snapshotBodies = 'inline'
  delete copy.externalSnapshotRefs
  delete copy.integrity
  return withRuntimePersistenceIntegrity(copy)
}

export async function hydrateRuntimeResultBodies(snapshot: RuntimePersistenceSnapshot, store: RuntimeResultStore): Promise<RuntimePersistenceSnapshot> {
  if (snapshot.resultBodies !== 'external') return snapshot
  const copy = structuredClone(snapshot)
  validateExternalBodyReferences(copy)
  const refs = copy.externalResultRefs ?? []
  const sessions = snapshotSessions(copy)
  for (const session of sessions) {
    for (const [ref, result] of session.state.results) {
      if (result.value !== undefined) continue
      if (!refs.includes(ref)) throw new Error(`RUNTIME_RESULT_REFERENCE_MISSING:${ref}`)
      const value = await store.load(ref)
      if (value === undefined) throw new Error(`RUNTIME_RESULT_NOT_FOUND:${ref}`)
      result.value = value
    }
  }
  copy.resultBodies = 'inline'
  delete copy.externalResultRefs
  delete copy.integrity
  return withRuntimePersistenceIntegrity(copy)
}

export function serializeRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, storagePolicy?: SessionStoragePolicy): JsonValue {
  return exportRuntimePersistence(state, mutationLog, outbox, undefined, storagePolicy) as unknown as JsonValue
}

export function importRuntimePersistence(snapshot: RuntimePersistenceSnapshot | JsonValue): { state: RuntimeState; mutationLog: MutationLog; outbox: EffectOutbox; quarantine?: QuarantineEntry[]; storagePolicy?: SessionStoragePolicy; factInbox?: FactInboxSnapshot; compatibility?: RuntimePersistenceCompatibility } {
  const value = snapshot as RuntimePersistenceSnapshot
  validateRuntimePersistenceSnapshot(value)
  if (value.snapshotBodies === 'external') throw new Error('RUNTIME_SNAPSHOT_STORE_REQUIRED')
  const mutationLog = MutationLog.fromSnapshot(value.mutationLog)
  const state = importRuntimeState(value.checkpoint?.state ?? value.state)
  if (value.checkpoint) mutationLog.replay(state)
  return { state, mutationLog, outbox: EffectOutbox.fromSnapshot(value.outbox), ...(value.quarantine === undefined ? {} : { quarantine: value.quarantine.map((entry) => ({ ...entry })) }), ...(value.storage === undefined ? {} : { storagePolicy: SessionStoragePolicy.fromSnapshot(value.storage) }), ...(value.factInbox === undefined ? {} : { factInbox: structuredClone(value.factInbox) }), ...(value.compatibility === undefined ? {} : { compatibility: structuredClone(value.compatibility) }) }
}
