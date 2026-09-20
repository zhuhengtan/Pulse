import { commitMutationTransaction, MutationLog } from '../storage/mutation-log.js'
import { buildAgent } from '../core/factory.js'
import { validateStep } from '../transitions/validate.js'
import { PriorityInheritance, ReadyQueue, readyItemFromLane, VirtualClock } from './index.js'
import type { ArtifactRecord, EffectRecord, EffectSubmission, EffectState, JsonValue, LaneRecord, LaneStepOutput, Outcome, ResumeInput, RuntimeState, RuntimeError, RuntimeEventInput, TargetRef, WaitRecord, ToolCallCorrelation, SeriesLaneSpec, ForkAffinityMode, PrivacyTaint, PrivacyMetadata, ProvenanceRef } from '../core/types.js'
import { createRuntimeState, effectivePrivacy, privacyMetadataForDerivedRef, privacyTaintsForDerivedRefs, provenanceRefId, provenanceRefKind, strictestPrivacy, validatePrivacyTaints } from '../core/types.js'
import { QuarantineScope } from '../lifecycle/scopes.js'
import { PulseSession } from '../dsl/session.js'
import { assertProgramPure } from '../dsl/program.js'
import { FactInbox, ObservationInbox } from '../core/inbox.js'
import { observeProgress, type ProgressObservation } from '../lifecycle/watchdog.js'
import { EffectOutbox } from '../storage/outbox.js'
import { exportRuntimeCheckpoint, exportRuntimePersistence, externalizeRuntimeResultBodies, externalizeRuntimeSnapshotBodies, hydrateRuntimeResultBodies, hydrateRuntimeSnapshotBodies, importRuntimePersistence, withRuntimePersistenceIntegrity, type RuntimePersistenceBackend, type RuntimePersistenceCompatibility, type RuntimePersistenceSnapshot } from '../storage/persistence.js'
import { ResourceLockManager } from './locks.js'
import { appendRuntimeEvent } from '../core/events.js'
import { apply, type Mutation } from '../core/mutations.js'
import { ContextMerger, type MergePlan } from '../context/merger.js'
import { appendHistory, contentHash, historyPressure } from '../context/builder.js'
import { validateJsonSchema } from '../models/router.js'
import { SessionStoragePolicy, type StoragePolicyConfig } from '../storage/policy.js'
import { collectRuntimeTelemetry, type RuntimeTelemetryExporter, type RuntimeTelemetrySnapshot } from './telemetry.js'
import { advanceArtifactId, markArtifactPersisted, pinArtifact, prepareArtifactPublication, readArtifact, unpinArtifact, type ArtifactPublication } from '../storage/artifacts.js'
import { prepareFindingPublication, type FindingPublication } from '../storage/findings.js'
import { runtimeErrorFromCause } from '../core/errors.js'

export interface LaneStepContext { lane: Readonly<LaneRecord>; state: Readonly<RuntimeState>; resumeInput?: ResumeInput; now: number; observe?: (event: { type: 'progress' | 'chunk' | 'trace' | 'warning' | 'diagnostic'; data: JsonValue }) => void }
export interface LaneProgram {
  id: string
  version: string
  entry?: string
  step: (context: LaneStepContext) => LaneStepOutput
  errorBoundary?: (error: RuntimeError, context: LaneStepContext) => LaneStepOutput
  seriesMember?: { programId: string; programVersion: string }
  seriesMemberProgram?: LaneProgram
  seriesKeys?: string[]
  seriesOnMemberFailure?: 'continue' | 'abort'
}
export interface EffectObservation { type: 'progress' | 'chunk' | 'trace' | 'warning' | 'diagnostic'; data: JsonValue }
export type EffectObservationEmitter = (observation: EffectObservation) => void
export interface EffectArtifactOutput { mediaType: string; content: Uint8Array | string; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; derivedFrom?: ProvenanceRef[] }
export interface EffectExecution { value: JsonValue; normalized?: JsonValue; artifact?: EffectArtifactOutput; summary?: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; sideEffectState?: 'none' | 'applied' | 'known' | 'unknown'; executionRef?: JsonValue; executionState?: 'succeeded' | 'failed' | 'remote_unknown'; status?: 'succeeded' | 'failed' | 'cancelled'; error?: RuntimeError; rejectedOutput?: { value: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; derivedFrom?: ProvenanceRef[] }; metadata?: JsonValue; observations?: EffectObservation[] }
export type EffectExecutor = (effect: Readonly<EffectRecord>, signal: AbortSignal, emitObservation?: EffectObservationEmitter) => Promise<EffectExecution>
export interface EffectHandle { id: string; status(): EffectState; requestCancel(reason: string): void }
export type HostCommand =
  | { type: 'reply'; agentId: string; effectId: string; value: JsonValue }
  | { type: 'cancel'; agentId: string; reason: string }
  | { type: 'cancel_effect'; agentId: string; effectId: string; reason: string }
  | { type: 'set_lane_priority'; laneId: string; priority: number }

export interface RuntimeConfig {
  maxLaneStepsPerTick?: number
  agingIntervalMs?: number
  agingCap?: number
  maxTotalLanes?: number
  maxQueuedEffects?: number
  maxRunning?: Partial<Record<'llm' | 'tool' | 'agent' | 'none', number>>
  forkAffinity?: ForkAffinityMode
  historySoftTokens?: number
  historyHardTokens?: number
  maxResultSummaryBytes?: number
  maxConsecutiveControlErrors?: number
  maxRuntimeMs?: number
  sessionId?: string
  maxAgentDepth?: number
  watchdogNoProgressThreshold?: number
  watchdogRepeatedActionThreshold?: number
  maxPreparingLLMs?: number
  maxPreparedLLMs?: number
  trustedSanitizerIds?: string[]
  storagePolicy?: StoragePolicyConfig
  persistence?: RuntimePersistenceSnapshot
  programs?: LaneProgram[]
  toolVersions?: Record<string, string>
  policyVersion?: string
  routerVersion?: string
  effectExecutor?: EffectExecutor
  effectSubmissionPreparer?: (submission: EffectSubmission) => EffectSubmission
  telemetryExporter?: RuntimeTelemetryExporter
  persistenceBackend?: RuntimePersistenceBackend
  budget?: RuntimeBudgetConfig
}

export interface RuntimeBudgetConfig { maxTotalAttempts?: number; maxLLMAttempts?: number; maxToolAttempts?: number; maxCostByCurrency?: Record<string, number> }
export interface WarmStartSpec { agentId: string; globalVersion?: number | 'latest' | 'final'; include?: 'facts' | 'facts_and_findings'; relevanceRefs?: string[] }
export interface AgentCreateRequest { goal: string; program: LaneProgram; agentId?: string; maxActiveLanes?: number; warmStart?: WarmStartSpec; parentAgentId?: string; inheritedFloor?: number }
export interface BackgroundAgentInfo { agentId: string; rootLaneId: string; state: NonNullable<import('../core/types.js').AgentRecord['state']>; detached: true }

function warmStartGlobal(value: JsonValue, include: 'facts' | 'facts_and_findings', relevanceRefs: string[] | undefined): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value)
  const output = structuredClone(value) as Record<string, JsonValue>
  if (include === 'facts') { delete output.findings }
  else if (relevanceRefs !== undefined && Array.isArray(output.findings)) {
    const refs = new Set(relevanceRefs)
    output.findings = output.findings.filter((finding) => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false
      const record = finding as Record<string, JsonValue>
      if (typeof record.ref === 'string' || typeof record.id === 'string') return refs.has((record.ref ?? record.id) as string)
      return Array.isArray(record.derivedFrom) && record.derivedFrom.some((ref) => typeof ref === 'string' && refs.has(ref))
    })
  }
  return output
}

function outcomeForLane(lane: LaneRecord): Outcome | undefined {
  if (lane.status === 'succeeded') return { status: 'succeeded', ...(lane.resultRef === undefined ? {} : { resultRef: lane.resultRef }) }
  if (lane.status === 'failed') return { status: 'failed' }
  if (lane.status === 'cancelled') return { status: 'cancelled' }
  return undefined
}

function outcomeForSeriesMember(state: RuntimeState, lane: LaneRecord, key: string): Outcome | undefined {
  const aggregate = outcomeForLane(lane)
  if (!aggregate || lane.series === undefined || lane.resultRef === undefined) return aggregate
  const value = state.results.get(lane.resultRef)?.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return aggregate
  const results = value.results
  if (!results || typeof results !== 'object' || Array.isArray(results)) return aggregate
  const member = results[key]
  if (!member || typeof member !== 'object' || Array.isArray(member)) return aggregate
  const record = member as Record<string, JsonValue>
  const status = record.status
  if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') return aggregate
  return {
    status,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? { error: record.error as unknown as RuntimeError } : {}),
  }
}

export class PulseRuntime {
  readonly state: RuntimeState
  private shuttingDown = false
  private readonly telemetryExporter: RuntimeTelemetryExporter | undefined
  private readonly persistenceBackend: RuntimePersistenceBackend | undefined
  private readonly enforcingRecoveryPrograms: boolean
  private readonly toolVersions: Readonly<Record<string, string>>
  private readonly recoveryCompatibility: RuntimePersistenceCompatibility | undefined
  private readonly policyVersion: string | undefined
  private readonly routerVersion: string | undefined
  private readonly budget: RuntimeBudgetConfig
  private persistenceDigest: string | undefined
  private readonly budgetCost = new Map<string, number>()
  private persistencePending: Promise<void> = Promise.resolve()
  private persistenceScheduled = false
  private persistenceDirty = false
  private dispatchPersistencePending = false
  readonly mutationLog: MutationLog
  readonly outbox: EffectOutbox
  readonly clock: VirtualClock
  readonly ready: ReadyQueue
  readonly quarantine = new QuarantineScope()
  readonly priorityInheritance = new PriorityInheritance()
  readonly resourceLocks = new ResourceLockManager()
  readonly storagePolicy: SessionStoragePolicy
  readonly factInbox: FactInbox<HostCommand>
  readonly observationInbox = new ObservationInbox()
  private readonly programs = new Map<string, LaneProgram>()
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void>; timeoutTimer?: string; deadlineTimer?: string; cancelTimer?: string }>()
  private readonly lockReleases = new Map<string, Array<() => void>>()
  private readonly waitDeadlineTimers = new Map<string, string>()
  private readonly lockBlocked = new Set<string>()
  private readonly executor: EffectExecutor
  private readonly customExecutor: boolean
  private enqueueSeq = 1
  private readonly maxSteps: number
  private readonly maxConsecutiveControlErrors: number
  private readonly maxRuntimeMs?: number
  private readonly watchdogNoProgressThreshold: number
  private readonly watchdogRepeatedActionThreshold: number
  private readonly maxAgentDepth: number
  private readonly maxPreparingLLMs: number
  private readonly maxPreparedLLMs: number
  private readonly effectSubmissionPreparer: ((submission: EffectSubmission) => EffectSubmission) | undefined
  private readonly preparingLLMs = new Set<string>()
  private readonly sessionId: string
  private hostCommandSeq = 1
  private factWaiters: Array<() => void> = []

  static async restore(backend: RuntimePersistenceBackend, config: Omit<RuntimeConfig, 'persistence'> = {}): Promise<PulseRuntime> {
    const loaded = await backend.load()
    if (loaded?.snapshotBodies === 'external' && backend.snapshotStore === undefined) throw new Error('RUNTIME_SNAPSHOT_STORE_REQUIRED')
    const withSnapshots = loaded === undefined || backend.snapshotStore === undefined ? loaded : await hydrateRuntimeSnapshotBodies(loaded, backend.snapshotStore)
    const snapshot = withSnapshots === undefined || backend.resultStore === undefined ? withSnapshots : await hydrateRuntimeResultBodies(withSnapshots, backend.resultStore)
    if (snapshot?.resultBodies === 'external' && backend.resultStore === undefined) throw new Error('RUNTIME_RESULT_STORE_REQUIRED')
    return new PulseRuntime(snapshot === undefined ? config : { ...config, persistence: snapshot })
  }

  constructor(config: RuntimeConfig = {}) {
    const restored = config.persistence === undefined ? undefined : importRuntimePersistence(config.persistence)
    this.enforcingRecoveryPrograms = restored !== undefined
    this.toolVersions = { ...(config.toolVersions ?? {}) }
    this.policyVersion = config.policyVersion
    this.routerVersion = config.routerVersion
    this.state = restored?.state ?? createRuntimeState(config.maxTotalLanes ?? 64, { ...(config.maxQueuedEffects === undefined ? {} : { maxQueuedEffects: config.maxQueuedEffects }), ...(config.maxRunning === undefined ? {} : { maxRunning: config.maxRunning }), ...(config.forkAffinity === undefined ? {} : { forkAffinity: config.forkAffinity }), ...(config.historySoftTokens === undefined ? {} : { historySoftTokens: config.historySoftTokens }), ...(config.historyHardTokens === undefined ? {} : { historyHardTokens: config.historyHardTokens }), ...(config.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: config.maxResultSummaryBytes }), ...(config.trustedSanitizerIds === undefined ? {} : { trustedSanitizerIds: config.trustedSanitizerIds }) })
    if (config.trustedSanitizerIds) for (const sanitizerId of config.trustedSanitizerIds) this.state.trustedSanitizerIds.add(sanitizerId)
    this.sessionId = config.sessionId ?? 'session-local'
    this.storagePolicy = restored?.storagePolicy ?? new SessionStoragePolicy(config.storagePolicy)
    this.persistenceDigest = config.persistence?.integrity?.digest
    this.mutationLog = restored?.mutationLog ?? new MutationLog()
    this.outbox = restored?.outbox ?? new EffectOutbox()
    this.factInbox = restored?.factInbox === undefined ? new FactInbox<HostCommand>() : FactInbox.fromSnapshot<HostCommand>(restored.factInbox as unknown as import('../core/inbox.js').FactInboxSnapshot<HostCommand>)
    for (const program of config.programs ?? []) this.register(program)
    this.recoveryCompatibility = restored?.compatibility
    const restoredCommandIds = this.factInbox.snapshot().seen.map((eventId) => /^host-command-(\d+)$/.exec(eventId)?.[1]).filter((value): value is string => value !== undefined).map(Number)
    if (restoredCommandIds.length) this.hostCommandSeq = Math.max(...restoredCommandIds) + 1
    if (restored?.quarantine) this.quarantine.restore(restored.quarantine)
    if (restored) {
      const recovery = this.outbox.recover(this.state)
      for (const id of recovery.requeued) this.emit({ type: 'outbox.requeued', data: id })
      for (const id of recovery.unknown) this.emit({ type: 'outbox.discarded', data: id })
    }
    this.clock = new VirtualClock()
    this.ready = new ReadyQueue(config.agingIntervalMs ?? 1000, config.agingCap ?? Number.POSITIVE_INFINITY)
    if (restored) {
      this.clock.set(this.state.now)
      for (const lane of this.state.lanes.values()) if (lane.status === 'ready') this.ready.enqueue(readyItemFromLane(lane))
      for (const effect of this.state.effects.values()) {
        const outboxEntry = this.outbox.get(`${effect.id}:${effect.attemptId}`)
        if (effect.state === 'running' && (outboxEntry === undefined || outboxEntry.state === 'pending')) {
          const recovered = structuredClone(effect)
          const recoveryReason = effect.sideEffectPolicy === 'write' ? 'recovery_in_doubt' : 'recovery_requeue'
          if (effect.sideEffectPolicy === 'write') { recovered.state = 'reconcile_required'; recovered.executionState = 'remote_unknown'; recovered.sideEffectState = 'unknown' }
          else { recovered.state = 'queued'; recovered.executionState = 'local' }
          commitMutationTransaction(this.state, this.mutationLog, `recovery:${effect.id}:${effect.attemptId}:${recoveryReason}`, [{ op: 'setEffect', effectId: effect.id, record: recovered }], this.state.now, this.sessionId)
          if (effect.sideEffectPolicy === 'write') this.quarantine.add(effect.id, this.state.now, 'recovery_in_doubt')
        }
        if (effect.state === 'retry_wait' && effect.retryAt !== undefined) {
          const attemptId = effect.attemptId
          this.clock.timers.schedule(effect.retryAt, () => this.readyRetryEffect(effect.id, attemptId))
        }
      }
      for (const effect of [...this.state.effects.values()].sort((left, right) => left.id.localeCompare(right.id))) if (effect.state === 'reconcile_required' && effect.sideEffectState === 'unknown') {
        const releases = [...(effect.locks ?? [])].sort((left, right) => left.resource.localeCompare(right.resource) || left.mode.localeCompare(right.mode)).map((lock, index) => this.resourceLocks.restoreHeld(lock.resource, lock.mode, `${effect.id}:${effect.attemptId}:recovery:${index}`))
        if (releases.length) this.lockReleases.set(effect.id, releases)
        if (!this.quarantine.has(effect.id)) this.quarantine.add(effect.id, this.state.now, 'recovery_in_doubt')
      }
      for (const wait of this.state.waits.values()) if (wait.state === 'pending') this.scheduleWaitDeadline(wait)
    }
    this.maxSteps = config.maxLaneStepsPerTick ?? 32
    this.maxConsecutiveControlErrors = config.maxConsecutiveControlErrors ?? 2
    if (config.maxRuntimeMs !== undefined) this.maxRuntimeMs = config.maxRuntimeMs
    this.watchdogNoProgressThreshold = config.watchdogNoProgressThreshold ?? 3
    this.watchdogRepeatedActionThreshold = config.watchdogRepeatedActionThreshold ?? 3
    this.maxAgentDepth = config.maxAgentDepth ?? 1
    this.maxPreparingLLMs = config.maxPreparingLLMs ?? 2
    this.maxPreparedLLMs = config.maxPreparedLLMs ?? 8
    this.effectSubmissionPreparer = config.effectSubmissionPreparer
    this.telemetryExporter = config.telemetryExporter
    this.persistenceBackend = config.persistenceBackend
    this.budget = config.budget ?? {}
    if (restored) for (const event of this.state.events) if (event.type === 'effect.execution_metadata') this.recordBudgetMetadata(event.data ?? event.payload)
    this.customExecutor = config.effectExecutor !== undefined
    this.executor = config.effectExecutor ?? (async () => ({ value: null }))
    if (restored) this.clock.set(this.state.now)
    this.syncStoragePolicy()
  }

  register(program: LaneProgram): void { assertProgramPure(program); this.programs.set(`${program.id}@${program.version}`, program); if (program.seriesMemberProgram) this.register(program.seriesMemberProgram) }
  createAgent(request: AgentCreateRequest): { agentId: string; laneId: string }
  createAgent(goal: string, program: LaneProgram, agentId?: string): { agentId: string; laneId: string }
  createAgent(goalOrRequest: string | AgentCreateRequest, program?: LaneProgram, agentId?: string): { agentId: string; laneId: string } {
    if (this.shuttingDown) throw new Error('RUNTIME_SHUTTING_DOWN')
    const request: AgentCreateRequest = typeof goalOrRequest === 'string' ? { goal: goalOrRequest, program: program!, ...(agentId === undefined ? {} : { agentId }) } : goalOrRequest
    const warmStart = request.warmStart
    let initialGlobal: JsonValue | undefined
    let initialGlobalPrivacy: PrivacyMetadata | undefined
    let warmStartResultRefs: string[] = []
    if (warmStart) {
      const source = this.state.agents.get(warmStart.agentId)
      if (!source) throw new Error(`WARM_START_SOURCE_NOT_FOUND:${warmStart.agentId}`)
      const version = warmStart.globalVersion === 'latest' || warmStart.globalVersion === 'final' || warmStart.globalVersion === undefined ? source.latestGlobalVersion : warmStart.globalVersion
      const value = source.globalVersions.get(version)
      if (value === undefined) throw new Error(`WARM_START_VERSION_NOT_FOUND:${version}`)
      initialGlobal = warmStartGlobal(value, warmStart.include ?? 'facts', warmStart.relevanceRefs)
      initialGlobalPrivacy = source.globalPrivacy?.get(version) === undefined ? undefined : structuredClone(source.globalPrivacy.get(version))
      warmStartResultRefs = [...new Set(warmStart.relevanceRefs ?? [])]
      const sourceRoot = this.state.lanes.get(source.rootLaneId)
      for (const ref of warmStartResultRefs) {
        if (!this.state.results.has(ref)) throw new Error(`WARM_START_RESULT_NOT_FOUND:${ref}`)
        if (sourceRoot?.visibleResultRefs !== undefined && !sourceRoot.visibleResultRefs.has(ref)) throw new Error(`WARM_START_RESULT_NOT_VISIBLE:${ref}`)
      }
    }
    this.register(request.program)
    if (this.state.lanes.size >= this.state.maxTotalLanes) throw new Error('MAX_TOTAL_LANES')
    if (request.agentId !== undefined && this.state.agents.has(request.agentId)) throw new Error(`AGENT_ID_EXISTS:${request.agentId}`)
    const parent = request.parentAgentId === undefined ? undefined : this.state.agents.get(request.parentAgentId)
    if (request.parentAgentId !== undefined && !parent) throw new Error(`PARENT_AGENT_NOT_FOUND:${request.parentAgentId}`)
    const { agent, root, nextIds } = buildAgent(this.state, request.goal, { programId: request.program.id, programVersion: request.program.version, step: (request.program as LaneProgram & { entry?: string }).entry ?? 'start', locals: {} }, { ...(request.agentId === undefined ? {} : { agentId: request.agentId }), ...(request.maxActiveLanes === undefined ? {} : { maxActiveLanes: request.maxActiveLanes }), ...(initialGlobal === undefined ? {} : { initialGlobal }), ...(initialGlobalPrivacy === undefined ? {} : { initialGlobalPrivacy }), ...(request.parentAgentId === undefined ? {} : { parentAgentId: request.parentAgentId, depth: (parent?.depth ?? 0) + 1 }), ...(request.inheritedFloor === undefined ? {} : { inheritedFloor: request.inheritedFloor }) })
    if (warmStartResultRefs.length) root.visibleResultRefs = new Set(warmStartResultRefs)
    if (request.program.seriesKeys?.length) root.resume.locals = { $sdk: { series: { keys: [...request.program.seriesKeys], index: 0 } } }
    root.enqueueSeq = this.enqueueSeq++
    agent.state = 'running'
    const mutations: Mutation[] = [
      { op: 'setAgent', agentId: agent.id, record: agent },
      { op: 'setLane', laneId: root.id, record: root },
      { op: 'setNextIds', nextIds },
    ]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `agent:${agent.id}:created`, mutations, this.state.now, this.sessionId)
    const committedRoot = this.state.lanes.get(root.id)!
    this.ready.enqueue(readyItemFromLane(committedRoot))
    this.syncStoragePolicy()
    this.schedulePersistence()
    return { agentId: agent.id, laneId: root.id }
  }
  start(agentId: string): PulseSession { if (!this.state.agents.has(agentId)) throw new Error(`UNKNOWN_AGENT:${agentId}`); return new PulseSession(this, agentId) }
  requestCancel(agentId: string, reason = 'USER_REQUESTED'): void {
    if (!agentId) throw new Error('INVALID_AGENT_ID')
    if (!reason) throw new Error('INVALID_CANCEL_REASON')
    this.enqueueHostCommand({ type: 'cancel', agentId, reason })
  }
  setLanePriority(laneId: string, priority: number): void {
    if (!laneId) throw new Error('INVALID_LANE_ID')
    if (!Number.isFinite(priority)) throw new Error('INVALID_LANE_PRIORITY')
    this.enqueueHostCommand({ type: 'set_lane_priority', laneId, priority })
  }
  effectHandle(effectId: string): EffectHandle {
    const effect = this.state.effects.get(effectId)
    if (!effect) throw new Error(`UNKNOWN_EFFECT:${effectId}`)
    return {
      id: effectId,
      status: () => {
        const current = this.state.effects.get(effectId)
        if (!current) throw new Error(`UNKNOWN_EFFECT:${effectId}`)
        return current.state
      },
      requestCancel: (reason) => {
        if (!reason) throw new Error('INVALID_CANCEL_REASON')
        this.enqueueHostCommand({ type: 'cancel_effect', agentId: effect.agentId, effectId, reason })
      },
    }
  }
  inspectLane(laneId: string): JsonValue {
    if (!laneId) throw new Error('INVALID_LANE_ID')
    return this.explain(laneId)
  }
  detachAgent(agentId: string): BackgroundAgentInfo {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    const event = { type: 'agent.detached' as const, agentId, data: { agentId } }
    const nextAgent = structuredClone(agent)
    nextAgent.detached = true
    const mutations: Mutation[] = [{ op: 'setAgent', agentId, record: nextAgent }, { op: 'appendEvent', event }]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `agent:${agentId}:detached`, mutations, this.state.now, this.sessionId)
    Object.assign(agent, nextAgent)
    this.state.agents.set(agentId, agent)
    this.schedulePersistence()
    return { agentId, rootLaneId: agent.rootLaneId, state: agent.state ?? 'created', detached: true }
  }
  attachAgent(agentId: string): void {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    if (!agent.detached) return
    const event = { type: 'agent.attached' as const, agentId, data: { agentId } }
    const nextAgent = structuredClone(agent)
    delete nextAgent.detached
    const mutations: Mutation[] = [{ op: 'setAgent', agentId, record: nextAgent }, { op: 'appendEvent', event }]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `agent:${agentId}:attached`, mutations, this.state.now, this.sessionId)
    Object.assign(agent, nextAgent)
    delete agent.detached
    this.state.agents.set(agentId, agent)
    this.schedulePersistence()
  }
  backgroundAgents(): BackgroundAgentInfo[] {
    return [...this.state.agents.values()].filter((agent) => agent.detached === true).map((agent) => ({ agentId: agent.id, rootLaneId: agent.rootLaneId, state: agent.state ?? 'created', detached: true }))
  }
  exportPersistence(): RuntimePersistenceSnapshot { return exportRuntimePersistence(this.state, this.mutationLog, this.outbox, this.quarantine, this.storagePolicy, this.factInbox.snapshot(), this.persistenceCompatibility()) }
  async persist(backend: RuntimePersistenceBackend): Promise<void> {
    const persistedPolicy = this.storagePolicy.clone()
    persistedPolicy.markPersisted()
    const exported = exportRuntimePersistence(this.persistenceState(), this.mutationLog, this.outbox, this.quarantine, persistedPolicy, this.factInbox.snapshot(), this.persistenceCompatibility())
    const withResults = backend.resultStore === undefined ? exported : await externalizeRuntimeResultBodies(exported, backend.resultStore)
    const snapshot = backend.snapshotStore === undefined ? withResults : await externalizeRuntimeSnapshotBodies(withResults, backend.snapshotStore)
    await backend.save(snapshot, backend === this.persistenceBackend ? this.persistenceDigest : undefined)
    if (backend === this.persistenceBackend) this.persistenceDigest = snapshot.integrity?.digest
    this.storagePolicy.markPersisted()
    this.markArtifactsPersisted()
    this.syncStoragePolicy()
  }
  async flushPersistence(): Promise<void> {
    if (!this.persistenceBackend) return
    this.schedulePersistence()
    while (true) {
      await this.persistencePending
      if (!this.persistenceDirty) return
      this.schedulePersistence()
    }
  }
  async checkpoint(backend: RuntimePersistenceBackend, options: { compactEventsThrough?: number } = {}): Promise<RuntimePersistenceSnapshot> {
    const persistedPolicy = this.storagePolicy.clone()
    persistedPolicy.markPersisted()
    const eventWatermark = options.compactEventsThrough ?? this.state.events.at(-1)?.seq
    if (backend.eventArchive !== undefined && eventWatermark !== undefined) {
      const fromSeq = (this.state.eventsCompactedThrough ?? 0) + 1
      const events = this.state.events.filter((event) => event.seq >= fromSeq && event.seq <= eventWatermark)
      if (events.length) await backend.eventArchive.append(events)
    }
    const exported = exportRuntimeCheckpoint(this.persistenceState(), this.mutationLog, this.outbox, this.quarantine, persistedPolicy, eventWatermark === undefined ? {} : { compactEventsThrough: eventWatermark }, this.factInbox.snapshot(), this.persistenceCompatibility())
    const archived = backend.eventArchive === undefined || eventWatermark === undefined ? exported : withRuntimePersistenceIntegrity({ ...exported, eventArchive: { through: eventWatermark } })
    const withResults = backend.resultStore === undefined ? archived : await externalizeRuntimeResultBodies(archived, backend.resultStore)
    const snapshot = backend.snapshotStore === undefined ? withResults : await externalizeRuntimeSnapshotBodies(withResults, backend.snapshotStore)
    await backend.save(snapshot, backend === this.persistenceBackend ? this.persistenceDigest : undefined)
    if (backend === this.persistenceBackend) this.persistenceDigest = snapshot.integrity?.digest
    this.storagePolicy.markPersisted()
    this.markArtifactsPersisted()
    this.syncStoragePolicy()
    const watermark = snapshot.checkpoint?.logWatermark ?? 0
    if (watermark > 0 && this.mutationLog.lastSequence >= watermark) this.mutationLog.truncateThrough(watermark)
    if (eventWatermark !== undefined) {
      this.state.events = this.state.events.filter((event) => event.seq > eventWatermark)
      this.state.eventsCompactedThrough = Math.max(this.state.eventsCompactedThrough ?? 0, eventWatermark)
    }
    this.schedulePersistence()
    return snapshot
  }
  mergeProposals(agentId: string, proposalIds?: string[]): MergePlan {
    const plan = new ContextMerger(this.state).plan(agentId, proposalIds)
    if (plan.conflicts.length || plan.mutations.length === 0) return plan
    commitMutationTransaction(this.state, this.mutationLog, `context-merge:${agentId}:${plan.version ?? this.state.now}`, plan.mutations, this.state.now, this.sessionId)
    this.schedulePersistence()
    return plan
  }

  private emit(event: import('../core/types.js').RuntimeEventInput): import('../core/types.js').RuntimeEvent {
    const candidate = structuredClone(this.state)
    appendRuntimeEvent(candidate, event, { sessionId: this.sessionId, timestamp: candidate.now })
    const policy = this.storagePolicy.clone()
    this.syncStoragePolicy(policy, candidate)
    const emitted = appendRuntimeEvent(this.state, event, { sessionId: this.sessionId, timestamp: this.state.now })
    this.syncStoragePolicy()
    return emitted
  }
  private assertRecoveryPrograms(): void {
    if (!this.enforcingRecoveryPrograms) return
    if (this.recoveryCompatibility !== undefined) this.assertRecoveryCompatibility(this.recoveryCompatibility)
    for (const lane of this.state.lanes.values()) {
      if (['succeeded', 'failed', 'cancelled'].includes(lane.status)) continue
      const key = `${lane.resume.programId}@${lane.resume.programVersion}`
      if (!this.programs.has(key)) throw new Error(`PROGRAM_VERSION_UNAVAILABLE:${key}`)
    }
    for (const effect of this.state.effects.values()) {
      if (effect.outcome || ['succeeded', 'failed', 'cancelled'].includes(effect.state)) continue
      if (effect.kind !== 'tool' || effect.toolVersion === undefined) continue
      const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
      const name = input.name
      if (typeof name !== 'string' || this.toolVersions[name] !== effect.toolVersion) throw new Error(`TOOL_VERSION_UNAVAILABLE:${typeof name === 'string' ? `${name}@${effect.toolVersion}` : effect.toolVersion}`)
    }
  }
  private persistenceCompatibility(): RuntimePersistenceCompatibility {
    return {
      schemaVersion: 1,
      programVersions: Object.fromEntries([...this.programs.entries()].map(([key, program]) => [key, program.version])),
      toolVersions: { ...this.toolVersions },
      ...(this.policyVersion === undefined ? {} : { policyVersion: this.policyVersion }),
      ...(this.routerVersion === undefined ? {} : { routerVersion: this.routerVersion }),
    }
  }
  private assertRecoveryCompatibility(expected: RuntimePersistenceCompatibility): void {
    for (const [key, version] of Object.entries(expected.programVersions)) {
      const program = this.programs.get(key)
      if (!program || program.version !== version) throw new Error(`PROGRAM_VERSION_UNAVAILABLE:${key}`)
    }
    for (const [name, version] of Object.entries(expected.toolVersions)) if (this.toolVersions[name] !== version) throw new Error(`TOOL_VERSION_UNAVAILABLE:${name}@${version}`)
    if (expected.policyVersion !== undefined && this.policyVersion !== expected.policyVersion) throw new Error(`POLICY_VERSION_UNAVAILABLE:${expected.policyVersion}`)
    if (expected.routerVersion !== undefined && this.routerVersion !== expected.routerVersion) throw new Error(`ROUTER_VERSION_UNAVAILABLE:${expected.routerVersion}`)
  }
  private tryEmit(event: import('../core/types.js').RuntimeEventInput): import('../core/types.js').RuntimeEvent | undefined {
    try {
      this.assertStorageAdmission([{ op: 'appendEvent', event }])
      return this.emit(event)
    } catch {
      return undefined
    }
  }
  private rejectHostCommand(eventId: string, code: string): void {
    const mutations: Mutation[] = [
      { op: 'appendEvent', event: { type: 'command.rejected', data: { eventId, code } } },
      { op: 'appendEvent', event: { type: 'command.applied', data: { eventId } } },
    ]
    this.assertStorageAdmission(mutations)
    commitMutationTransaction(this.state, this.mutationLog, `host-command:${eventId}:rejected`, mutations, this.state.now, this.sessionId)
  }
  private prepareStepOutput(output: LaneStepOutput): LaneStepOutput {
    if (!this.effectSubmissionPreparer) return output
    return { ...output, actions: output.actions.map((action) => action.type === 'submit_effects' ? { ...action, effects: action.effects.map((effect) => this.effectSubmissionPreparer!(effect)) } : action) }
  }
  private journalEffect(effect: EffectRecord, transactionId: string, result?: import('../core/types.js').ResultRecord, events: import('../core/types.js').RuntimeEvent[] = [], lane?: LaneRecord, correlation?: ToolCallCorrelation, artifact?: ArtifactRecord): void {
    const mutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: structuredClone(effect) }]
    if (artifact) mutations.push({ op: 'publishArtifact', record: structuredClone(artifact) })
    if (result) mutations.push({ op: 'publishResult', record: structuredClone(result) })
    if (lane) mutations.push({ op: 'setLane', laneId: lane.id, record: structuredClone(lane) })
    if (correlation) mutations.push({ op: 'setToolCallCorrelation', record: structuredClone(correlation) })
    for (const event of events) {
      if (event.txId === undefined) event.txId = transactionId
      const { seq: _seq, ...input } = event
      mutations.push({ op: 'appendEvent', event: input })
    }
    this.mutationLog.append(transactionId, mutations, this.state.now)
  }

  enqueueHostCommand(command: HostCommand): void {
    const eventId = `host-command-${this.hostCommandSeq}`
    const candidateInbox = FactInbox.fromSnapshot(this.factInbox.snapshot())
    if (!candidateInbox.enqueue(command, eventId)) return
    const candidatePolicy = this.storagePolicy.clone()
    this.syncStoragePolicy(candidatePolicy, this.state, candidateInbox)
    const envelope = this.factInbox.enqueue(command, eventId)
    if (!envelope) return
    this.hostCommandSeq++
    this.syncStoragePolicy()
    this.schedulePersistence()
    for (const resolve of this.factWaiters.splice(0)) resolve()
  }

  enqueueLane(laneId: string): void { const lane = this.state.lanes.get(laneId); if (lane && lane.status === 'ready') { lane.enqueueSeq = this.enqueueSeq++; lane.readySince = this.state.now; this.ready.enqueue(readyItemFromLane(lane)) } }

  private seriesStep(program: LaneProgram, context: LaneStepContext, series?: SeriesLaneSpec): LaneStepOutput {
    const locals = context.lane.resume.locals && typeof context.lane.resume.locals === 'object' && !Array.isArray(context.lane.resume.locals) ? context.lane.resume.locals as Record<string, JsonValue> : {}
    const sdkValue = locals.$sdk && typeof locals.$sdk === 'object' && !Array.isArray(locals.$sdk) ? locals.$sdk as Record<string, JsonValue> : {}
    const seriesValue = sdkValue.series && typeof sdkValue.series === 'object' && !Array.isArray(sdkValue.series) ? sdkValue.series as Record<string, JsonValue> : {}
    const keys = Array.isArray(seriesValue.keys) ? seriesValue.keys.filter((key): key is string => typeof key === 'string') : (series?.keys ?? program.seriesKeys ?? ['member'])
    const index = typeof seriesValue.index === 'number' && Number.isInteger(seriesValue.index) && seriesValue.index >= 0 ? seriesValue.index : 0
    const memberRef = series?.member ?? (program.seriesMember ? { programId: program.seriesMember.programId, programVersion: program.seriesMember.programVersion, step: 'start', locals: {} } : undefined)
    const member = memberRef === undefined ? undefined : this.programs.get(`${memberRef.programId}@${memberRef.programVersion}`)
    if (!member || memberRef === undefined) return { actions: [{ type: 'fail', error: { code: 'PROGRAM_NOT_REGISTERED', message: memberRef ? `${memberRef.programId}@${memberRef.programVersion}` : 'series member' } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals } }
    if (index >= keys.length) return { actions: [{ type: 'complete', result: sdkValue.seriesResults ?? { results: {} } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals } }
    const memberLocals = sdkValue.memberLocals ?? {}
    const memberLane = structuredClone(context.lane) as LaneRecord
    memberLane.resume = { programId: member.id, programVersion: member.version, step: typeof sdkValue.memberStep === 'string' ? sdkValue.memberStep : memberRef.step ?? (member as LaneProgram & { entry?: string }).entry ?? 'start', locals: structuredClone(memberLocals) }
    memberLane.goal = series?.goals?.[keys[index]!] ?? `${context.lane.goal} [series:${keys[index]}]`
    const seriesResults = sdkValue.seriesResults && typeof sdkValue.seriesResults === 'object' && !Array.isArray(sdkValue.seriesResults) ? sdkValue.seriesResults as Record<string, JsonValue> : {}
    const nextLocals = (nextSdk: Record<string, JsonValue>): JsonValue => ({ ...locals, $sdk: nextSdk })
    const nextAfterMember = (nextIndex: number): LaneStepOutput => { const nextSdk: Record<string, JsonValue> = { ...sdkValue, series: { keys, index: nextIndex }, seriesResults }; delete nextSdk.memberStep; delete nextSdk.memberLocals; return nextIndex >= keys.length ? { actions: [{ type: 'complete', result: { results: seriesResults } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals(nextSdk) } } : { actions: [], next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals(nextSdk) } } }
    const memberDependencies = series?.members?.[keys[index]!]?.dependsOn ?? []
    const dependencyObservations = Object.fromEntries(memberDependencies.map((dependency) => {
      const record = seriesResults[dependency.key]
      const value = record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, JsonValue> : {}
      const status = value.status === 'succeeded' || value.status === 'failed' || value.status === 'cancelled' ? value.status : undefined
      const outcome: Outcome = status === undefined ? { status: 'failed', error: { code: 'SERIES_DEPENDENCY_MISSING', message: `Series dependency ${dependency.key} is not settled.` } } : { status, ...(value.result === undefined ? {} : { result: value.result }), ...(value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? { error: value.error as unknown as RuntimeError } : {}) }
      return [dependency.key, { state: 'settled' as const, target: { kind: 'lane' as const, id: `series:${dependency.key}` }, outcome }]
    }))
    const blocked = memberDependencies.find((dependency) => dependency.condition === 'success' && dependencyObservations[dependency.key]?.outcome.status !== 'succeeded')
    if (blocked) {
      seriesResults[keys[index]!] = { status: 'failed', error: { code: 'DEPENDENCY_FAILED', message: `Series dependency ${blocked.key} did not succeed` } }
      if ((series?.onMemberFailure ?? program.seriesOnMemberFailure ?? 'continue') === 'abort') return { actions: [{ type: 'fail', error: { code: 'DEPENDENCY_FAILED', message: `Series dependency ${blocked.key} did not succeed` } }], next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals({ ...sdkValue, series: { keys, index }, seriesResults }) } }
      return nextAfterMember(index + 1)
    }
    const output = member.step({ ...context, lane: memberLane, ...(memberDependencies.length && sdkValue.memberStep === undefined ? { resumeInput: { type: 'wait', resolution: { waitId: `series:${keys[index]}`, status: 'satisfied', dependencies: dependencyObservations } } } : {}) })
    const terminal = output.actions.find((action) => action.type === 'complete' || action.type === 'fail')
    if (terminal?.type === 'fail') {
      seriesResults[keys[index]!] = { status: 'failed', error: terminal.error as unknown as JsonValue }
      if ((series?.onMemberFailure ?? program.seriesOnMemberFailure ?? 'continue') === 'abort') return output
    } else if (terminal?.type === 'complete') {
      seriesResults[keys[index]!] = { status: 'succeeded', result: terminal.result }
    }
    if (terminal) {
      const nextIndex = index + 1
      return nextAfterMember(nextIndex)
    }
    const nextSdk: Record<string, JsonValue> = { ...sdkValue, series: { keys, index }, memberStep: output.next.step, memberLocals: output.next.locals }
    return { ...output, next: { programId: program.id, programVersion: program.version, step: 'start', locals: nextLocals(nextSdk) } }
  }

  tick(): number {
    this.assertRecoveryPrograms()
    this.state.now = this.clock.now()
    while (this.factInbox.size > 0) {
      const before = this.factInbox.snapshot()
      const envelope = this.factInbox.drain(1)[0]
      if (!envelope) break
      try {
        let commandApplied = false
        if (!this.state.events.some((event) => event.id === envelope.eventId && event.type === 'command.enqueued')) this.emit({ id: envelope.eventId, type: 'command.enqueued', data: envelope.fact as unknown as JsonValue })
      if (envelope.fact.type === 'reply') {
        const effect = this.state.effects.get(envelope.fact.effectId)
        if (effect?.agentId === envelope.fact.agentId && effect.kind === 'human' && !effect.outcome) commandApplied = this.completeEffect(envelope.fact.effectId, { value: envelope.fact.value }, 'succeeded', undefined, [{ op: 'appendEvent', event: { type: 'command.applied', data: { eventId: envelope.eventId } } }])
        else { this.rejectHostCommand(envelope.eventId, effect?.agentId !== envelope.fact.agentId ? 'EFFECT_NOT_OWNED' : 'EFFECT_NOT_REPLYABLE'); commandApplied = true }
      } else if (envelope.fact.type === 'cancel') commandApplied = this.cancelAgent(envelope.fact.agentId, envelope.fact.reason, [{ op: 'appendEvent', event: { type: 'command.applied', data: { eventId: envelope.eventId } } }], `host-command:${envelope.eventId}`)
      else if (envelope.fact.type === 'cancel_effect') {
        const effect = this.state.effects.get(envelope.fact.effectId)
        if (!effect || effect.agentId !== envelope.fact.agentId) { this.rejectHostCommand(envelope.eventId, 'EFFECT_NOT_OWNED'); commandApplied = true }
        else if (effect.outcome) { this.rejectHostCommand(envelope.eventId, 'EFFECT_ALREADY_SETTLED'); commandApplied = true }
        else commandApplied = this.cancelEffect(envelope.fact.effectId, 0, envelope.fact.reason, [{ op: 'appendEvent', event: { type: 'command.applied', data: { eventId: envelope.eventId } } }])
      } else {
        const lane = this.state.lanes.get(envelope.fact.laneId)
        if (!lane) { this.rejectHostCommand(envelope.eventId, 'LANE_NOT_FOUND'); commandApplied = true }
        else if (['succeeded', 'failed', 'cancelled'].includes(lane.status)) { this.rejectHostCommand(envelope.eventId, 'LANE_TERMINAL'); commandApplied = true }
        else {
          const nextLane = structuredClone(lane)
          nextLane.priority = envelope.fact.priority
          nextLane.version++
          const event = { type: 'lane.priority_changed' as const, laneId: lane.id, data: { previous: lane.priority, priority: nextLane.priority } }
          const appliedEvent = { type: 'command.applied' as const, data: { eventId: envelope.eventId } }
          const mutations: Mutation[] = [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }, { op: 'appendEvent', event: appliedEvent }]
          this.assertStorageAdmission(mutations)
          commitMutationTransaction(this.state, this.mutationLog, `host-command:${envelope.eventId}`, mutations, this.state.now, this.sessionId)
          Object.assign(lane, nextLane)
          this.state.lanes.set(lane.id, lane)
          if (lane.status === 'ready') this.ready.enqueue(readyItemFromLane(lane))
          commandApplied = true
        }
      }
      if (!commandApplied) this.emit({ type: 'command.applied', data: { eventId: envelope.eventId } })
      } catch (cause) {
        this.factInbox.restore(before)
        throw cause
      }
    }
    if (this.maxRuntimeMs !== undefined && this.state.now >= this.maxRuntimeMs) for (const agent of this.state.agents.values()) if (agent.state === 'running') this.cancelAgent(agent.id, 'TIMEOUT')
    for (const timer of this.clock.timers.due(this.state.now)) timer.callback()
    let progressed = 0
    while (progressed < this.maxSteps) {
      const laneId = this.ready.dequeue(this.state.now)
      if (!laneId) break
      const lane = this.state.lanes.get(laneId)
      if (!lane || lane.status !== 'ready') continue
      const currentPressure = historyPressure(lane.context.history, this.state.historySoftTokens, this.state.historyHardTokens)
      const stepLane = structuredClone(lane)
      if (currentPressure) stepLane.historyPressure = currentPressure
      else delete stepLane.historyPressure
      const program = this.programs.get(`${lane.resume.programId}@${lane.resume.programVersion}`)
      if (!program) { this.failLane(lane, { code: 'PROGRAM_NOT_REGISTERED', message: `${lane.resume.programId}@${lane.resume.programVersion}` }); continue }
      let output: LaneStepOutput
      const stepContext: LaneStepContext = { lane: stepLane, state: structuredClone(this.state), ...(lane.pendingResumeInput ? { resumeInput: structuredClone(lane.pendingResumeInput) } : {}), now: this.state.now, observe: (event) => { this.observationInbox.enqueue({ ...event, agentId: lane.agentId, laneId: lane.id, timestamp: this.state.now }) } }
      try { output = lane.series || program.seriesMember ? this.seriesStep(program, stepContext, lane.series) : program.step(stepContext) }
      catch (cause) {
        const failure: RuntimeError = { code: 'STEP_FAILED', message: cause instanceof Error ? cause.message : String(cause) }
        if (!program.errorBoundary) { this.failLane(lane, failure); continue }
        try { output = program.errorBoundary(failure, stepContext) }
        catch (boundaryCause) { this.failLane(lane, { code: 'ERROR_BOUNDARY_FAILED', message: boundaryCause instanceof Error ? boundaryCause.message : String(boundaryCause) }); continue }
      }
      if (output && typeof output === 'object' && typeof (output as unknown as { then?: unknown }).then === 'function') {
        this.failLane(lane, { code: 'ASYNC_STEP_FORBIDDEN', message: 'LaneProgram.step() must return synchronously; external work belongs in an Effect.' })
        continue
      }
      const preparedOutput = this.prepareStepOutput(output)
      const result = validateStep(this.state, lane.id, preparedOutput)
      if ('rejection' in result) {
        const consecutive = (lane.consecutiveControlErrors ?? 0) + 1
        const controlInput: ResumeInput = { type: 'control_error', error: result.rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
        if (result.rejection.code === 'FORK_AFFINITY_COLLAPSIBLE') {
          this.commitLaneControlInput(lane, controlInput, { type: 'fork.affinity_advice', laneId: lane.id, data: result.rejection as unknown as JsonValue })
        } else {
          if (consecutive >= this.maxConsecutiveControlErrors) this.failLane(lane, { code: 'CONTROL_ERROR_LOOP', message: 'Lane exceeded the consecutive control error limit.', details: { lastError: result.rejection as unknown as JsonValue } })
          else this.commitLaneControlInput(lane, controlInput, { type: 'step.rejected', laneId: lane.id, data: result.rejection as unknown as JsonValue }, { consecutiveControlErrors: consecutive })
        }
      } else {
        let watchdogObservation: ProgressObservation | undefined
        if (preparedOutput.actions.some((action) => action.type === 'submit_effects')) {
          const observation = observeProgress(lane, preparedOutput, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold, repeatedActionThreshold: this.watchdogRepeatedActionThreshold, admission: true })
          if (observation.rejected) {
            if (observation.state.interventionLevel >= 3) this.failLane(lane, observation.rejected, { progressWatchdog: observation.state })
            else this.commitLaneControlInput(lane, { type: 'control_error', error: observation.rejected, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }, { type: 'progress.intervention_applied', laneId: lane.id, data: observation.rejected as unknown as JsonValue }, { progressWatchdog: observation.state })
            progressed++
            continue
          }
          watchdogObservation = observation
        }
        const watchdog = watchdogObservation ?? observeProgress(lane, preparedOutput, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold, repeatedActionThreshold: this.watchdogRepeatedActionThreshold })
        const stepMutations = result.mutations.map((mutation) => {
          if (mutation.op !== 'setLane' || mutation.laneId !== lane.id) return mutation
          const nextLane = structuredClone(mutation.record)
          delete nextLane.consecutiveControlErrors
          delete nextLane.pendingResumeInput
          nextLane.progressWatchdog = watchdog.state
          return { ...mutation, record: nextLane }
        })
        if (!watchdog.progressed) stepMutations.push({ op: 'appendEvent', event: { type: watchdog.state.interventionLevel >= 3 ? 'progress.no_progress_detected' : 'progress.intervention_applied', laneId: lane.id, data: { noProgressCount: watchdog.state.noProgressCount, interventionLevel: watchdog.state.interventionLevel } } })
        try { this.assertStorageAdmission(stepMutations) }
        catch (cause) {
          const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }
          this.failLane(lane, storageError)
          progressed++
          continue
        }
        commitMutationTransaction(this.state, this.mutationLog, `step:${lane.id}:${lane.version + 1}`, stepMutations, this.state.now, this.sessionId)
        for (const mutation of stepMutations) if (mutation.op === 'insertEffect') this.outbox.enqueue(mutation.record, this.state.now)
        for (const mutation of stepMutations) if (mutation.op === 'insertWait') this.scheduleWaitDeadline(mutation.record)
        const updated = this.state.lanes.get(lane.id)
        if (updated) {
          if (watchdog.state.interventionLevel >= 3 && !['succeeded', 'failed', 'cancelled'].includes(updated.status)) this.failLane(updated, { code: 'NO_PROGRESS_DETECTED', message: 'Lane made no observable progress within the watchdog threshold.' })
        }
        if (updated?.status === 'ready') this.enqueueLane(updated.id)
        this.enqueueNewReadyLanes()
        this.refreshWaits()
        this.propagateCancelledLanes()
        this.syncStoragePolicy()
      }
      this.dispatchQueuedEffects()
      progressed++
    }
    this.completeFinishedChildAgents()
    this.syncStoragePolicy()
    this.schedulePersistence()
    return progressed
  }

  async run(): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }>
  async run(maxTicks: number): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }>
  async run(agentId: string, maxTicks?: number): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }>
  async run(agentOrMaxTicks: string | number = 10_000, requestedMaxTicks = 10_000): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> {
    if (typeof agentOrMaxTicks === 'string') return this.runAgent(agentOrMaxTicks, requestedMaxTicks)
    for (let tick = 0; tick < agentOrMaxTicks; tick++) {
      const work = this.tick()
      await this.flushPersistence()
      this.refreshWaits()
      if (this.ready.size === 0 && this.executions.size === 0) {
        if (this.preparingLLMs.size) { await Promise.resolve(); continue }
        if (this.factInbox.size > 0) continue
        if (this.hasPendingHostInteraction()) { await this.waitForFact(); continue }
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined && nextAt > this.clock.now()) { this.clock.set(nextAt); continue }
        break
      }
      if (work === 0 && this.executions.size) {
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined && nextAt > this.clock.now()) { this.clock.set(nextAt); continue }
        await Promise.race([...this.executions.values()].map((execution) => execution.promise))
      }
      else if (work === 0 && this.factInbox.size === 0 && this.hasPendingHostInteraction()) await this.waitForFact()
      else if (work === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const root = [...this.state.lanes.values()].find((lane) => lane.ownerLaneId === undefined)
    const status = root?.status === 'succeeded' ? 'succeeded' : root?.status === 'cancelled' ? 'cancelled' : 'failed'
    if (root && !['succeeded', 'failed', 'cancelled'].includes(root.status)) this.emit({ type: 'runtime.idle_blocked', laneId: root.id, data: { status: root.status } })
    const agent = root ? this.state.agents.get(root.agentId) : undefined
    if (agent && ['succeeded', 'failed', 'cancelled'].includes(root?.status ?? 'failed')) this.commitAgentState(agent.id, status, `agent:${agent.id}:run-settled:${root?.version ?? this.state.now}`)
    await this.flushPersistence()
    return { status, unresolvedEffectIds: this.quarantine.unresolvedEffectIds }
  }

  async runAgent(agentId: string, maxTicks = 10_000): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    for (let tick = 0; tick < maxTicks; tick++) {
      const work = this.tick()
      await this.flushPersistence()
      this.refreshWaits()
      const root = this.state.lanes.get(agent.rootLaneId)
      if (root && ['succeeded', 'failed', 'cancelled'].includes(root.status)) {
        const status: 'succeeded' | 'failed' | 'cancelled' = root.status === 'succeeded' ? 'succeeded' : root.status === 'cancelled' ? 'cancelled' : 'failed'
        this.commitAgentState(agent.id, status, `agent:${agent.id}:run-agent-settled:${root.version}`)
        const effectIds = new Set([...this.state.effects.values()].filter((effect) => effect.agentId === agentId).map((effect) => effect.id))
        await this.flushPersistence()
        return { status, unresolvedEffectIds: this.quarantine.unresolvedEffectIds.filter((effectId) => effectIds.has(effectId)) }
      }
      if (this.ready.size === 0 && this.executions.size === 0) {
        if (this.preparingLLMs.size) { await Promise.resolve(); continue }
        if (this.factInbox.size > 0) continue
        if (this.hasPendingHostInteraction(agentId)) { await this.waitForFact(); continue }
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined && nextAt > this.clock.now()) { this.clock.set(nextAt); continue }
        break
      }
      if (work === 0 && this.executions.size) {
        const nextAt = this.clock.timers.nextAt()
        if (nextAt !== undefined && nextAt > this.clock.now()) { this.clock.set(nextAt); continue }
        const executions = [...this.executions.entries()].filter(([effectId]) => this.state.effects.get(effectId)?.agentId === agentId).map(([, execution]) => execution.promise)
        if (executions.length) await Promise.race(executions)
        else await Promise.resolve()
      } else if (work === 0 && this.factInbox.size === 0 && this.hasPendingHostInteraction(agentId)) await this.waitForFact()
      else if (work === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const root = this.state.lanes.get(agent.rootLaneId)
    if (root && !['succeeded', 'failed', 'cancelled'].includes(root.status)) this.emit({ type: 'runtime.idle_blocked', laneId: root.id, data: { status: root.status } })
    const effectIds = new Set([...this.state.effects.values()].filter((effect) => effect.agentId === agentId).map((effect) => effect.id))
    return { status: root?.status === 'succeeded' ? 'succeeded' : root?.status === 'cancelled' ? 'cancelled' : 'failed', unresolvedEffectIds: this.quarantine.unresolvedEffectIds.filter((effectId) => effectIds.has(effectId)) }
  }

  async waitForIdle(): Promise<void> { while (this.ready.size || this.executions.size || this.preparingLLMs.size) { this.tick(); if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise)); else if (this.preparingLLMs.size) await Promise.resolve() } }

  async shutdown(timeoutMs = 5_000): Promise<{ status: 'stopped' | 'timed_out'; unresolvedEffectIds: string[]; quarantine: string[] }> {
    this.shuttingDown = true
    for (const agent of this.state.agents.values()) if (agent.state === 'running' || agent.state === 'cancelling') this.cancelAgent(agent.id, 'USER_REQUESTED')
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while ((this.ready.size || this.executions.size) && Date.now() < deadline) {
      this.tick()
      if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise).concat([new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now()))))]))
    }
    await this.flushPersistence()
    const unresolved = [...this.state.effects.values()].filter((effect) => !effect.outcome && effect.state !== 'cancelled').map((effect) => effect.id)
    return { status: unresolved.length || this.executions.size ? 'timed_out' : 'stopped', unresolvedEffectIds: [...new Set([...unresolved, ...this.quarantine.unresolvedEffectIds])], quarantine: this.quarantine.unresolvedEffectIds }
  }

  inspect(): JsonValue { const explanation = this.explain() as Record<string, JsonValue>; return { ...explanation, quarantineEntries: this.quarantine.snapshot() as unknown as JsonValue, observationsPending: this.observationInbox.size } }

  telemetry(): RuntimeTelemetrySnapshot { return collectRuntimeTelemetry(this.state) }
  async exportTelemetry(timestamp = Date.now()): Promise<RuntimeTelemetrySnapshot> {
    const snapshot = this.telemetry()
    if (this.telemetryExporter) await this.telemetryExporter.publish({ schemaVersion: 1, timestamp, snapshot })
    return snapshot
  }

  private assertStorageAdmission(mutations: Mutation[]): void {
    const candidate = structuredClone(this.state)
    apply(candidate, mutations, { sessionId: this.sessionId, timestamp: candidate.now })
    const policy = this.storagePolicy.clone()
    this.syncStoragePolicy(policy, candidate)
  }

  private schedulePersistence(): void {
    if (!this.persistenceBackend) return
    this.persistenceDirty = true
    if (this.persistenceScheduled) return
    this.persistenceScheduled = true
    this.persistencePending = this.persistencePending.catch(() => undefined).then(async () => {
      while (this.persistenceDirty) {
        this.persistenceDirty = false
        await this.persist(this.persistenceBackend!)
      }
    }).finally(() => {
      this.persistenceScheduled = false
      if (this.persistenceDirty) this.schedulePersistence()
    })
  }

  private persistenceState(): RuntimeState {
    const state = structuredClone(this.state)
    for (const artifact of state.artifacts.values()) artifact.storageState = 'persisted'
    return state
  }

  private markArtifactsPersisted(): void {
    for (const artifact of this.state.artifacts.values()) artifact.storageState = 'persisted'
  }

  private syncStoragePolicy(policy = this.storagePolicy, state = this.state, factInbox = this.factInbox): void {
    const transactional = policy === this.storagePolicy
    const target = transactional ? policy.clone() : policy
    const residency = new Map<string, { storageState: 'memory' | 'persisted'; pinCount: number }>()
    const pinKeys = new Set<string>()
    for (const lane of state.lanes.values()) {
      const active = !['succeeded', 'failed', 'cancelled'].includes(lane.status)
      if (active) pinKeys.add(`snapshot:lane:${lane.id}:${lane.context.version}`)
      if (active) for (const ref of lane.visibleResultRefs ?? []) pinKeys.add(`result:${ref}`)
      for (const record of lane.context.history) for (const ref of record.resultRefs) pinKeys.add(`result:${ref}`)
      if (lane.activeWaitId) pinKeys.add(`snapshot:wait:${lane.activeWaitId}`)
      if (lane.pendingResumeInput) pinKeys.add(`snapshot:resume:${lane.id}:${lane.version}`)
    }
    for (const agent of state.agents.values()) for (const [version] of agent.globalVersions) if ([...state.lanes.values()].some((lane) => lane.agentId === agent.id && !['succeeded', 'failed', 'cancelled'].includes(lane.status) && lane.contextSnapshotVersion === version)) pinKeys.add(`snapshot:global:${agent.id}:${version}`)
    for (const wait of state.waits.values()) if (wait.state === 'pending') pinKeys.add(`snapshot:wait:${wait.id}`)
    for (const artifact of state.artifacts.values()) {
      if (artifact.pinCount > 0) pinKeys.add(`artifact:${artifact.ref}`)
    }
    for (const effect of state.effects.values()) {
      if (!effect.outcome && effect.kind === 'llm') pinKeys.add(`snapshot:request:${effect.id}:${effect.attemptId}`)
      if (!effect.outcome) for (const ref of effect.derivedFrom ?? []) pinKeys.add(`${provenanceRefKind(ref) === 'artifact' ? 'artifact' : 'result'}:${provenanceRefId(ref)}`)
    }
    for (const envelope of factInbox.snapshot().queue) pinKeys.add(`snapshot:fact:${envelope.eventId}`)
    target.replacePinSource('runtime', pinKeys)
    for (const lane of state.lanes.values()) {
      const snapshotKey = `snapshot:lane:${lane.id}:${lane.context.version}`
      target.put('snapshot', snapshotKey, { laneId: lane.id, version: lane.context.version, context: lane.context, resume: lane.resume } as unknown as JsonValue)
    }
    for (const agent of state.agents.values()) {
      for (const [version, value] of agent.globalVersions) {
        const key = `snapshot:global:${agent.id}:${version}`
        target.put('snapshot', key, { agentId: agent.id, version, value } as unknown as JsonValue)
      }
    }
    for (const wait of state.waits.values()) {
      const key = `snapshot:wait:${wait.id}`
      target.put('snapshot', key, wait as unknown as JsonValue)
    }
    for (const effect of state.effects.values()) {
      if (!effect.outcome && effect.kind === 'llm') {
        const key = `snapshot:request:${effect.id}:${effect.attemptId}`
        target.put('snapshot', key, { effectId: effect.id, attemptId: effect.attemptId, input: effect.input } as unknown as JsonValue)
      }
    }
    for (const result of state.results.values()) {
      const policyValue = structuredClone(result) as import('../core/types.js').ResultRecord
      delete policyValue.storageState
      delete policyValue.pinCount
      const stored = target.put('result', `result:${result.id}`, policyValue as unknown as JsonValue)
      residency.set(result.id, { storageState: stored.storageState === 'memory' ? 'memory' : 'persisted', pinCount: stored.pinCount })
    }
    for (const artifact of state.artifacts.values()) target.put('artifact', `artifact:${artifact.ref}`, artifact as unknown as JsonValue)
    for (const event of state.events) target.put('event', `event:${event.id}`, event as unknown as JsonValue)
    for (const lane of state.lanes.values()) if (lane.pendingResumeInput) target.put('snapshot', `snapshot:resume:${lane.id}:${lane.version}`, lane.pendingResumeInput as unknown as JsonValue)
    const factKeys = new Set(factInbox.snapshot().queue.map((envelope) => `snapshot:fact:${envelope.eventId}`))
    for (const envelope of factInbox.snapshot().queue) target.put('snapshot', `snapshot:fact:${envelope.eventId}`, envelope as unknown as JsonValue)
    for (const record of target.inspect()) if (record.key.startsWith('snapshot:fact:') && !factKeys.has(record.key)) target.remove(record.key)
    if (transactional) {
      policy.replaceSnapshot(target.snapshot())
      for (const [id, value] of residency) {
        const result = state.results.get(id)
        if (result) Object.assign(result, value)
      }
    } else {
      for (const [id, value] of residency) {
        const result = state.results.get(id)
        if (result) Object.assign(result, value)
      }
    }
  }

  private hasPendingHostInteraction(agentId?: string): boolean { return [...this.state.effects.values()].some((effect) => effect.kind === 'human' && !effect.outcome && (agentId === undefined || effect.agentId === agentId)) }
  private waitForFact(): Promise<void> { return new Promise((resolve) => this.factWaiters.push(resolve)) }
  private completeFinishedChildAgents(): void {
    for (const effect of this.state.effects.values()) {
      if (effect.kind !== 'agent' || !effect.childAgentId || effect.outcome) continue
      const child = this.state.agents.get(effect.childAgentId)
      const root = child ? this.state.lanes.get(child.rootLaneId) : undefined
      if (!child || !root || !['succeeded', 'failed', 'cancelled'].includes(root.status)) continue
      const status = root.status === 'succeeded' ? 'succeeded' : root.status === 'cancelled' ? 'cancelled' : 'failed'
      const nextChild = structuredClone(child)
      nextChild.state = status
      this.completeEffect(effect.id, { value: { agentId: child.id, status } }, status, status === 'failed' ? { code: 'CHILD_AGENT_FAILED', message: 'Child Agent failed.' } : undefined, [{ op: 'setAgent', agentId: child.id, record: nextChild }])
    }
  }

  completeEffect(effectId: string, execution: EffectExecution, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', error?: RuntimeError, additionalMutations: Mutation[] = []): boolean {
    const storedEffect = this.state.effects.get(effectId)
    if (!storedEffect) return false
    if (storedEffect.outcome) { this.tryEmit({ type: 'attempt.late_emit', effectId, data: { status: storedEffect.outcome.status } }); return false }
    const effect = structuredClone(storedEffect)
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    if (execution.executionState === 'remote_unknown') { this.markRemoteUnknown(effectId, execution.sideEffectState ?? 'none'); return false }
    let effectiveExecution = execution
    let outputError = error ?? execution.error
    let resultDerivedFrom = [...(effect.derivedFrom ?? [])]
    let publishedArtifact: ArtifactRecord | undefined
    const rawInput = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    if (execution.artifact !== undefined) {
      try {
        const artifact = prepareArtifactPublication(this.state, { ...execution.artifact, laneId: effect.ownerLaneId, derivedFrom: [...(effect.derivedFrom ?? []), ...(execution.artifact.derivedFrom ?? [])] })
        publishedArtifact = artifact
        resultDerivedFrom = [...resultDerivedFrom, { kind: 'artifact', ref: artifact.ref }]
        effectiveExecution = { ...effectiveExecution, value: { artifactRef: artifact.ref }, privacy: artifact.privacy, ...(artifact.privacyTaints === undefined ? {} : { privacyTaints: artifact.privacyTaints }) }
      } catch (cause) {
        effectiveExecution = { ...effectiveExecution, status: 'failed', executionState: 'failed', error: runtimeErrorFromCause(cause, 'ARTIFACT_PUBLICATION_FAILED') }
        outputError = effectiveExecution.error
      }
    }
    const outputSchema = rawInput.outputSchema
    if ((execution.status ?? status) === 'succeeded' && effect.kind === 'llm' && outputSchema !== undefined && !validateJsonSchema(execution.value, outputSchema)) {
      effectiveExecution = { ...execution, status: 'failed', executionState: 'failed', rejectedOutput: { value: structuredClone(execution.value), ...(execution.privacy === undefined ? {} : { privacy: execution.privacy }), derivedFrom: [...(effect.derivedFrom ?? [])] } }
      outputError = { code: 'OUTPUT_SCHEMA_VIOLATION', message: 'LLM output did not satisfy the declared output schema.' }
    }
    const taintError = validatePrivacyTaints(effectiveExecution.privacyTaints) ?? validatePrivacyTaints(effectiveExecution.rejectedOutput?.privacyTaints)
    if (taintError) {
      effectiveExecution = { ...effectiveExecution, status: 'failed', executionState: 'failed', error: { code: taintError, message: 'Effect output contains invalid privacy taints.' } }
      outputError = effectiveExecution.error
    }
    const effectiveStatus = effect.cancelRequested && (effectiveExecution.status ?? status) === 'succeeded' ? 'cancelled' : (effectiveExecution.status ?? status)
    effect.state = effectiveStatus
    effect.executionState = effectiveStatus === 'succeeded' ? 'succeeded' : effectiveStatus === 'cancelled' ? 'failed' : 'failed'
    effect.sideEffectState = effectiveExecution.sideEffectState ?? 'none'
    if (effectiveExecution.executionRef !== undefined) effect.executionRef = structuredClone(effectiveExecution.executionRef)
    const attempt = effect.attempts?.at(-1)
    if (attempt) { attempt.executionState = effect.executionState; attempt.sideEffectState = effect.sideEffectState; if (effectiveExecution.executionRef !== undefined) attempt.sideEffectRef = structuredClone(effectiveExecution.executionRef); attempt.settledAt = this.state.now; if (outputError) attempt.error = outputError }
    const settledAttemptId = effect.attemptId
    if (effectiveStatus === 'failed' && this.scheduleRetry(effect, outputError)) {
      Object.assign(storedEffect, effect)
      this.releaseEffectLocks(effectId)
      this.outbox.ack(`${effect.id}:${settledAttemptId}`)
      this.refreshWaits()
      this.schedulePersistence()
      return false
    }
    let resultSequence = this.state.nextIds.result
    while (this.state.results.has(`result-${resultSequence}`)) resultSequence++
    const resultId = `result-${resultSequence}`
    const rejectedOutputId = effectiveStatus !== 'succeeded' && effectiveExecution.rejectedOutput ? resultId : undefined
    const outcome: Outcome = effectiveStatus === 'succeeded' ? { status: effectiveStatus, resultRef: resultId } : { status: effectiveStatus, ...(outputError ? { error: outputError } : {}), ...(rejectedOutputId ? { rejectedOutputRefs: [rejectedOutputId] } : {}) }
    effect.outcome = outcome
    const ownerLane = this.state.lanes.get(effect.ownerLaneId)
    const sourcePrivacy = effect.derivedFrom?.flatMap((ref) => {
      const result = provenanceRefKind(ref) === 'artifact' ? undefined : this.state.results.get(provenanceRefId(ref))
      if (result) return [effectivePrivacy(result.privacy, result.privacyTaints)]
      const source = ownerLane ? privacyMetadataForDerivedRef(this.state, ownerLane, ref) : undefined
      return source ? [effectivePrivacy(source.privacy, source.privacyTaints)] : []
    }) ?? []
    const sourceTaints = ownerLane ? privacyTaintsForDerivedRefs(this.state, ownerLane, effect.derivedFrom ?? []) : []
    const outputTaints = [...sourceTaints, ...(effectiveExecution.privacyTaints ?? [])]
    const rejectedTaints = [...sourceTaints, ...(effectiveExecution.rejectedOutput?.privacyTaints ?? [])]
    const summaryAllowed = effectiveExecution.summary === undefined || Buffer.byteLength(JSON.stringify(effectiveExecution.summary), 'utf8') <= this.state.maxResultSummaryBytes
    const result = effectiveStatus === 'succeeded' && !taintError ? { id: resultId, effectId, value: effectiveExecution.value, storageState: 'memory' as const, pinCount: 0, privacy: effectivePrivacy(strictestPrivacy([effectiveExecution.privacy ?? 'public', ...sourcePrivacy]), outputTaints), ...(outputTaints.length ? { privacyTaints: outputTaints } : {}), derivedFrom: resultDerivedFrom, ...(effectiveExecution.normalized === undefined ? {} : { normalized: effectiveExecution.normalized }), ...(summaryAllowed && effectiveExecution.summary !== undefined ? { summary: effectiveExecution.summary } : {}) } : rejectedOutputId && effectiveExecution.rejectedOutput && !taintError ? { id: rejectedOutputId, effectId, kind: 'rejected_output' as const, value: effectiveExecution.rejectedOutput.value, storageState: 'memory' as const, pinCount: 0, privacy: effectivePrivacy(strictestPrivacy([effectiveExecution.rejectedOutput.privacy ?? effectiveExecution.privacy ?? 'public', ...sourcePrivacy]), rejectedTaints), ...(rejectedTaints.length ? { privacyTaints: rejectedTaints } : {}), derivedFrom: [...(effectiveExecution.rejectedOutput.derivedFrom ?? effect.derivedFrom ?? [])] } : undefined
    let journalLane: LaneRecord | undefined
    if (ownerLane && result) {
      journalLane = structuredClone(ownerLane)
      if (journalLane.visibleResultRefs) journalLane.visibleResultRefs.add(result.id)
      else journalLane.visibleResultRefs = new Set([result.id])
      if (effect.kind === 'llm' && effectiveStatus === 'succeeded') {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        const request = input.request && typeof input.request === 'object' && !Array.isArray(input.request) ? input.request as Record<string, JsonValue> : undefined
        const contextSpec = request?.contextSpec && typeof request.contextSpec === 'object' && !Array.isArray(request.contextSpec) ? request.contextSpec as Record<string, JsonValue> : undefined
        const refs = Array.isArray(contextSpec?.resultRefs) ? contextSpec.resultRefs.filter((ref): ref is string => typeof ref === 'string') : (effect.derivedFrom ?? []).filter((ref): ref is string => typeof ref === 'string')
        const instruction = typeof contextSpec?.instruction === 'string' ? contextSpec.instruction : typeof input.instruction === 'string' ? input.instruction : typeof input.task === 'string' ? input.task : effect.key
        const selectedRefs = [...new Set(refs)]
        const resultSelection = selectedRefs.map((ref) => ({ ref, rule: 'explicit-context-result', hash: contentHash(this.state.results.get(ref)?.value ?? null) }))
        const findings = selectedRefs.filter((ref) => this.state.results.get(ref)?.kind === 'finding')
        journalLane = appendHistory(journalLane, { effectId: effect.id, instruction, resultRefs: selectedRefs, resultSelection, result: result.id, ...(findings.length ? { findings } : {}), output: structuredClone(effectiveExecution.value), privacy: result.privacy, ...(result.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(result.privacyTaints) }) })
        journalLane.visibleResultRefs!.add(result.id)
      }
    }
    let correlation: ToolCallCorrelation | undefined
    if (effect.kind === 'tool' && effect.toolCallId && result) {
      const existing = this.state.toolCallCorrelations.get(effect.toolCallId)
      if (existing) {
        correlation = { ...existing, toolEffectId: effect.id, resultRef: result.id }
      }
    }
    const publicationMutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: structuredClone(effect) }, ...additionalMutations.map((mutation) => structuredClone(mutation))]
    if (publishedArtifact) publicationMutations.push({ op: 'publishArtifact', record: structuredClone(publishedArtifact) })
    if (result) publicationMutations.push({ op: 'publishResult', record: structuredClone(result) })
    if (journalLane) publicationMutations.push({ op: 'setLane', laneId: journalLane.id, record: structuredClone(journalLane) })
    if (correlation) publicationMutations.push({ op: 'setToolCallCorrelation', record: structuredClone(correlation) })
    if (effectiveExecution.summary !== undefined && !summaryAllowed) publicationMutations.push({ op: 'appendEvent', event: { type: 'result.summary_rejected', effectId, data: { maxBytes: this.state.maxResultSummaryBytes, actualBytes: Buffer.byteLength(JSON.stringify(effectiveExecution.summary), 'utf8') } } })
    publicationMutations.push({ op: 'appendEvent', event: { type: 'effect.settled', effectId, data: outcome as unknown as JsonValue } })
    if (execution.metadata !== undefined) publicationMutations.push({ op: 'appendEvent', event: { type: 'effect.execution_metadata', effectId, data: execution.metadata } })
    try {
      this.assertStorageAdmission(publicationMutations)
    } catch (cause) {
      const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }
      effect.state = 'failed'
      effect.executionState = 'failed'
      effect.outcome = { status: 'failed', error: storageError }
      const failedAttempt = effect.attempts?.at(-1)
      if (failedAttempt) failedAttempt.error = storageError
      const failureEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.settled', effectId, data: effect.outcome as unknown as JsonValue }
      const commandAckMutations = additionalMutations.filter((mutation) => mutation.op === 'appendEvent' && mutation.event.type === 'command.applied').map((mutation) => structuredClone(mutation))
      const failureMutations: Mutation[] = [{ op: 'setEffect', effectId, record: structuredClone(effect) }, ...commandAckMutations]
      try {
        this.assertStorageAdmission([...failureMutations, { op: 'appendEvent', event: failureEvent }])
        failureMutations.push({ op: 'appendEvent', event: failureEvent })
      } catch {
        this.assertStorageAdmission(failureMutations)
      }
      commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${settledAttemptId}:storage-rejected`, failureMutations, this.state.now, this.sessionId)
      Object.assign(storedEffect, effect)
      this.state.effects.set(effectId, storedEffect)
      this.releaseEffectLocks(effectId)
      this.outbox.ack(`${effect.id}:${effect.attemptId}`)
      this.syncStoragePolicy()
      this.refreshWaits()
      this.schedulePersistence()
      return commandAckMutations.length > 0
    }
    this.releaseEffectLocks(effectId)
    this.outbox.ack(`${effect.id}:${effect.attemptId}`)
    for (const observation of effectiveExecution.observations ?? []) this.observationInbox.enqueue({ ...observation, agentId: effect.agentId, laneId: effect.ownerLaneId, timestamp: this.state.now })
    const settlementTransactionId = `effect:${effect.id}:${settledAttemptId}:settled`
    const settlementMutations = [...publicationMutations]
    commitMutationTransaction(this.state, this.mutationLog, settlementTransactionId, settlementMutations, this.state.now, this.sessionId)
    Object.assign(storedEffect, effect)
    this.state.effects.set(effectId, storedEffect)
    if (journalLane) { const liveLane = this.state.lanes.get(journalLane.id); if (liveLane) { Object.assign(liveLane, journalLane); this.state.lanes.set(journalLane.id, liveLane) } }
    this.recordBudgetMetadata(execution.metadata)
    this.syncStoragePolicy()
    this.refreshWaits()
    this.dispatchQueuedEffects()
    this.schedulePersistence()
    return true
  }

  markRemoteUnknown(effectId: string, sideEffectState: 'none' | 'applied' | 'known' | 'unknown'): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    const candidate = structuredClone(effect)
    candidate.executionState = 'remote_unknown'
    candidate.sideEffectState = sideEffectState
    const attempt = candidate.attempts?.at(-1)
    if (attempt) { attempt.executionState = 'remote_unknown'; attempt.sideEffectState = sideEffectState; attempt.settledAt = this.state.now }
    const lane = this.state.lanes.get(effect.ownerLaneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    if (sideEffectState === 'unknown') {
      candidate.state = 'reconcile_required'
      if (candidateLane) candidateLane.unresolvedEffectIds = [...new Set([...(candidateLane.unresolvedEffectIds ?? []), effectId])]
    } else {
      const unknownAttempts = candidate.attempts?.filter((item) => item.executionState === 'remote_unknown').length ?? 0
      const canRetry = candidate.duplicateExecutionPolicy === 'allow' && candidate.maxUnknownAttempts !== undefined && unknownAttempts <= candidate.maxUnknownAttempts
      if (canRetry) {
        const settledAttemptId = candidate.attemptId
        const running = this.executions.get(effectId)
        if (running) { running.controller.abort(); this.executions.delete(effectId) }
        if (this.scheduleRetry(candidate, { code: 'REMOTE_EXECUTION_UNKNOWN', message: 'Remote execution outcome is unknown.', details: { unknownAttempts } })) {
          const retried = this.state.effects.get(effectId)
          if (retried) { Object.assign(effect, retried); this.state.effects.set(effectId, effect) }
          this.releaseEffectLocks(effectId)
          this.outbox.ack(`${effect.id}:${settledAttemptId}`)
          this.refreshWaits()
          this.schedulePersistence()
          return
        }
      }
      candidate.state = 'failed'
      candidate.outcome = { status: 'failed', error: { code: 'REMOTE_UNKNOWN', message: 'Remote execution outcome is unknown but no side effect was recorded.' } }
    }
    const remoteEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.remote_unknown', effectId, data: { executionState: 'remote_unknown', sideEffectState } }
    const admission: Mutation[] = [{ op: 'setEffect', effectId, record: candidate }]
    if (candidateLane) admission.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    admission.push({ op: 'appendEvent', event: remoteEvent })
    this.assertStorageAdmission(admission)
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:remote-unknown`, admission, this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effectId, effect)
    if (candidateLane && lane) { Object.assign(lane, candidateLane); this.state.lanes.set(candidateLane.id, lane) }
    if (sideEffectState === 'unknown') this.quarantine.add(effect.id, this.state.now, 'in_doubt')
    else {
      this.releaseEffectLocks(effectId)
    }
    this.refreshWaits()
    this.schedulePersistence()
  }

  reconcileEffect(effectId: string, value: JsonValue, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return
    this.quarantine.reconcile(effectId)
    this.completeEffect(effectId, { value, sideEffectState: 'known' }, status)
  }

  async reconcileEffectWith(effectId: string, resolver: (executionRef: JsonValue | undefined, effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<{ status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: JsonValue; error?: RuntimeError }>, signal = new AbortController().signal): Promise<{ status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: JsonValue; error?: RuntimeError }> {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return { status: 'unknown', error: { code: 'RECONCILE_NOT_REQUIRED', message: 'Effect is not waiting for reconciliation.' } }
    const result = await resolver(effect.executionRef, effect, signal)
    if (result.status === 'succeeded' || result.status === 'failed' || result.status === 'cancelled') this.reconcileEffect(effectId, result.output ?? null, result.status)
    return result
  }

  abandonEffect(effectId: string): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return
    if (!this.quarantine.has(effectId)) return
    const candidate = structuredClone(effect)
    candidate.state = 'failed'
    candidate.executionState = 'local_closed'
    candidate.sideEffectState = 'unknown'
    candidate.outcome = { status: 'failed', error: { code: 'RESOURCE_ABANDONED', message: 'Host abandoned reconciliation for an unknown side effect.' } }
    const lane = this.state.lanes.get(effect.ownerLaneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    if (candidateLane?.unresolvedEffectIds) candidateLane.unresolvedEffectIds = candidateLane.unresolvedEffectIds.filter((id) => id !== effectId)
    const abandonedEvent: import('../core/types.js').RuntimeEventInput = { type: 'resource.abandoned', effectId, data: { code: 'RESOURCE_ABANDONED' } }
    const admission: Mutation[] = [{ op: 'setEffect', effectId, record: candidate }]
    if (candidateLane) admission.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    admission.push({ op: 'appendEvent', event: abandonedEvent })
    this.assertStorageAdmission(admission)
    if (!this.quarantine.abandon(effectId)) return
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:abandoned`, admission, this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effectId, effect)
    if (candidateLane && lane) { Object.assign(lane, candidateLane); this.state.lanes.set(candidateLane.id, lane) }
    this.releaseEffectLocks(effectId)
    this.refreshWaits()
    this.schedulePersistence()
  }

  cancelEffect(effectId: string, graceMs = 0, reason = 'USER_REQUESTED', additionalMutations: Mutation[] = []): boolean {
    return this.requestEffectCancellation(effectId, reason, graceMs, additionalMutations)
  }

  publishArtifact(publication: ArtifactPublication): import('../core/types.js').ArtifactRecord {
    const record = prepareArtifactPublication(this.state, publication)
    this.assertStorageAdmission([{ op: 'publishArtifact', record }])
    commitMutationTransaction(this.state, this.mutationLog, `artifact:${record.ref}`, [{ op: 'publishArtifact', record }], this.state.now, this.sessionId)
    this.syncStoragePolicy()
    this.schedulePersistence()
    return record
  }

  publishFinding(publication: FindingPublication): import('../core/types.js').FindingRecord {
    const record = prepareFindingPublication(this.state, publication)
    this.assertStorageAdmission([{ op: 'publishFinding', record }])
    commitMutationTransaction(this.state, this.mutationLog, `finding:${record.id}`, [{ op: 'publishFinding', record }], this.state.now, this.sessionId)
    this.syncStoragePolicy()
    this.schedulePersistence()
    return record
  }

  readArtifact(ref: string): Uint8Array { return readArtifact(this.state, ref) }
  pinArtifact(ref: string): void { pinArtifact(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }
  unpinArtifact(ref: string): void { unpinArtifact(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }
  markArtifactPersisted(ref: string): void { markArtifactPersisted(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }

  cancelAgent(agentId: string, reason = 'USER_REQUESTED', additionalMutations: Mutation[] = [], commandTransactionId?: string): boolean {
    const agent = this.state.agents.get(agentId)
    if (!agent || ['succeeded', 'failed', 'cancelled'].includes(agent.state ?? '')) return false
    const targetAgentIds: string[] = []
    const collect = (currentAgentId: string): void => {
      if (targetAgentIds.includes(currentAgentId)) return
      const current = this.state.agents.get(currentAgentId)
      if (!current || current.detached === true || ['succeeded', 'failed', 'cancelled'].includes(current.state ?? '')) return
      targetAgentIds.push(currentAgentId)
      for (const effect of this.state.effects.values()) if (effect.agentId === currentAgentId && effect.childAgentId !== undefined) collect(effect.childAgentId)
    }
    collect(agentId)
    const targetAgentSet = new Set(targetAgentIds)
    const targetLanes = [...this.state.lanes.values()].filter((lane) => targetAgentSet.has(lane.agentId) && !['succeeded', 'failed', 'cancelled'].includes(lane.status))
    const targetEffects = [...this.state.effects.values()].filter((effect) => targetAgentSet.has(effect.agentId) && !effect.outcome)
    const cancellableEffects = targetEffects.filter((effect) => effect.childAgentId === undefined || this.state.agents.get(effect.childAgentId)?.detached !== true)
    const cancellationEvents: RuntimeEventInput[] = [
      ...targetLanes.map((lane) => ({ type: 'lane.cancelling', laneId: lane.id, data: reason })),
      ...cancellableEffects.map((effect) => ({ type: 'effect.cancel_requested', effectId: effect.id, data: { reason } })),
      ...cancellableEffects.flatMap((effect) => {
        if (this.executions.has(effect.id) && (effect.cancelGraceMs ?? 0) === 0) {
          const state = effect.sideEffectPolicy === 'write' ? 'reconcile_required' : 'cancelled'
          return [{ type: 'effect.quarantined' as const, effectId: effect.id, data: { reason, state } }]
        }
        if (!this.executions.has(effect.id)) return [{ type: 'effect.settled', effectId: effect.id, data: { status: 'cancelled', error: { code: 'CANCELLED', message: reason } } }]
        return [] as RuntimeEventInput[]
      }),
      ...targetAgentIds.map((targetId) => ({ type: 'agent.cancelled', agentId: targetId, data: reason })),
    ]
    const cancellationPreflight: Mutation[] = [
      ...additionalMutations.map((mutation) => structuredClone(mutation)),
      ...cancellationEvents.map((event) => ({ op: 'appendEvent' as const, event })),
      ...targetAgentIds.flatMap((targetId) => {
        const current = this.state.agents.get(targetId)
        if (!current) return []
        const candidate = structuredClone(current)
        candidate.state = 'cancelled'
        return [{ op: 'setAgent' as const, agentId: targetId, record: candidate }]
      }),
      ...targetLanes.flatMap((lane) => {
        const candidate = structuredClone(lane)
        candidate.status = 'cancelled'
        candidate.version++
        candidate.unresolvedEffectIds = [...new Set([...(candidate.unresolvedEffectIds ?? []), ...cancellableEffects.filter((effect) => effect.ownerLaneId === lane.id && effect.sideEffectPolicy === 'write').map((effect) => effect.id)])]
        return [{ op: 'setLane' as const, laneId: lane.id, record: candidate }]
      }),
      ...cancellableEffects.flatMap((effect) => {
        const candidate = structuredClone(effect)
        candidate.cancelRequested = { reason, at: this.state.now }
        if (this.executions.has(effect.id) && (effect.cancelGraceMs ?? 0) === 0) {
          candidate.executionState = 'remote_unknown'
          candidate.sideEffectState = candidate.sideEffectPolicy === 'write' ? 'unknown' : 'none'
          candidate.state = candidate.sideEffectState === 'unknown' ? 'reconcile_required' : 'cancelled'
          if (candidate.state === 'cancelled') candidate.outcome = { status: 'cancelled', error: { code: reason, message: reason } }
        } else if (!this.executions.has(effect.id)) {
          candidate.state = 'cancelled'
          candidate.executionState = 'failed'
          candidate.sideEffectState = 'none'
          candidate.outcome = { status: 'cancelled', error: { code: 'CANCELLED', message: reason } }
        }
        return [{ op: 'setEffect' as const, effectId: effect.id, record: candidate }]
      }),
    ]
    this.assertStorageAdmission(cancellationPreflight)
    let commandApplied = additionalMutations.length === 0
    for (const [index, targetId] of targetAgentIds.entries()) {
      const committed = this.commitAgentState(targetId, 'cancelling', index === 0 && commandTransactionId ? commandTransactionId : `agent:${targetId}:cancelling:${this.state.now}`, index === 0 ? additionalMutations : [])
      if (index === 0 && additionalMutations.length > 0) commandApplied = committed
    }
    for (const lane of targetLanes) {
      const nextLane = structuredClone(lane)
      nextLane.status = 'cancelled'
      nextLane.version++
      const event = { type: 'lane.cancelling' as const, laneId: lane.id, data: reason }
      const mutations: Mutation[] = [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }]
      this.assertStorageAdmission(mutations)
      commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:cancelling:${nextLane.version}`, mutations, this.state.now, this.sessionId)
      Object.assign(lane, nextLane)
      this.state.lanes.set(lane.id, lane)
    }
    for (const effect of targetEffects) {
      const childAgent = effect.childAgentId === undefined ? undefined : this.state.agents.get(effect.childAgentId)
      if (childAgent?.detached === true) continue
      this.requestEffectCancellation(effect.id, reason, effect.cancelGraceMs ?? 0)
    }
    for (const targetId of targetAgentIds) {
      this.commitAgentState(targetId, 'cancelled', `agent:${targetId}:cancelled:${this.state.now}`, [{ op: 'appendEvent', event: { type: 'agent.cancelled', agentId: targetId, data: reason } }])
    }
    this.schedulePersistence()
    return commandApplied
  }

  explain(laneId?: string): JsonValue {
    const readyItems = this.ready.snapshot(this.state.now)
    const lastEvent = (kind: 'lane' | 'effect', id: string): number | null => { const matching = this.state.events.filter((event) => (kind === 'lane' ? event.laneId === id : event.effectId === id)); return matching.at(-1)?.seq ?? null }
    const latestEffectMetadata = (effectId: string): JsonValue | null => { const event = [...this.state.events].reverse().find((candidate) => candidate.type === 'effect.execution_metadata' && candidate.effectId === effectId); return event?.data ?? event?.payload ?? null }
    const lanes = [...this.state.lanes.values()].filter((lane) => laneId === undefined || lane.id === laneId).map((lane) => {
      const ready = readyItems.find((item) => item.laneId === lane.id)
      const blockedBy = lane.activeWaitId ? `wait:${lane.activeWaitId}` : [...lane.ownedEffectIds].some((effectId) => this.lockBlocked.has(effectId)) ? 'resource_lock' : null
      return { id: lane.id, agentId: lane.agentId, status: lane.status, goal: lane.goal, basePriority: lane.priority, effectivePriority: ready?.effectivePriority ?? lane.priority, queueWaitMs: ready ? Math.max(0, this.state.now - lane.readySince) : 0, blockedBy, activeWaitId: lane.activeWaitId ?? null, lastEventSeq: lastEvent('lane', lane.id), watchdog: lane.progressWatchdog ?? null, consecutiveControlErrors: lane.consecutiveControlErrors ?? 0, lastInterventionReason: lane.progressWatchdog?.lastReason ?? null, unresolvedEffectIds: lane.unresolvedEffectIds ?? [] }
    })
    const effects = [...this.state.effects.values()].filter((effect) => laneId === undefined || effect.ownerLaneId === laneId).map((effect) => ({ id: effect.id, state: effect.state, executionState: effect.executionState, sideEffectState: effect.sideEffectState, attemptId: effect.attemptId, inheritedFloor: effect.inheritedFloor ?? null, deadlineAt: effect.deadlineAt ?? null, lastEventSeq: lastEvent('effect', effect.id), preparation: effect.preparation ?? null, metadata: latestEffectMetadata(effect.id) }))
    return { now: this.state.now, lanes, effects, preparation: { preparing: this.preparingLLMs.size, prepared: [...this.state.effects.values()].filter((effect) => effect.state === 'queued' && effect.preparation?.state === 'prepared').length, maxPreparing: this.maxPreparingLLMs, maxPrepared: this.maxPreparedLLMs }, quarantine: this.quarantine.unresolvedEffectIds } as unknown as JsonValue
  }

  retryEffect(effectId: string, delayMs: number): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    this.scheduleRetry(effect, undefined, delayMs)
    this.schedulePersistence()
  }

  private readyRetryEffect(effectId: string, attemptId: string): void {
    const current = this.state.effects.get(effectId)
    if (!current || current.outcome || current.state !== 'retry_wait' || current.attemptId !== attemptId) return
    const ready = structuredClone(current)
    ready.state = 'queued'
    delete ready.retryAt
    const readyEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.retry_ready', effectId: current.id, data: current.attemptId }
    this.assertStorageAdmission([{ op: 'setEffect', effectId: current.id, record: ready }, { op: 'appendEvent', event: readyEvent }])
    commitMutationTransaction(this.state, this.mutationLog, `effect:${current.id}:${current.attemptId}:retry-ready`, [{ op: 'setEffect', effectId: current.id, record: ready }, { op: 'appendEvent', event: readyEvent }], this.state.now, this.sessionId)
    Object.assign(current, ready)
    delete current.retryAt
    this.state.effects.set(current.id, current)
    this.dispatchQueuedEffects()
  }

  private scheduleRetry(effect: EffectRecord, error?: RuntimeError, forcedDelayMs?: number): boolean {
    if (effect.cancelRequested || (!forcedDelayMs && !effect.retryPolicy)) return false
    if (forcedDelayMs === undefined && error?.retryable === false) return false
    if (forcedDelayMs === undefined && effect.retryPolicy) {
      if (effect.attemptNo >= effect.retryPolicy.maxAttempts) return false
      if (effect.sideEffectState === 'unknown') return false
      if (effect.sideEffectState === 'applied' && effect.duplicateExecutionPolicy !== 'allow') return false
    }
    const policy = effect.retryPolicy
    const baseDelay = forcedDelayMs ?? Math.min(policy!.maxBackoffMs, policy!.initialBackoffMs * (2 ** Math.max(0, effect.attemptNo - 1)))
    const jitter = forcedDelayMs === undefined && policy?.jitter ? Math.floor(baseDelay / 2) : 0
    const delayMs = baseDelay + jitter
    const previousAttemptId = effect.attemptId
    const candidate = structuredClone(effect)
    candidate.state = 'retry_wait'
    candidate.executionState = 'local'
    candidate.attemptNo += 1
    candidate.attemptId = `${candidate.id}-attempt-${candidate.attemptNo}`
    candidate.retryAt = this.state.now + delayMs
    if (candidate.kind === 'llm') candidate.preparation = { state: 'stale', generation: (candidate.preparation?.generation ?? 0) + 1 }
    const retryEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.retry_scheduled', effectId: effect.id, data: { previousAttemptId, nextAttemptId: candidate.attemptId, delayMs, ...(error ? { error } : {}) } as unknown as JsonValue }
    this.assertStorageAdmission([{ op: 'setEffect', effectId: effect.id, record: candidate }, { op: 'appendEvent', event: retryEvent }])
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${previousAttemptId}:retry-scheduled`, [{ op: 'setEffect', effectId: effect.id, record: candidate }, { op: 'appendEvent', event: retryEvent }], this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effect.id, effect)
    this.clock.timers.schedule(candidate.retryAt, () => this.readyRetryEffect(effect.id, candidate.attemptId))
    return true
  }

  private dispatchQueuedEffects(): void {
    if (this.persistenceBackend) {
      this.schedulePersistence()
      if (this.dispatchPersistencePending) return
      this.dispatchPersistencePending = true
      void this.flushPersistence().then(() => {
        this.dispatchPersistencePending = false
        this.dispatchQueuedEffectsNow()
      }).catch(() => {
        this.dispatchPersistencePending = false
      })
      return
    }
    this.dispatchQueuedEffectsNow()
  }

  private dispatchQueuedEffectsNow(): void {
    const queued = [...this.state.effects.values()].filter((effect) => effect.state === 'queued' && !this.executions.has(effect.id)).sort((a, b) => (Math.max(a.schedulePriority ?? 0, a.inheritedFloor ?? Number.NEGATIVE_INFINITY) - Math.max(b.schedulePriority ?? 0, b.inheritedFloor ?? Number.NEGATIVE_INFINITY)) || a.id.localeCompare(b.id))
    for (const effect of queued) {
      if (effect.state !== 'queued' || this.executions.has(effect.id)) continue
      if (effect.kind === 'llm' && !this.prepareLLMEffect(effect)) continue
      if (effect.concurrencyClass !== 'none' && this.runningCount(effect.concurrencyClass) >= this.state.maxRunning[effect.concurrencyClass]) continue
      const budgetError = this.budgetRejection(effect)
      if (budgetError) { this.completeEffect(effect.id, { value: null, executionState: 'failed', sideEffectState: 'none' }, 'failed', budgetError); continue }
      const outboxEntry = this.outbox.enqueue(effect, this.state.now)
      if (outboxEntry.state === 'claimed') continue
      if (!this.acquireEffectLocks(effect)) continue
      const running = structuredClone(effect)
      running.state = 'running'
      running.executionState = 'running'
      const attempt: import('../core/types.js').AttemptRecord = { id: effect.attemptId, effectId: effect.id, executionState: 'running', sideEffectState: effect.sideEffectState, startedAt: this.state.now }
      running.attempts = [...(running.attempts ?? []), attempt]
      const dispatchMutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: running }]
      try { this.assertStorageAdmission(dispatchMutations) } catch { this.releaseEffectLocks(effect.id); continue }
      if (!this.outbox.claim(outboxEntry.id)) { this.releaseEffectLocks(effect.id); continue }
      commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:dispatched`, dispatchMutations, this.state.now, this.sessionId)
      Object.assign(effect, running)
      this.state.effects.set(effect.id, effect)
      const controller = new AbortController()
      if (effect.kind === 'human' && !this.customExecutor) {
        this.emit({ type: 'human.requested', effectId: effect.id, data: effect.input })
        if (effect.attemptTimeoutMs !== undefined) this.clock.schedule(effect.attemptTimeoutMs, () => { if (!effect.outcome) this.completeEffect(effect.id, { value: null }, 'failed', { code: 'ATTEMPT_TIMEOUT', message: 'Human response timed out.' }) })
        if (effect.deadlineAt !== undefined) this.clock.timers.schedule(effect.deadlineAt, () => { if (!effect.outcome) this.completeEffect(effect.id, { value: null }, 'failed', { code: 'TIMEOUT', message: 'Human response deadline exceeded.' }) })
        continue
      }
      const executionRecord: { controller: AbortController; promise: Promise<void>; timeoutTimer?: string; deadlineTimer?: string; cancelTimer?: string } = { controller, promise: Promise.resolve() }
      if (effect.kind === 'timer' && !this.customExecutor) {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        const delayMs = input.delayMs
        if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) { this.completeEffect(effect.id, { value: null }, 'failed', { code: 'INVALID_TIMER', message: 'Timer Effect requires a non-negative delayMs.' }); continue }
        let resolveTimer!: () => void
        executionRecord.promise = new Promise<void>((resolve) => { resolveTimer = resolve })
        this.executions.set(effect.id, executionRecord)
        this.clock.schedule(delayMs, () => { if (!effect.outcome) this.completeEffect(effect.id, { value: { firedAt: this.clock.now() } }); resolveTimer() })
        if (effect.attemptTimeoutMs !== undefined) executionRecord.timeoutTimer = this.clock.schedule(effect.attemptTimeoutMs, () => this.expireEffect(effect.id, 'ATTEMPT_TIMEOUT'))
        if (effect.deadlineAt !== undefined) executionRecord.deadlineTimer = this.clock.timers.schedule(effect.deadlineAt, () => this.expireEffect(effect.id, 'TIMEOUT'))
        continue
      }
      if (effect.kind === 'agent' && !this.customExecutor) {
        const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
        const programId = input.programId
        const programVersion = input.programVersion
        const goal = input.goal
        const childProgram = typeof programId === 'string' && typeof programVersion === 'string' ? this.programs.get(`${programId}@${programVersion}`) : undefined
        if (!childProgram || typeof goal !== 'string') { this.completeEffect(effect.id, { value: null }, 'failed', { code: 'INVALID_AGENT_EFFECT_INPUT', message: 'Agent Effect requires a registered program and goal.' }); continue }
        const parent = this.state.agents.get(effect.agentId)
        if ((parent?.depth ?? 0) >= this.maxAgentDepth) { this.completeEffect(effect.id, { value: null }, 'failed', { code: 'MAX_AGENT_DEPTH', message: 'Child Agent depth limit exceeded.' }); continue }
        const parentLane = this.state.lanes.get(effect.ownerLaneId)
        const parentScore = parentLane === undefined ? 0 : this.ready.snapshot(this.state.now).find((item) => item.laneId === parentLane.id)?.effectivePriority ?? parentLane.priority
        const child = this.createAgent({ goal, program: childProgram, parentAgentId: effect.agentId, inheritedFloor: parentScore })
        effect.childAgentId = child.agentId
        this.emit({ type: 'agent.effect_started', effectId: effect.id, data: child.agentId })
        continue
      }
      const emitObservation: EffectObservationEmitter = (observation) => {
        const liveEffect = this.state.effects.get(effect.id)
        if (!liveEffect || liveEffect.outcome || liveEffect.state !== 'running') return
        this.observationInbox.enqueue({ ...observation, agentId: effect.agentId, laneId: effect.ownerLaneId, timestamp: this.state.now })
      }
      const promise = this.executor(effect, controller.signal, emitObservation).then((execution) => { this.completeEffect(effect.id, execution) }).catch((cause) => { const runtimeError = runtimeErrorFromCause(cause); this.tryEmit({ type: 'effect.dispatch_failed', effectId: effect.id, data: runtimeError as unknown as JsonValue }); this.completeEffect(effect.id, { value: null, sideEffectState: 'none' }, 'failed', runtimeError) }).finally(() => { this.executions.delete(effect.id); this.refreshWaits() })
      executionRecord.promise = promise
      if (effect.attemptTimeoutMs !== undefined) executionRecord.timeoutTimer = this.clock.schedule(effect.attemptTimeoutMs, () => this.expireEffect(effect.id, 'ATTEMPT_TIMEOUT'))
      if (effect.deadlineAt !== undefined) executionRecord.deadlineTimer = this.clock.timers.schedule(effect.deadlineAt, () => this.expireEffect(effect.id, 'TIMEOUT'))
      this.executions.set(effect.id, executionRecord)
    }
  }

  private prepareLLMEffect(effect: EffectRecord): boolean {
    if (effect.preparation?.state === 'prepared') return true
    if (effect.preparation?.state === 'preparing') return false
    if (this.preparingLLMs.size >= this.maxPreparingLLMs) return false
    const preparedCount = [...this.state.effects.values()].filter((candidate) => candidate.state === 'queued' && candidate.preparation?.state === 'prepared').length
    if (preparedCount >= this.maxPreparedLLMs) return false
    const generation = (effect.preparation?.generation ?? 0) + 1
    const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    const request = input.request && typeof input.request === 'object' && !Array.isArray(input.request) ? input.request as Record<string, JsonValue> : undefined
    effect.preparation = { state: 'preparing', generation, ...(typeof request?.projectionHash === 'string' ? { projectionRef: request.projectionHash } : {}) }
    this.preparingLLMs.add(effect.id)
    Promise.resolve().then(() => {
      this.preparingLLMs.delete(effect.id)
      if (effect.outcome || effect.state !== 'queued' || effect.preparation?.generation !== generation || effect.cancelRequested) {
        if (effect.preparation?.generation === generation) effect.preparation = { state: 'stale', generation }
        return
      }
      effect.preparation = { ...effect.preparation, state: 'prepared' }
      this.emit({ type: 'llm.request_prepared', effectId: effect.id, data: { generation, projectionRef: effect.preparation.projectionRef ?? null } })
      this.dispatchQueuedEffects()
      this.syncStoragePolicy()
      this.schedulePersistence()
    })
    return false
  }

  private expireEffect(effectId: string, reason: 'ATTEMPT_TIMEOUT' | 'TIMEOUT'): void {
    const effect = this.state.effects.get(effectId)
    const execution = this.executions.get(effectId)
    if (!effect || effect.outcome || !execution) return
    this.state.now = this.clock.now()
    execution.controller.abort()
    this.quarantineEffect(effectId, reason, effect.cancelGraceMs ?? 0, { type: 'limit.rejected', effectId, data: { code: reason } })
    this.schedulePersistence()
  }

  private requestEffectCancellation(effectId: string, reason: string, graceMs: number, additionalMutations: Mutation[] = []): boolean {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return false
    const cancelEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.cancel_requested', effectId, data: { reason } }
    if (this.executions.has(effectId) && graceMs === 0) {
      return this.quarantineEffect(effectId, reason, 0, cancelEvent, additionalMutations)
    }
    const admitted = structuredClone(effect)
    admitted.cancelRequested = { reason, at: this.state.now }
    const cancellationMutations: Mutation[] = [{ op: 'setEffect', effectId, record: admitted }, { op: 'appendEvent', event: cancelEvent }]
    if (this.executions.has(effectId) && graceMs > 0) cancellationMutations.push(...additionalMutations.map((mutation) => structuredClone(mutation)))
    this.assertStorageAdmission(cancellationMutations)
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:cancel-requested`, cancellationMutations, this.state.now, this.sessionId)
    Object.assign(effect, admitted)
    this.state.effects.set(effectId, effect)
    if (!this.executions.has(effectId)) return this.completeEffect(effectId, { value: null }, 'cancelled', { code: 'CANCELLED', message: reason }, additionalMutations)
    this.executions.get(effectId)!.controller.abort()
    if (graceMs === 0) this.quarantineEffect(effectId, reason, 0)
    else this.executions.get(effectId)!.cancelTimer = this.clock.schedule(graceMs, () => this.quarantineEffect(effectId, reason, 0))
    return this.executions.has(effectId) && graceMs > 0
  }

  private quarantineEffect(effectId: string, reason: string, _graceMs: number, precedingEvent?: import('../core/types.js').RuntimeEventInput, additionalMutations: Mutation[] = []): boolean {
    const effect = this.state.effects.get(effectId)
    const execution = this.executions.get(effectId)
    if (!effect || effect.outcome) return false
    const candidate = structuredClone(effect)
    if (precedingEvent?.type === 'effect.cancel_requested' || precedingEvent?.type === 'limit.rejected') candidate.cancelRequested = { reason, at: this.state.now }
    candidate.executionState = 'remote_unknown'
    candidate.sideEffectState = candidate.sideEffectPolicy === 'write' ? 'unknown' : 'none'
    candidate.state = candidate.sideEffectState === 'unknown' ? 'reconcile_required' : 'cancelled'
    if (candidate.state === 'cancelled') candidate.outcome = { status: 'cancelled', error: { code: reason, message: reason } }
    const lane = this.state.lanes.get(effect.ownerLaneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    if (candidateLane) candidateLane.unresolvedEffectIds = [...new Set([...(candidateLane.unresolvedEffectIds ?? []), effectId])]
    const quarantineEvent: import('../core/types.js').RuntimeEventInput = { type: 'effect.quarantined', effectId, data: { reason, state: candidate.state } }
    const admission: Mutation[] = [{ op: 'setEffect', effectId, record: candidate }]
    if (candidateLane) admission.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    if (precedingEvent) admission.push({ op: 'appendEvent', event: precedingEvent })
    admission.push(...additionalMutations.map((mutation) => structuredClone(mutation)))
    admission.push({ op: 'appendEvent', event: quarantineEvent })
    this.assertStorageAdmission(admission)
    if (execution) { execution.controller.abort(); this.executions.delete(effectId) }
    this.releaseEffectLocks(effectId)
    commitMutationTransaction(this.state, this.mutationLog, `effect:${effect.id}:${effect.attemptId}:quarantined`, admission, this.state.now, this.sessionId)
    Object.assign(effect, candidate)
    this.state.effects.set(effectId, effect)
    if (candidateLane && lane) { Object.assign(lane, candidateLane); this.state.lanes.set(candidateLane.id, lane) }
    this.quarantine.add(effectId, this.state.now, reason)
    this.refreshWaits()
    this.schedulePersistence()
    return true
  }

  private propagateCancelledLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'cancelled') for (const effectId of lane.ownedEffectIds) {
      const effect = this.state.effects.get(effectId)
      const childAgent = effect?.childAgentId === undefined ? undefined : this.state.agents.get(effect.childAgentId)
      if (childAgent?.detached === true) continue
      this.requestEffectCancellation(effectId, 'LANE_CANCELLED', effect?.cancelGraceMs ?? 0)
    }
  }

  private runningCount(concurrencyClass: import('../core/types.js').ConcurrencyClass): number { return [...this.state.effects.values()].filter((effect) => effect.concurrencyClass === concurrencyClass && effect.state === 'running').length }

  budgetUsage(): { attempts: number; costByCurrency: Record<string, number> } {
    return { attempts: [...this.state.effects.values()].reduce((total, effect) => total + (effect.attempts?.length ?? 0), 0), costByCurrency: Object.fromEntries(this.budgetCost.entries()) }
  }

  private budgetRejection(effect: EffectRecord): RuntimeError | undefined {
    const attempts = [...this.state.effects.values()].reduce((total, candidate) => total + (candidate.attempts?.length ?? 0), 0)
    if (this.budget.maxTotalAttempts !== undefined && attempts >= this.budget.maxTotalAttempts) return { code: 'BUDGET_EXCEEDED', message: 'Runtime attempt budget exceeded.', details: { budget: 'maxTotalAttempts', limit: this.budget.maxTotalAttempts } }
    const kindLimit = effect.kind === 'llm' ? this.budget.maxLLMAttempts : effect.kind === 'tool' ? this.budget.maxToolAttempts : undefined
    const kindAttempts = [...this.state.effects.values()].filter((candidate) => candidate.kind === effect.kind).reduce((total, candidate) => total + (candidate.attempts?.length ?? 0), 0)
    if (kindLimit !== undefined && kindAttempts >= kindLimit) return { code: 'BUDGET_EXCEEDED', message: `${effect.kind} attempt budget exceeded.`, details: { budget: effect.kind === 'llm' ? 'maxLLMAttempts' : 'maxToolAttempts', limit: kindLimit } }
    for (const [currency, limit] of Object.entries(this.budget.maxCostByCurrency ?? {})) if ((this.budgetCost.get(currency) ?? 0) >= limit) return { code: 'BUDGET_EXCEEDED', message: `Runtime cost budget exceeded for ${currency}.`, details: { budget: 'maxCostByCurrency', currency, limit } }
    return undefined
  }

  private recordBudgetMetadata(metadata: JsonValue | undefined): void {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return
    const attempts = (metadata as Record<string, JsonValue>).attempts
    if (!Array.isArray(attempts)) return
    for (const attempt of attempts) {
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) continue
      const usage = (attempt as Record<string, JsonValue>).usage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
      const cost = (usage as Record<string, JsonValue>).cost
      if (!cost || typeof cost !== 'object' || Array.isArray(cost)) continue
      const currency = (cost as Record<string, JsonValue>).currency
      const amount = (cost as Record<string, JsonValue>).amount
      if (typeof currency === 'string' && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) this.budgetCost.set(currency, (this.budgetCost.get(currency) ?? 0) + amount)
    }
  }

  private acquireEffectLocks(effect: EffectRecord): boolean {
    const specs = [...(effect.locks ?? [])].sort((a, b) => a.resource.localeCompare(b.resource) || a.mode.localeCompare(b.mode))
    const releases: Array<() => void> = []
    for (const [index, spec] of specs.entries()) {
      const release = this.resourceLocks.tryAcquire(spec.resource, spec.mode, `${effect.id}:${effect.attemptId}:${index}`)
      if (!release) {
        for (const held of releases.reverse()) held()
        if (!this.lockBlocked.has(effect.id)) {
          this.lockBlocked.add(effect.id)
          this.emit({ type: 'effect.lock_blocked', effectId: effect.id, data: { resource: spec.resource, mode: spec.mode } })
        }
        return false
      }
      releases.push(release)
    }
    if (releases.length) this.lockReleases.set(effect.id, releases)
    this.lockBlocked.delete(effect.id)
    return true
  }

  private releaseEffectLocks(effectId: string): void {
    const releases = this.lockReleases.get(effectId)
    if (!releases) return
    this.lockReleases.delete(effectId)
    for (const release of releases.reverse()) release()
  }

  private enqueueNewReadyLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'ready' && !this.ready.has(lane.id)) this.enqueueLane(lane.id)
  }

  private commitAgentState(agentId: string, state: 'created' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled', transactionId: string, additionalMutations: Mutation[] = []): boolean {
    const agent = this.state.agents.get(agentId)
    if (!agent || agent.state === state) return false
    const nextAgent = structuredClone(agent)
    nextAgent.state = state
    const mutations: Mutation[] = [{ op: 'setAgent', agentId, record: nextAgent }, ...additionalMutations.map((mutation) => structuredClone(mutation))]
    try { this.assertStorageAdmission(mutations) }
    catch (cause) { throw cause instanceof Error ? cause : new Error(String(cause)) }
    commitMutationTransaction(this.state, this.mutationLog, transactionId, mutations, this.state.now, this.sessionId)
    this.schedulePersistence()
    return true
  }

  private commitLaneControlInput(lane: LaneRecord, input: ResumeInput, event: import('../core/types.js').RuntimeEventInput, patch: Partial<LaneRecord> = {}): boolean {
    const nextLane = structuredClone(lane)
    nextLane.pendingResumeInput = structuredClone(input)
    Object.assign(nextLane, structuredClone(patch))
    nextLane.version = lane.version + 1
    const mutations: Mutation[] = [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }]
    try { this.assertStorageAdmission(mutations) }
    catch (cause) {
      this.failLane(lane, { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }, patch)
      return false
    }
    commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:control-error:${nextLane.version}`, mutations, this.state.now, this.sessionId)
    Object.assign(lane, nextLane)
    this.state.lanes.set(lane.id, lane)
    this.enqueueLane(lane.id)
    this.schedulePersistence()
    return true
  }

  private failLane(lane: LaneRecord, failure: RuntimeError, patch: Partial<LaneRecord> = {}): void {
    const nextLane = structuredClone(lane)
    Object.assign(nextLane, structuredClone(patch))
    nextLane.status = 'failed'
    nextLane.failure = { error: structuredClone(failure), privacy: 'public' }
    nextLane.version++
    const event: import('../core/types.js').RuntimeEventInput = { type: 'lane.failed', laneId: lane.id, data: failure as unknown as JsonValue }
    try {
      this.assertStorageAdmission([{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }])
      commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:failed:${nextLane.version}`, [{ op: 'setLane', laneId: lane.id, record: nextLane }, { op: 'appendEvent', event }], this.state.now, this.sessionId)
    } catch {
      try {
        this.assertStorageAdmission([{ op: 'setLane', laneId: lane.id, record: nextLane }])
        commitMutationTransaction(this.state, this.mutationLog, `lane:${lane.id}:failed:${nextLane.version}`, [{ op: 'setLane', laneId: lane.id, record: nextLane }], this.state.now, this.sessionId)
      } catch { return }
    }
    this.schedulePersistence()
    this.refreshWaits()
  }

  private refreshWaits(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const wait of [...this.state.waits.values()]) {
        if (wait.state !== 'pending') continue
        const commitResolution = (nextWait: import('../core/types.js').WaitRecord, nextLane?: LaneRecord, extra: Mutation[] = []): boolean => {
          const mutations: Mutation[] = [{ op: 'setWait', waitId: nextWait.id, record: nextWait }]
          if (nextLane) mutations.push({ op: 'setLane', laneId: nextLane.id, record: nextLane })
          mutations.push(...extra)
          try { this.assertStorageAdmission(mutations) } catch { return false }
          commitMutationTransaction(this.state, this.mutationLog, `wait:${nextWait.id}:${nextWait.state}:${this.state.now}`, mutations, this.state.now, this.sessionId)
          this.cancelWaitDeadline(nextWait.id)
          if (nextLane?.status === 'ready') this.enqueueLane(nextLane.id)
          this.schedulePersistence()
          changed = true
          return true
        }
        const observations: Record<string, import('../core/types.js').DependencyObservation> = {}
        let pending = false
        let unsatisfied: RuntimeError | undefined
        let satisfied = 0
        let ignored = 0
        let pendingCount = 0
        for (const dependency of wait.spec.dependencies) {
          const target = dependency.target as TargetRef
          const outcome = target.kind === 'lane' ? outcomeForSeriesMember(this.state, this.state.lanes.get(target.id)!, dependency.key) : this.state.effects.get(target.id)?.outcome
          if (!outcome) { observations[dependency.key] = { state: 'pending', target }; pending = true; pendingCount++; continue }
          if (outcome.status === 'cancelled' && wait.spec.onCancelled === 'ignore') { observations[dependency.key] = { state: 'ignored', target, outcome }; ignored++ }
          else if (dependency.condition === 'success' && outcome.status !== 'succeeded') { observations[dependency.key] = { state: 'settled', target, outcome }; unsatisfied = { code: 'DEPENDENCY_FAILED', message: `${dependency.key} did not succeed` } }
          else { observations[dependency.key] = { state: 'settled', target, outcome }; satisfied++ }
        }
        const required = wait.spec.mode === 'all' ? wait.spec.dependencies.length - ignored : wait.spec.mode === 'any' ? 1 : wait.spec.quorum!
        const modeSatisfied = satisfied >= required
        const impossible = wait.spec.mode === 'all' ? Boolean(unsatisfied && !pending) : satisfied + pendingCount < required
        const modeUnsatisfied = !modeSatisfied && (impossible || (!pending && satisfied < required))
        const hardFailure = wait.spec.mode === 'all' && unsatisfied !== undefined
        if ((hardFailure || modeUnsatisfied) && wait.spec.onUnsatisfied === 'fail_lane') {
          const error = unsatisfied ?? { code: 'WAIT_QUORUM_UNREACHABLE', message: 'Wait can no longer satisfy its quorum.' }
          const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies: observations, error }
          const nextWait = structuredClone(wait)
          nextWait.state = 'unsatisfied'
          nextWait.resolution = resolution
          const lane = this.state.lanes.get(wait.laneId)
          const nextLane = lane === undefined || ['succeeded', 'failed', 'cancelled'].includes(lane.status) ? undefined : structuredClone(lane)
          if (nextLane) {
            nextLane.status = 'failed'
            nextLane.failure = { error: structuredClone(error), privacy: 'public' }
            delete nextLane.activeWaitId
            nextLane.version++
          }
          commitResolution(nextWait, nextLane, nextLane === undefined ? [] : [{ op: 'appendEvent', event: { type: 'lane.failed', laneId: nextLane.id, data: error as unknown as JsonValue } }])
        } else if (modeUnsatisfied || (hardFailure && !pending)) {
          const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies: observations, error: unsatisfied ?? { code: 'WAIT_QUORUM_UNREACHABLE', message: 'Wait can no longer satisfy its quorum.' } }
          const nextWait = structuredClone(wait)
          nextWait.state = 'unsatisfied'
          nextWait.resolution = resolution
          const lane = this.state.lanes.get(wait.laneId)
          const nextLane = lane === undefined || ['succeeded', 'failed', 'cancelled'].includes(lane.status) ? undefined : structuredClone(lane)
          if (nextLane) {
            nextLane.status = 'ready'
            delete nextLane.activeWaitId
            nextLane.pendingResumeInput = { type: 'wait', resolution }
          }
          commitResolution(nextWait, nextLane)
        } else if (modeSatisfied || (!pending && !unsatisfied && wait.spec.mode === 'all')) {
          const resolution = { waitId: wait.id, status: 'satisfied' as const, dependencies: observations }
          const nextWait = structuredClone(wait)
          nextWait.state = 'satisfied'
          nextWait.resolution = resolution
          const lane = this.state.lanes.get(wait.laneId)
          const nextLane = lane === undefined || ['succeeded', 'failed', 'cancelled'].includes(lane.status) ? undefined : structuredClone(lane)
          if (nextLane) {
            if (nextLane.closingResult) {
              let resultSequence = this.state.nextIds.result
              while (this.state.results.has(`result-${resultSequence}`)) resultSequence++
              const resultId = `result-${resultSequence}`
              const result = { id: resultId, value: nextLane.closingResult.value, storageState: 'memory' as const, pinCount: 0, privacy: nextLane.closingResult.privacy, ...(nextLane.closingResult.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(nextLane.closingResult.privacyTaints) }), derivedFrom: [...(nextLane.closingResult.derivedFrom ?? [])] }
              delete nextLane.activeWaitId
              nextLane.status = 'succeeded'
              nextLane.resultRef = resultId
              delete nextLane.closingResult
              if (nextLane.visibleResultRefs) nextLane.visibleResultRefs.add(resultId)
              else nextLane.visibleResultRefs = new Set([resultId])
              if (!commitResolution(nextWait, nextLane, [{ op: 'publishResult', record: result }, { op: 'appendEvent', event: { type: 'lane.succeeded', laneId: nextLane.id, data: resultId } }])) {
                const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: 'Session storage limit exceeded while committing a closing Lane result.' }
                const failedWait = structuredClone(wait)
                failedWait.state = 'unsatisfied'
                failedWait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error: storageError }
                const failedLane = structuredClone(lane!)
                delete failedLane.activeWaitId
                failedLane.status = 'failed'
                failedLane.failure = { error: storageError, privacy: 'public' }
                failedLane.version++
                commitResolution(failedWait, failedLane, [{ op: 'appendEvent', event: { type: 'lane.failed', laneId: failedLane.id, data: storageError as unknown as JsonValue } }])
              }
            } else {
              delete nextLane.activeWaitId
              nextLane.status = 'ready'
              nextLane.pendingResumeInput = { type: 'wait', resolution }
              commitResolution(nextWait, nextLane)
            }
          } else {
            commitResolution(nextWait)
          }
        }
      }
    }
    this.recomputePriorityInheritance()
  }

  private scheduleWaitDeadline(wait: import('../core/types.js').WaitRecord): void {
    if (wait.state !== 'pending' || wait.spec.deadlineAt === undefined || this.waitDeadlineTimers.has(wait.id)) return
    const timerId = this.clock.timers.schedule(wait.spec.deadlineAt, () => this.expireWait(wait.id))
    this.waitDeadlineTimers.set(wait.id, timerId)
  }

  private cancelWaitDeadline(waitId: string): void {
    const timerId = this.waitDeadlineTimers.get(waitId)
    if (timerId !== undefined) { this.clock.timers.cancel(timerId); this.waitDeadlineTimers.delete(waitId) }
  }

  private expireWait(waitId: string): void {
    const wait = this.state.waits.get(waitId)
    if (!wait || wait.state !== 'pending') return
    const observations: Record<string, import('../core/types.js').DependencyObservation> = {}
    for (const dependency of wait.spec.dependencies) {
      const target = dependency.target as TargetRef
      const outcome = target.kind === 'lane' ? outcomeForSeriesMember(this.state, this.state.lanes.get(target.id)!, dependency.key) : this.state.effects.get(target.id)?.outcome
      observations[dependency.key] = outcome === undefined ? { state: 'pending', target } : outcome.status === 'cancelled' && wait.spec.onCancelled === 'ignore' ? { state: 'ignored', target, outcome } : { state: 'settled', target, outcome }
    }
    const error: RuntimeError = { code: 'WAIT_DEADLINE_EXCEEDED', message: 'Wait deadline exceeded.', details: { deadlineAt: wait.spec.deadlineAt ?? this.state.now } }
    const resolution = { waitId: wait.id, status: 'unsatisfied' as const, dependencies: observations, error }
    const candidateWait = structuredClone(wait)
    candidateWait.state = 'unsatisfied'
    candidateWait.resolution = resolution
    const lane = this.state.lanes.get(wait.laneId)
    const candidateLane = lane === undefined ? undefined : structuredClone(lane)
    const events: import('../core/types.js').RuntimeEventInput[] = []
    if (candidateLane && !['succeeded', 'failed', 'cancelled'].includes(candidateLane.status)) {
      delete candidateLane.activeWaitId
      if (wait.spec.onUnsatisfied === 'fail_lane') {
        candidateLane.status = 'failed'
        candidateLane.version++
        events.push({ type: 'lane.failed', laneId: candidateLane.id, data: error as unknown as JsonValue })
      } else {
        candidateLane.status = 'ready'
        candidateLane.pendingResumeInput = { type: 'wait', resolution }
      }
    }
    events.push({ type: 'wait.deadline_exceeded', laneId: wait.laneId, data: { waitId: wait.id, deadlineAt: wait.spec.deadlineAt ?? this.state.now } })
    const mutations: Mutation[] = [{ op: 'setWait', waitId: wait.id, record: candidateWait }]
    if (candidateLane) mutations.push({ op: 'setLane', laneId: candidateLane.id, record: candidateLane })
    for (const event of events) mutations.push({ op: 'appendEvent', event })
    try { this.assertStorageAdmission(mutations) } catch (cause) {
      const timerId = this.clock.timers.schedule(this.clock.now(), () => this.expireWait(waitId))
      this.waitDeadlineTimers.set(waitId, timerId)
      throw cause
    }
    this.waitDeadlineTimers.delete(waitId)
    commitMutationTransaction(this.state, this.mutationLog, `wait:${wait.id}:deadline:${wait.spec.deadlineAt ?? this.state.now}`, mutations, this.state.now, this.sessionId)
    if (candidateLane && candidateLane.status === 'ready') this.enqueueLane(candidateLane.id)
    this.refreshWaits()
  }

  private recomputePriorityInheritance(): void {
    this.priorityInheritance.clear()
    for (const effect of this.state.effects.values()) delete effect.inheritedFloor
    const childEffectsWithPendingWait = new Set<string>()
    for (const wait of this.state.waits.values()) if (wait.state === 'pending') for (const dependency of wait.spec.dependencies) if ((dependency.target as TargetRef).kind === 'effect') {
      const effect = this.state.effects.get((dependency.target as TargetRef).id)
      if (effect?.childAgentId) childEffectsWithPendingWait.add(effect.id)
    }
    for (const agent of this.state.agents.values()) {
      const root = this.state.lanes.get(agent.rootLaneId)
      const ownedAgentEffect = [...this.state.effects.values()].find((effect) => effect.childAgentId === agent.id)
      if (root && (!ownedAgentEffect || !childEffectsWithPendingWait.has(ownedAgentEffect.id))) delete root.inheritedFloor
    }
    for (const wait of this.state.waits.values()) {
      if (wait.state !== 'pending') continue
      const consumer = this.state.lanes.get(wait.laneId)
      if (!consumer) continue
      for (const dependency of wait.spec.dependencies) {
        const target = dependency.target as TargetRef
        if (target.kind === 'lane') {
          const lane = this.state.lanes.get(target.id)
          if (lane && lane.status === 'ready') { this.priorityInheritance.raise(lane.id, consumer.id, consumer.priority); const inheritedFloor = this.priorityInheritance.floor(lane.id); this.ready.enqueue({ ...readyItemFromLane(lane), ...(inheritedFloor === undefined ? {} : { inheritedFloor }) }) }
        } else {
          const effect = this.state.effects.get(target.id)
          if (effect && effect.state === 'queued') {
            this.priorityInheritance.raise(effect.id, consumer.id, consumer.priority)
            const inheritedFloor = this.priorityInheritance.floor(effect.id)
            if (inheritedFloor === undefined) delete effect.inheritedFloor
            else effect.inheritedFloor = inheritedFloor
            if (effect.childAgentId) {
              const childRoot = this.state.agents.get(effect.childAgentId)?.rootLaneId
              const childLane = childRoot === undefined ? undefined : this.state.lanes.get(childRoot)
              if (childLane && childLane.status === 'ready') { if (inheritedFloor === undefined) delete childLane.inheritedFloor; else childLane.inheritedFloor = inheritedFloor; this.ready.enqueue(readyItemFromLane(childLane)) }
            }
          }
        }
      }
    }
  }
}
