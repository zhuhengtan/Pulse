import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseContextSnapshotRef } from '../core/types.js'
import type { JsonValue, RuntimeState } from '../core/types.js'
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
  checkpoint?: { schemaVersion: 1; logWatermark: number; eventWatermark?: number; state: SessionSnapshot }
}

export interface RuntimePersistenceBackend {
  load(): Promise<RuntimePersistenceSnapshot | undefined>
  save(snapshot: RuntimePersistenceSnapshot): Promise<void>
}

function hasTarget(state: SessionSnapshot['state'], target: { kind: string; id: string }): boolean {
  return target.kind === 'lane' ? state.lanes.some(([id]) => id === target.id) : target.kind === 'effect' ? state.effects.some(([id]) => id === target.id) : false
}

function hasDerivedReference(ref: string, ownerLaneId: string, agents: Map<string, any>, lanes: Map<string, any>, results: Map<string, any>): boolean {
  if (results.has(ref)) return true
  const parsed = parseContextSnapshotRef(ref)
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
  const state = value?.checkpoint?.state?.state ?? value?.state?.state
  if (!value || value.schemaVersion !== 1 || !value.state || !value.state.state || !value.mutationLog || !value.outbox || !Array.isArray(state?.agents) || !Array.isArray(state?.lanes) || !Array.isArray(state?.effects) || !Array.isArray(state?.waits) || !Array.isArray(state?.results) || !Array.isArray(state?.mergeProposals)) throw new Error('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  const agents = new Map(state.agents)
  const lanes = new Map(state.lanes)
  const effects = new Map(state.effects)
  const waits = new Map(state.waits)
  const results = new Map(state.results)
  for (const [id, agent] of agents) if (!lanes.has(agent.rootLaneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:agent.rootLaneId:${id}`)
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
    for (const resultRef of effect.derivedFrom ?? []) if (!hasDerivedReference(resultRef, effect.ownerLaneId, agents, lanes, results)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:effect.derivedFrom:${id}`)
  }
  for (const [id, wait] of waits) {
    if (!lanes.has(wait.laneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:wait.laneId:${id}`)
    for (const dependency of wait.spec.dependencies) if (!hasTarget(state, dependency.target as { kind: string; id: string })) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:wait.target:${id}`)
    if (wait.resolution) for (const dependency of Object.values(wait.resolution.dependencies)) if (!hasTarget(state, dependency.target)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:wait.resolution:${id}`)
  }
  for (const [id, proposal] of new Map(state.mergeProposals)) {
    if (!agents.has(proposal.agentId) || !lanes.has(proposal.sourceLaneId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:mergeProposal:${id}`)
    for (const ref of proposal.delta.derivedFrom ?? []) if (!hasDerivedReference(ref, proposal.sourceLaneId, agents, lanes, results)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:mergeProposal.derivedFrom:${id}`)
  }
  for (const entry of value.quarantine ?? []) if (!effects.has(entry.effectId)) throw new Error(`INVALID_RUNTIME_PERSISTENCE_REFERENCE:quarantine:${entry.effectId}`)
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

export function exportRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope, storagePolicy?: SessionStoragePolicy): RuntimePersistenceSnapshot {
  return { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: mutationLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), ...(storagePolicy === undefined ? {} : { storage: storagePolicy.snapshot() }) }
}

export function exportRuntimeCheckpoint(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, quarantine?: QuarantineScope, storagePolicy?: SessionStoragePolicy, options: { compactEventsThrough?: number } = {}): RuntimePersistenceSnapshot {
  const watermark = mutationLog.lastSequence
  const checkpointLog = new MutationLog([], watermark)
  const checkpointState = exportRuntimeState(state)
  const eventWatermark = options.compactEventsThrough
  if (eventWatermark !== undefined) {
    checkpointState.state.events = checkpointState.state.events.filter((event) => event.seq > eventWatermark)
    checkpointState.state.eventsCompactedThrough = Math.max(checkpointState.state.eventsCompactedThrough ?? 0, eventWatermark)
  }
  return { schemaVersion: 1, state: exportRuntimeState(state), mutationLog: checkpointLog.snapshot(), outbox: outbox.snapshot(), ...(quarantine === undefined ? {} : { quarantine: quarantine.snapshot() }), ...(storagePolicy === undefined ? {} : { storage: storagePolicy.snapshot() }), checkpoint: { schemaVersion: 1, logWatermark: watermark, ...(eventWatermark === undefined ? {} : { eventWatermark }), state: checkpointState } }
}

export function serializeRuntimePersistence(state: RuntimeState, mutationLog: MutationLog, outbox: EffectOutbox, storagePolicy?: SessionStoragePolicy): JsonValue {
  return exportRuntimePersistence(state, mutationLog, outbox, undefined, storagePolicy) as unknown as JsonValue
}

export function importRuntimePersistence(snapshot: RuntimePersistenceSnapshot | JsonValue): { state: RuntimeState; mutationLog: MutationLog; outbox: EffectOutbox; quarantine?: QuarantineEntry[]; storagePolicy?: SessionStoragePolicy } {
  const value = snapshot as RuntimePersistenceSnapshot
  validateRuntimePersistenceSnapshot(value)
  const mutationLog = MutationLog.fromSnapshot(value.mutationLog)
  const state = importRuntimeState(value.checkpoint?.state ?? value.state)
  if (value.checkpoint) mutationLog.replay(state)
  return { state, mutationLog, outbox: EffectOutbox.fromSnapshot(value.outbox), ...(value.quarantine === undefined ? {} : { quarantine: value.quarantine.map((entry) => ({ ...entry })) }), ...(value.storage === undefined ? {} : { storagePolicy: SessionStoragePolicy.fromSnapshot(value.storage) }) }
}
