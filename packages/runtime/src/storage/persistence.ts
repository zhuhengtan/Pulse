import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { parseContextSnapshotRef, provenanceRefId, provenanceRefKind } from '../core/types.js'
import type { DataRef, JsonValue, ProvenanceRef, ResultRecord, RuntimeState } from '../core/types.js'
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
  checkpoint?: { schemaVersion: 1; logWatermark: number; eventWatermark?: number; state: SessionSnapshot }
  integrity?: { algorithm: 'sha256'; digest: string }
}

export interface RuntimePersistenceBackend {
  load(): Promise<RuntimePersistenceSnapshot | undefined>
  save(snapshot: RuntimePersistenceSnapshot): Promise<void>
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

export function serializeRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, storagePolicy?: SessionStoragePolicy): JsonValue {
  return exportRuntimePersistence(state, mutationLog, outbox, undefined, storagePolicy) as unknown as JsonValue
}

export function importRuntimePersistence(snapshot: RuntimePersistenceSnapshot | JsonValue): { state: RuntimeState; mutationLog: MutationLog; outbox: EffectOutbox; quarantine?: QuarantineEntry[]; storagePolicy?: SessionStoragePolicy; factInbox?: FactInboxSnapshot } {
  const value = snapshot as RuntimePersistenceSnapshot
  validateRuntimePersistenceSnapshot(value)
  const mutationLog = MutationLog.fromSnapshot(value.mutationLog)
  const state = importRuntimeState(value.checkpoint?.state ?? value.state)
  if (value.checkpoint) mutationLog.replay(state)
  return { state, mutationLog, outbox: EffectOutbox.fromSnapshot(value.outbox), ...(value.quarantine === undefined ? {} : { quarantine: value.quarantine.map((entry) => ({ ...entry })) }), ...(value.storage === undefined ? {} : { storagePolicy: SessionStoragePolicy.fromSnapshot(value.storage) }), ...(value.factInbox === undefined ? {} : { factInbox: structuredClone(value.factInbox) }) }
}
