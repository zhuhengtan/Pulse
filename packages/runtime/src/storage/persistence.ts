import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseContextSnapshotRef, provenanceRefId, provenanceRefKind } from '../core/types.js'
import type { DataRef, JsonValue, ProvenanceRef, ResultRecord, RuntimeEvent, RuntimeState } from '../core/types.js'
import { stableSerialize } from '../context/builder.js'
import { FactInbox, type FactInboxSnapshot } from '../core/inbox.js'
import { exportRuntimeState, importRuntimeState, type SessionSnapshot } from './session.js'
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
  integrity?: { algorithm: 'sha256'; digest: string }
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

export interface RuntimePersistenceBackend {
  load(): Promise<RuntimePersistenceSnapshot | undefined>
  save(snapshot: RuntimePersistenceSnapshot, expectedDigest?: string): Promise<void>
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

export function validateRuntimePersistenceSnapshot(snapshot: RuntimePersistenceSnapshot | JsonValue): void {
  const value = snapshot as RuntimePersistenceSnapshot
  if (value?.snapshotBodies === 'external' && (!Array.isArray(value.externalSnapshotRefs) || value.externalSnapshotRefs.some((ref) => typeof ref !== 'string' || ref.length === 0))) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
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
  constructor(readonly filePath: string) {}
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

export function exportRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope, storagePolicy?: SessionStoragePolicy, factInbox?: FactInboxSnapshot): RuntimePersistenceSnapshot {
  const snapshot: RuntimePersistenceSnapshot = { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: mutationLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), ...(storagePolicy === undefined ? {} : { storage: storagePolicy.snapshot() }), ...(factInbox === undefined ? {} : { factInbox: structuredClone(factInbox) }) }
  return { ...snapshot, integrity: { algorithm: 'sha256', digest: integrityDigest(snapshot) } }
}

export function exportRuntimeCheckpoint(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope, storagePolicy?: SessionStoragePolicy, options: { compactEventsThrough?: number } = {}, factInbox?: FactInboxSnapshot): RuntimePersistenceSnapshot {
  const watermark = mutationLog.lastSequence
  const checkpointLog = new MutationLog([], watermark)
  const checkpointState = exportRuntimeState(state)
  const eventWatermark = options.compactEventsThrough
  if (eventWatermark !== undefined) {
    checkpointState.state.events = checkpointState.state.events.filter((event) => event.seq > eventWatermark)
    checkpointState.state.eventsCompactedThrough = Math.max(checkpointState.state.eventsCompactedThrough ?? 0, eventWatermark)
  }
  const snapshot: RuntimePersistenceSnapshot = { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: checkpointLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), ...(storagePolicy === undefined ? {} : { storage: storagePolicy.snapshot() }), ...(factInbox === undefined ? {} : { factInbox: structuredClone(factInbox) }), checkpoint: { schemaVersion: 1, logWatermark: watermark, ...(eventWatermark === undefined ? {} : { eventWatermark }), state: checkpointState } }
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
  copy.snapshotBodies = 'inline'
  delete copy.externalSnapshotRefs
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
  const refs = new Set(copy.externalSnapshotRefs ?? [])
  for (const session of snapshotSessions(copy)) {
    for (const [agentId, agent] of session.state.agents) {
      for (const entry of agent.globalVersions) {
        const ref = `global:${agentId}:${entry[0]}`
        if (!refs.has(ref)) continue
        const value = await store.load(ref)
        if (value === undefined) throw new Error(`RUNTIME_SNAPSHOT_NOT_FOUND:${ref}`)
        entry[1] = value
      }
    }
    for (const [laneId, lane] of session.state.lanes) {
      const ref = `lane:${laneId}:${lane.context.version}`
      if (!refs.has(ref)) continue
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
  const refs = copy.externalResultRefs ?? []
  const sessions = [copy.checkpoint?.state ?? copy.state]
  for (const session of sessions) {
    for (const [ref, result] of session.state.results) {
      if (!refs.includes(ref) || result.value !== undefined) continue
      const value = await store.load(ref)
      if (value === undefined) throw new Error(`RUNTIME_RESULT_NOT_FOUND:${ref}`)
      result.value = value
    }
  }
  delete copy.integrity
  return withRuntimePersistenceIntegrity(copy)
}

export function serializeRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, storagePolicy?: SessionStoragePolicy): JsonValue {
  return exportRuntimePersistence(state, mutationLog, outbox, undefined, storagePolicy) as unknown as JsonValue
}

export function importRuntimePersistence(snapshot: RuntimePersistenceSnapshot | JsonValue): { state: RuntimeState; mutationLog: MutationLog; outbox: EffectOutbox; quarantine?: QuarantineEntry[]; storagePolicy?: SessionStoragePolicy; factInbox?: FactInboxSnapshot } {
  const value = snapshot as RuntimePersistenceSnapshot
  validateRuntimePersistenceSnapshot(value)
  if (value.snapshotBodies === 'external') throw new Error('RUNTIME_SNAPSHOT_STORE_REQUIRED')
  const mutationLog = MutationLog.fromSnapshot(value.mutationLog)
  const state = importRuntimeState(value.checkpoint?.state ?? value.state)
  if (value.checkpoint) mutationLog.replay(state)
  return { state, mutationLog, outbox: EffectOutbox.fromSnapshot(value.outbox), ...(value.quarantine === undefined ? {} : { quarantine: value.quarantine.map((entry) => ({ ...entry })) }), ...(value.storage === undefined ? {} : { storagePolicy: SessionStoragePolicy.fromSnapshot(value.storage) }), ...(value.factInbox === undefined ? {} : { factInbox: structuredClone(value.factInbox) }) }
}
