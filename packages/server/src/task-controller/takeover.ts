import {
  contentHash, exportRuntimeCheckpoint, hydrateRuntimeSnapshotBodies, importRuntimePersistence,
  QuarantineScope, withRuntimePersistenceIntegrity,
  type LaneProgramDefinition, type RuntimePersistenceBackend,
} from '@hunterzhu/pulse-runtime'
import type { RecoveryFingerprints } from '../recovery-contract.js'

/** Rebind facts to the current engine. No tool, model or human effect is replayed here. */
export async function takeOverCurrentController(backend: RuntimePersistenceBackend, programs: LaneProgramDefinition[], fingerprints: RecoveryFingerprints, toolVersions: Record<string, string>): Promise<boolean> {
  const original = await backend.load()
  if (!original) return false
  const snapshot = original.snapshotBodies === 'external' && backend.snapshotStore ? await hydrateRuntimeSnapshotBodies(original, backend.snapshotStore) : original
  const restored = importRuntimePersistence(snapshot)
  const current = programs.find(program => program.id === 'pulse.assistant' && program.version === '58') ?? programs.find(program => program.id === 'pulse.assistant' && program.version === '57')
  const changed = contentHash(snapshot.compatibility?.fingerprints ?? null) !== contentHash(fingerprints)
  let rebound = changed
  const reboundLanes = new Set<string>()
  for (const lane of restored.state.lanes.values()) {
    if (!current || lane.resume.programId !== current.id || !/^\d+$/.test(lane.resume.programVersion)) continue
    const outdated = lane.resume.programVersion !== current.version || !current.steps.includes(lane.resume.step)
    if (!outdated && !changed) continue
    reboundLanes.add(lane.id)
    lane.resume.programVersion = current.version
    if (!['succeeded', 'failed', 'cancelled'].includes(lane.status)) {
      // Pending human/effect waits settle normally; the first subsequent step
      // enters diagnosis before any saved proposal can issue another operation.
      lane.context.state = { ...(lane.context.state && typeof lane.context.state === 'object' && !Array.isArray(lane.context.state) ? lane.context.state : {}), taskTakeoverRequired: true }
      lane.context.version++
      if (!current.steps.includes(lane.resume.step)) lane.resume.step = 'takeover'
    }
    rebound = true
  }
  if (!rebound) return false
  // Queued tools are checked against the current schema at dispatch. Running
  // side effects retain their identity and enter Runtime's existing reconciliation.
  const cancelledProposals = new Set<string>()
  for (const effect of restored.state.effects.values()) {
    if (effect.outcome) continue
    const outbox = restored.outbox.get(`${effect.id}:${effect.attemptId}`)
    if (reboundLanes.has(effect.ownerLaneId) && effect.kind !== 'human' && ['queued', 'retry_wait'].includes(effect.state) && outbox?.state !== 'claimed' && effect.sideEffectState === 'none') {
      effect.state = 'cancelled'; effect.executionState = 'local_closed'
      effect.outcome = { status: 'cancelled', reason: 'CONTROLLER_TAKEOVER_PENDING_OPERATION' }
      cancelledProposals.add(effect.id)
      restored.outbox.ack(`${effect.id}:${effect.attemptId}`)
      continue
    }
    if (effect.kind !== 'tool') continue
    const name = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input.name : undefined
    if (typeof name === 'string' && toolVersions[name]) effect.toolVersion = toolVersions[name]
    else delete effect.toolVersion
  }
  for (const wait of restored.state.waits.values()) {
    if (wait.state !== 'pending' || !reboundLanes.has(wait.laneId)) continue
    const cancelled = wait.spec.dependencies.filter(dependency => 'id' in dependency.target && cancelledProposals.has(dependency.target.id))
    if (!cancelled.length) continue
    // Cancellation is settlement of an obsolete proposal, never a successful
    // operation. Do not let an old fail_lane/any wait discard a real question.
    for (const dependency of cancelled) dependency.condition = 'settled'
    if (wait.spec.dependencies.some(dependency => 'id' in dependency.target && restored.state.effects.get(dependency.target.id)?.kind === 'human' && !restored.state.effects.get(dependency.target.id)?.outcome)) {
      wait.spec.mode = 'all'
      delete wait.spec.quorum
    }
  }
  const quarantine = new QuarantineScope()
  if (restored.quarantine) quarantine.restore(restored.quarantine)
  const checkpoint = exportRuntimeCheckpoint(restored.state, restored.mutationLog, restored.outbox, quarantine, restored.storagePolicy, {}, restored.factInbox, {
    schemaVersion: 1, programVersions: Object.fromEntries(programs.map(program => [`${program.id}@${program.version}`, program.version])), toolVersions, fingerprints,
  })
  await backend.save(withRuntimePersistenceIntegrity({ ...checkpoint,
    ...(original.resultBodies === 'external' ? { resultBodies: original.resultBodies, externalResultRefs: original.externalResultRefs } : {}),
    ...(original.eventArchive ? { eventArchive: original.eventArchive } : {}),
  }), original.integrity?.digest)
  return true
}
