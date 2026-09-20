import { commitMutationTransaction, MutationLog } from '../storage/mutation-log.js'
import { createAgent } from '../core/factory.js'
import { validateStep } from '../transitions/validate.js'
import { PriorityInheritance, ReadyQueue, readyItemFromLane, VirtualClock } from './index.js'
import type { EffectRecord, EffectSubmission, JsonValue, LaneRecord, LaneStepOutput, Outcome, ResumeInput, RuntimeState, RuntimeError, TargetRef, WaitRecord, ToolCallCorrelation, SeriesLaneSpec, ForkAffinityMode, PrivacyTaint, PrivacyMetadata, ProvenanceRef } from '../core/types.js'
import { createRuntimeState, effectivePrivacy, privacyMetadataForDerivedRef, privacyTaintsForDerivedRefs, provenanceRefId, provenanceRefKind, strictestPrivacy, validatePrivacyTaints } from '../core/types.js'
import { QuarantineScope } from '../lifecycle/scopes.js'
import { PulseSession } from '../dsl/session.js'
import { assertProgramPure } from '../dsl/program.js'
import { FactInbox, ObservationInbox } from '../core/inbox.js'
import { observeProgress } from '../lifecycle/watchdog.js'
import { EffectOutbox } from '../storage/outbox.js'
import { exportRuntimeCheckpoint, exportRuntimePersistence, importRuntimePersistence, type RuntimePersistenceBackend, type RuntimePersistenceSnapshot } from '../storage/persistence.js'
import { ResourceLockManager } from './locks.js'
import { appendRuntimeEvent } from '../core/events.js'
import { apply, type Mutation } from '../core/mutations.js'
import { ContextMerger, type MergePlan } from '../context/merger.js'
import { appendHistory, contentHash, historyPressure } from '../context/builder.js'
import { validateJsonSchema } from '../models/router.js'
import { SessionStoragePolicy, type StoragePolicyConfig } from '../storage/policy.js'
import { collectRuntimeTelemetry, type RuntimeTelemetryExporter, type RuntimeTelemetrySnapshot } from './telemetry.js'
import { markArtifactPersisted, pinArtifact, publishArtifact, readArtifact, unpinArtifact, type ArtifactPublication } from '../storage/artifacts.js'
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
export interface EffectExecution { value: JsonValue; summary?: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; sideEffectState?: 'none' | 'applied' | 'known' | 'unknown'; executionRef?: JsonValue; executionState?: 'succeeded' | 'failed' | 'remote_unknown'; status?: 'succeeded' | 'failed' | 'cancelled'; error?: RuntimeError; rejectedOutput?: { value: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; privacyTaints?: PrivacyTaint[]; derivedFrom?: ProvenanceRef[] }; metadata?: JsonValue; observations?: EffectObservation[] }
export type EffectExecutor = (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution>
type HostCommand = { type: 'reply'; effectId: string; value: JsonValue } | { type: 'cancel'; agentId: string; reason: string }

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
  maxPreparingLLMs?: number
  maxPreparedLLMs?: number
  trustedSanitizerIds?: string[]
  storagePolicy?: StoragePolicyConfig
  persistence?: RuntimePersistenceSnapshot
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
  private readonly budget: RuntimeBudgetConfig
  private readonly budgetCost = new Map<string, number>()
  private persistencePending: Promise<void> = Promise.resolve()
  private persistenceScheduled = false
  private persistenceDirty = false
  readonly mutationLog: MutationLog
  readonly outbox: EffectOutbox
  readonly clock: VirtualClock
  readonly ready: ReadyQueue
  readonly quarantine = new QuarantineScope()
  readonly priorityInheritance = new PriorityInheritance()
  readonly resourceLocks = new ResourceLockManager()
  readonly storagePolicy: SessionStoragePolicy
  readonly factInbox = new FactInbox<HostCommand>()
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
  private readonly maxAgentDepth: number
  private readonly maxPreparingLLMs: number
  private readonly maxPreparedLLMs: number
  private readonly effectSubmissionPreparer: ((submission: EffectSubmission) => EffectSubmission) | undefined
  private readonly preparingLLMs = new Set<string>()
  private readonly sessionId: string
  private hostCommandSeq = 1
  private factWaiters: Array<() => void> = []

  static async restore(backend: RuntimePersistenceBackend, config: Omit<RuntimeConfig, 'persistence'> = {}): Promise<PulseRuntime> {
    const snapshot = await backend.load()
    return new PulseRuntime(snapshot === undefined ? config : { ...config, persistence: snapshot })
  }

  constructor(config: RuntimeConfig = {}) {
    const restored = config.persistence === undefined ? undefined : importRuntimePersistence(config.persistence)
    this.state = restored?.state ?? createRuntimeState(config.maxTotalLanes ?? 64, { ...(config.maxQueuedEffects === undefined ? {} : { maxQueuedEffects: config.maxQueuedEffects }), ...(config.maxRunning === undefined ? {} : { maxRunning: config.maxRunning }), ...(config.forkAffinity === undefined ? {} : { forkAffinity: config.forkAffinity }), ...(config.historySoftTokens === undefined ? {} : { historySoftTokens: config.historySoftTokens }), ...(config.historyHardTokens === undefined ? {} : { historyHardTokens: config.historyHardTokens }), ...(config.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: config.maxResultSummaryBytes }), ...(config.trustedSanitizerIds === undefined ? {} : { trustedSanitizerIds: config.trustedSanitizerIds }) })
    if (config.trustedSanitizerIds) for (const sanitizerId of config.trustedSanitizerIds) this.state.trustedSanitizerIds.add(sanitizerId)
    this.sessionId = config.sessionId ?? 'session-local'
    this.storagePolicy = restored?.storagePolicy ?? new SessionStoragePolicy(config.storagePolicy)
    this.mutationLog = restored?.mutationLog ?? new MutationLog()
    this.outbox = restored?.outbox ?? new EffectOutbox()
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
          if (effect.sideEffectPolicy === 'write') { effect.state = 'reconcile_required'; effect.executionState = 'remote_unknown'; effect.sideEffectState = 'unknown'; this.quarantine.add(effect.id, this.state.now, 'recovery_in_doubt') }
          else { effect.state = 'queued'; effect.executionState = 'local' }
        }
        if (effect.state === 'retry_wait' && effect.retryAt !== undefined) this.clock.timers.schedule(effect.retryAt, () => { if (!effect.outcome && effect.state === 'retry_wait') { effect.state = 'queued'; delete effect.retryAt; this.dispatchQueuedEffects() } })
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
    const parent = request.parentAgentId === undefined ? undefined : this.state.agents.get(request.parentAgentId)
    if (request.parentAgentId !== undefined && !parent) throw new Error(`PARENT_AGENT_NOT_FOUND:${request.parentAgentId}`)
    const { agent, root } = createAgent(this.state, request.goal, { programId: request.program.id, programVersion: request.program.version, step: (request.program as LaneProgram & { entry?: string }).entry ?? 'start', locals: {} }, { ...(request.agentId === undefined ? {} : { agentId: request.agentId }), ...(initialGlobal === undefined ? {} : { initialGlobal }), ...(initialGlobalPrivacy === undefined ? {} : { initialGlobalPrivacy }), ...(request.parentAgentId === undefined ? {} : { parentAgentId: request.parentAgentId, depth: (parent?.depth ?? 0) + 1 }), ...(request.inheritedFloor === undefined ? {} : { inheritedFloor: request.inheritedFloor }) })
    if (warmStartResultRefs.length) root.visibleResultRefs = new Set(warmStartResultRefs)
    if (request.program.seriesKeys?.length) root.resume.locals = { $sdk: { series: { keys: [...request.program.seriesKeys], index: 0 } } }
    root.enqueueSeq = this.enqueueSeq++
    agent.state = 'running'
    this.ready.enqueue(readyItemFromLane(root))
    this.syncStoragePolicy()
    this.schedulePersistence()
    return { agentId: agent.id, laneId: root.id }
  }
  start(agentId: string): PulseSession { if (!this.state.agents.has(agentId)) throw new Error(`UNKNOWN_AGENT:${agentId}`); return new PulseSession(this, agentId) }
  detachAgent(agentId: string): BackgroundAgentInfo {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    agent.detached = true
    this.emit({ type: 'agent.detached', agentId, data: { agentId } })
    this.schedulePersistence()
    return { agentId, rootLaneId: agent.rootLaneId, state: agent.state ?? 'created', detached: true }
  }
  attachAgent(agentId: string): void {
    const agent = this.state.agents.get(agentId)
    if (!agent) throw new Error(`UNKNOWN_AGENT:${agentId}`)
    if (!agent.detached) return
    delete agent.detached
    this.emit({ type: 'agent.attached', agentId, data: { agentId } })
    this.schedulePersistence()
  }
  backgroundAgents(): BackgroundAgentInfo[] {
    return [...this.state.agents.values()].filter((agent) => agent.detached === true).map((agent) => ({ agentId: agent.id, rootLaneId: agent.rootLaneId, state: agent.state ?? 'created', detached: true }))
  }
  exportPersistence(): RuntimePersistenceSnapshot { return exportRuntimePersistence(this.state, this.mutationLog, this.outbox, this.quarantine, this.storagePolicy) }
  async persist(backend: RuntimePersistenceBackend): Promise<void> {
    const persistedPolicy = this.storagePolicy.clone()
    persistedPolicy.markPersisted()
    await backend.save(exportRuntimePersistence(this.state, this.mutationLog, this.outbox, this.quarantine, persistedPolicy))
    this.storagePolicy.markPersisted()
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
    const snapshot = exportRuntimeCheckpoint(this.state, this.mutationLog, this.outbox, this.quarantine, persistedPolicy, eventWatermark === undefined ? {} : { compactEventsThrough: eventWatermark })
    await backend.save(snapshot)
    this.storagePolicy.markPersisted()
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

  private emit(event: import('../core/types.js').RuntimeEventInput): import('../core/types.js').RuntimeEvent { return appendRuntimeEvent(this.state, event, { sessionId: this.sessionId, timestamp: this.state.now }) }
  private prepareStepOutput(output: LaneStepOutput): LaneStepOutput {
    if (!this.effectSubmissionPreparer) return output
    return { ...output, actions: output.actions.map((action) => action.type === 'submit_effects' ? { ...action, effects: action.effects.map((effect) => this.effectSubmissionPreparer!(effect)) } : action) }
  }
  private journalEffect(effect: EffectRecord, transactionId: string, result?: import('../core/types.js').ResultRecord, events: import('../core/types.js').RuntimeEvent[] = [], lane?: LaneRecord, correlation?: ToolCallCorrelation): void {
    const mutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: structuredClone(effect) }]
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
    this.factInbox.enqueue(command, `host-command-${this.hostCommandSeq++}`)
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
    this.state.now = this.clock.now()
    for (const envelope of this.factInbox.drain()) {
      this.emit({ id: envelope.eventId, type: 'command.enqueued', data: envelope.fact as unknown as JsonValue })
      if (envelope.fact.type === 'reply') this.completeEffect(envelope.fact.effectId, { value: envelope.fact.value })
      else this.cancelAgent(envelope.fact.agentId, 'USER_REQUESTED')
      this.emit({ type: 'command.applied', data: { eventId: envelope.eventId } })
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
      if (currentPressure) lane.historyPressure = currentPressure
      else delete lane.historyPressure
      const program = this.programs.get(`${lane.resume.programId}@${lane.resume.programVersion}`)
      if (!program) { this.failLane(lane, { code: 'PROGRAM_NOT_REGISTERED', message: `${lane.resume.programId}@${lane.resume.programVersion}` }); continue }
      let output: LaneStepOutput
      const stepContext: LaneStepContext = { lane: structuredClone(lane), state: structuredClone(this.state), ...(lane.pendingResumeInput ? { resumeInput: structuredClone(lane.pendingResumeInput) } : {}), now: this.state.now, observe: (event) => { this.observationInbox.enqueue({ ...event, agentId: lane.agentId, laneId: lane.id, timestamp: this.state.now }) } }
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
        if (result.rejection.code === 'FORK_AFFINITY_COLLAPSIBLE') {
          lane.pendingResumeInput = { type: 'control_error', error: result.rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
          this.emit({ type: 'fork.affinity_advice', laneId: lane.id, data: result.rejection as unknown as JsonValue })
          this.enqueueLane(lane.id)
        } else {
          lane.consecutiveControlErrors = consecutive
          if (consecutive >= this.maxConsecutiveControlErrors) this.failLane(lane, { code: 'CONTROL_ERROR_LOOP', message: 'Lane exceeded the consecutive control error limit.', details: { lastError: result.rejection as unknown as JsonValue } })
          else {
            lane.pendingResumeInput = { type: 'control_error', error: result.rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
            this.emit({ type: 'step.rejected', laneId: lane.id, data: result.rejection as unknown as JsonValue })
            this.enqueueLane(lane.id)
          }
        }
      } else {
        try { this.assertStorageAdmission(result.mutations) }
        catch (cause) {
          const storageError: RuntimeError = { code: 'SESSION_STORAGE_LIMIT_EXCEEDED', message: cause instanceof Error ? cause.message : String(cause) }
          lane.pendingResumeInput = { type: 'control_error', error: storageError, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
          this.emit({ type: 'storage.limit_exceeded', laneId: lane.id, data: storageError as unknown as JsonValue })
          this.enqueueLane(lane.id)
          progressed++
          continue
        }
        commitMutationTransaction(this.state, this.mutationLog, `step:${lane.id}:${lane.version + 1}`, result.mutations, this.state.now, this.sessionId)
        for (const mutation of result.mutations) if (mutation.op === 'insertEffect') this.outbox.enqueue(mutation.record, this.state.now)
        for (const mutation of result.mutations) if (mutation.op === 'insertWait') this.scheduleWaitDeadline(mutation.record)
        const updated = this.state.lanes.get(lane.id)
        if (updated) delete updated.consecutiveControlErrors
        if (updated && updated.pendingResumeInput) delete updated.pendingResumeInput
        if (updated) {
          const watchdog = observeProgress(lane, preparedOutput, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold })
          updated.progressWatchdog = watchdog.state
          if (!watchdog.progressed) this.emit({ type: watchdog.state.interventionLevel >= 3 ? 'progress.no_progress_detected' : 'progress.intervention_applied', laneId: lane.id, data: { noProgressCount: watchdog.state.noProgressCount, interventionLevel: watchdog.state.interventionLevel } })
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

  async run(maxTicks = 10_000): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> {
    for (let tick = 0; tick < maxTicks; tick++) {
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
    if (agent && ['succeeded', 'failed', 'cancelled'].includes(root?.status ?? 'failed')) agent.state = status
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
        agent.state = status
        this.schedulePersistence()
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

  private syncStoragePolicy(policy = this.storagePolicy, state = this.state): void {
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
    policy.replacePinSource('runtime', pinKeys)
    for (const lane of state.lanes.values()) {
      const snapshotKey = `snapshot:lane:${lane.id}:${lane.context.version}`
      policy.put('snapshot', snapshotKey, { laneId: lane.id, version: lane.context.version, context: lane.context, resume: lane.resume } as unknown as JsonValue)
    }
    for (const agent of state.agents.values()) {
      for (const [version, value] of agent.globalVersions) {
        const key = `snapshot:global:${agent.id}:${version}`
        policy.put('snapshot', key, { agentId: agent.id, version, value } as unknown as JsonValue)
      }
    }
    for (const wait of state.waits.values()) {
      const key = `snapshot:wait:${wait.id}`
      policy.put('snapshot', key, wait as unknown as JsonValue)
    }
    for (const effect of state.effects.values()) {
      if (!effect.outcome && effect.kind === 'llm') {
        const key = `snapshot:request:${effect.id}:${effect.attemptId}`
        policy.put('snapshot', key, { effectId: effect.id, attemptId: effect.attemptId, input: effect.input } as unknown as JsonValue)
      }
    }
    for (const result of state.results.values()) policy.put('result', `result:${result.id}`, result as unknown as JsonValue)
    for (const artifact of state.artifacts.values()) policy.put('artifact', `artifact:${artifact.ref}`, artifact as unknown as JsonValue)
    for (const event of state.events) policy.put('event', `event:${event.id}`, event as unknown as JsonValue)
    for (const lane of state.lanes.values()) if (lane.pendingResumeInput) policy.put('snapshot', `snapshot:resume:${lane.id}:${lane.version}`, lane.pendingResumeInput as unknown as JsonValue)
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
      child.state = status
      this.completeEffect(effect.id, { value: { agentId: child.id, status } }, status, status === 'failed' ? { code: 'CHILD_AGENT_FAILED', message: 'Child Agent failed.' } : undefined)
    }
  }

  completeEffect(effectId: string, execution: EffectExecution, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', error?: RuntimeError): void {
    const effect = this.state.effects.get(effectId)
    if (!effect) return
    if (effect.outcome) { this.emit({ type: 'attempt.late_emit', effectId, data: { status: effect.outcome.status } }); return }
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    if (execution.executionState === 'remote_unknown') { this.markRemoteUnknown(effectId, execution.sideEffectState ?? 'none'); return }
    let effectiveExecution = execution
    let outputError = error ?? execution.error
    const rawInput = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
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
      this.releaseEffectLocks(effectId)
      this.outbox.ack(`${effect.id}:${settledAttemptId}`)
      this.refreshWaits()
      this.schedulePersistence()
      return
    }
    const resultId = `result-${this.state.nextIds.result++}`
    const rejectedOutputId = effectiveStatus !== 'succeeded' && effectiveExecution.rejectedOutput ? resultId : undefined
    const outcome: Outcome = effectiveStatus === 'succeeded' ? { status: effectiveStatus, resultRef: resultId } : { status: effectiveStatus, ...(outputError ? { error: outputError } : {}), ...(rejectedOutputId ? { rejectedOutputRefs: [rejectedOutputId] } : {}) }
    effect.outcome = outcome
    this.releaseEffectLocks(effectId)
    this.outbox.ack(`${effect.id}:${effect.attemptId}`)
    for (const observation of effectiveExecution.observations ?? []) this.observationInbox.enqueue({ ...observation, agentId: effect.agentId, laneId: effect.ownerLaneId, timestamp: this.state.now })
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
    if (effectiveExecution.summary !== undefined && !summaryAllowed) this.emit({ type: 'result.summary_rejected', effectId, data: { maxBytes: this.state.maxResultSummaryBytes, actualBytes: Buffer.byteLength(JSON.stringify(effectiveExecution.summary), 'utf8') } })
    const result = effectiveStatus === 'succeeded' && !taintError ? { id: resultId, effectId, value: effectiveExecution.value, privacy: effectivePrivacy(strictestPrivacy([effectiveExecution.privacy ?? 'public', ...sourcePrivacy]), outputTaints), ...(outputTaints.length ? { privacyTaints: outputTaints } : {}), derivedFrom: [...(effect.derivedFrom ?? [])], ...(summaryAllowed && effectiveExecution.summary !== undefined ? { summary: effectiveExecution.summary } : {}) } : rejectedOutputId && effectiveExecution.rejectedOutput && !taintError ? { id: rejectedOutputId, effectId, kind: 'rejected_output' as const, value: effectiveExecution.rejectedOutput.value, privacy: effectivePrivacy(strictestPrivacy([effectiveExecution.rejectedOutput.privacy ?? effectiveExecution.privacy ?? 'public', ...sourcePrivacy]), rejectedTaints), ...(rejectedTaints.length ? { privacyTaints: rejectedTaints } : {}), derivedFrom: [...(effectiveExecution.rejectedOutput.derivedFrom ?? effect.derivedFrom ?? [])] } : undefined
    if (result) this.state.results.set(resultId, result)
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
      this.state.lanes.set(journalLane.id, journalLane)
    }
    let correlation: ToolCallCorrelation | undefined
    if (effect.kind === 'tool' && effect.toolCallId && result) {
      const existing = this.state.toolCallCorrelations.get(effect.toolCallId)
      if (existing) {
        correlation = { ...existing, toolEffectId: effect.id, resultRef: result.id }
        this.state.toolCallCorrelations.set(effect.toolCallId, correlation)
      }
    }
    const settledEvent = this.emit({ type: 'effect.settled', effectId, data: outcome as unknown as JsonValue })
    const metadataEvent = execution.metadata === undefined ? undefined : this.emit({ type: 'effect.execution_metadata', effectId, data: execution.metadata })
    this.recordBudgetMetadata(execution.metadata)
    this.journalEffect(effect, `effect:${effect.id}:${settledAttemptId}:settled`, result, [settledEvent, ...(metadataEvent ? [metadataEvent] : [])], journalLane, correlation)
    this.refreshWaits()
    this.dispatchQueuedEffects()
    this.schedulePersistence()
  }

  markRemoteUnknown(effectId: string, sideEffectState: 'none' | 'applied' | 'known' | 'unknown'): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    effect.executionState = 'remote_unknown'
    effect.sideEffectState = sideEffectState
    const attempt = effect.attempts?.at(-1)
    if (attempt) { attempt.executionState = 'remote_unknown'; attempt.sideEffectState = sideEffectState; attempt.settledAt = this.state.now }
    if (sideEffectState === 'unknown') { effect.state = 'reconcile_required'; this.quarantine.add(effect.id, this.state.now, 'in_doubt') }
    else {
      const unknownAttempts = effect.attempts?.filter((attempt) => attempt.executionState === 'remote_unknown').length ?? 0
      const settledAttemptId = effect.attemptId
      if (effect.duplicateExecutionPolicy === 'allow' && effect.maxUnknownAttempts !== undefined && unknownAttempts <= effect.maxUnknownAttempts && this.scheduleRetry(effect, { code: 'REMOTE_EXECUTION_UNKNOWN', message: 'Remote execution outcome is unknown.', details: { unknownAttempts } })) {
        this.journalEffect(effect, `effect:${effect.id}:${settledAttemptId}:remote-unknown-retry`)
        this.releaseEffectLocks(effectId)
        this.outbox.ack(`${effect.id}:${settledAttemptId}`)
        this.refreshWaits()
        this.schedulePersistence()
        return
      }
      effect.state = 'failed'
      effect.outcome = { status: 'failed', error: { code: 'REMOTE_UNKNOWN', message: 'Remote execution outcome is unknown but no side effect was recorded.' } }
      const remoteEvent = this.emit({ type: 'effect.remote_unknown', effectId, data: { executionState: 'remote_unknown', sideEffectState } })
      this.journalEffect(effect, `effect:${effect.id}:${effect.attemptId}:remote-unknown`, undefined, [remoteEvent])
      this.releaseEffectLocks(effectId)
    }
    if (sideEffectState !== 'unknown') this.releaseEffectLocks(effectId)
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
    if (!this.quarantine.abandon(effectId)) return
    effect.state = 'failed'
    effect.executionState = 'local_closed'
    effect.sideEffectState = 'unknown'
    effect.outcome = { status: 'failed', error: { code: 'RESOURCE_ABANDONED', message: 'Host abandoned reconciliation for an unknown side effect.' } }
    this.releaseEffectLocks(effectId)
    const lane = this.state.lanes.get(effect.ownerLaneId)
    if (lane?.unresolvedEffectIds) lane.unresolvedEffectIds = lane.unresolvedEffectIds.filter((id) => id !== effectId)
    const abandonedEvent = this.emit({ type: 'resource.abandoned', effectId, data: { code: 'RESOURCE_ABANDONED' } })
    this.journalEffect(effect, `effect:${effect.id}:${effect.attemptId}:abandoned`, undefined, [abandonedEvent])
    this.refreshWaits()
    this.schedulePersistence()
  }

  cancelEffect(effectId: string, graceMs = 0): void {
    this.requestEffectCancellation(effectId, 'USER_REQUESTED', graceMs)
  }

  publishArtifact(publication: ArtifactPublication): import('../core/types.js').ArtifactRecord {
    const record = publishArtifact(this.state, publication)
    this.syncStoragePolicy()
    this.schedulePersistence()
    return record
  }

  readArtifact(ref: string): Uint8Array { return readArtifact(this.state, ref) }
  pinArtifact(ref: string): void { pinArtifact(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }
  unpinArtifact(ref: string): void { unpinArtifact(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }
  markArtifactPersisted(ref: string): void { markArtifactPersisted(this.state, ref); this.syncStoragePolicy(); this.schedulePersistence() }

  cancelAgent(agentId: string, reason: 'USER_REQUESTED' | 'SUPERSEDED' | 'POLICY' | 'TIMEOUT' = 'USER_REQUESTED'): void {
    const agent = this.state.agents.get(agentId)
    if (!agent || ['succeeded', 'failed', 'cancelled'].includes(agent.state ?? '')) return
    agent.state = 'cancelling'
    for (const lane of this.state.lanes.values()) if (lane.agentId === agentId && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'cancelled'; lane.version++; this.emit({ type: 'lane.cancelling', laneId: lane.id, data: reason }); for (const effectId of lane.ownedEffectIds) { const effect = this.state.effects.get(effectId); const childAgent = effect?.childAgentId === undefined ? undefined : this.state.agents.get(effect.childAgentId); if (childAgent?.detached === true) continue; if (effect?.childAgentId) this.cancelAgent(effect.childAgentId, reason); this.requestEffectCancellation(effectId, reason, effect?.cancelGraceMs ?? 0) } }
    agent.state = 'cancelled'
    this.emit({ type: 'agent.cancelled', data: reason })
    this.schedulePersistence()
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
    effect.state = 'retry_wait'
    effect.executionState = 'local'
    effect.attemptNo += 1
    effect.attemptId = `${effect.id}-attempt-${effect.attemptNo}`
    effect.retryAt = this.state.now + delayMs
    if (effect.kind === 'llm') { effect.preparation = { state: 'stale', generation: (effect.preparation?.generation ?? 0) + 1 } }
    this.emit({ type: 'effect.retry_scheduled', effectId: effect.id, data: { previousAttemptId, nextAttemptId: effect.attemptId, delayMs, ...(error ? { error } : {}) } as unknown as JsonValue })
    this.clock.timers.schedule(effect.retryAt, () => {
      if (!effect.outcome && effect.state === 'retry_wait') {
        effect.state = 'queued'
        delete effect.retryAt
        this.emit({ type: 'effect.retry_ready', effectId: effect.id, data: effect.attemptId })
        this.dispatchQueuedEffects()
      }
    })
    return true
  }

  private dispatchQueuedEffects(): void {
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
      if (!this.outbox.claim(outboxEntry.id)) { this.releaseEffectLocks(effect.id); continue }
      effect.state = 'running'
      effect.executionState = 'running'
      const attempt: import('../core/types.js').AttemptRecord = { id: effect.attemptId, effectId: effect.id, executionState: 'running', sideEffectState: effect.sideEffectState, startedAt: this.state.now }
      effect.attempts = [...(effect.attempts ?? []), attempt]
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
      const promise = this.executor(effect, controller.signal).then((execution) => this.completeEffect(effect.id, execution)).catch((cause) => { const runtimeError = runtimeErrorFromCause(cause); this.emit({ type: 'effect.dispatch_failed', effectId: effect.id, data: runtimeError as unknown as JsonValue }); this.completeEffect(effect.id, { value: null, sideEffectState: 'none' }, 'failed', runtimeError) }).finally(() => { this.executions.delete(effect.id); this.refreshWaits() })
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
    effect.cancelRequested = { reason, at: this.state.now = this.clock.now() }
    execution.controller.abort()
    this.emit({ type: 'limit.rejected', effectId, data: { code: reason } })
    this.quarantineEffect(effectId, reason, effect.cancelGraceMs ?? 0)
    this.schedulePersistence()
  }

  private requestEffectCancellation(effectId: string, reason: string, graceMs: number): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    effect.cancelRequested = { reason, at: this.state.now }
    this.emit({ type: 'effect.cancel_requested', effectId, data: { reason } })
    if (!this.executions.has(effectId)) { this.completeEffect(effectId, { value: null }, 'cancelled', { code: 'CANCELLED', message: reason }); return }
    this.executions.get(effectId)!.controller.abort()
    if (graceMs === 0) this.quarantineEffect(effectId, reason, 0)
    else this.executions.get(effectId)!.cancelTimer = this.clock.schedule(graceMs, () => this.quarantineEffect(effectId, reason, 0))
  }

  private quarantineEffect(effectId: string, reason: string, _graceMs: number): void {
    const effect = this.state.effects.get(effectId)
    const execution = this.executions.get(effectId)
    if (!effect || effect.outcome) return
    if (execution) { execution.controller.abort(); this.executions.delete(effectId) }
    this.releaseEffectLocks(effectId)
    effect.executionState = 'remote_unknown'
    effect.sideEffectState = effect.sideEffectPolicy === 'write' ? 'unknown' : 'none'
    effect.state = effect.sideEffectState === 'unknown' ? 'reconcile_required' : 'cancelled'
    if (effect.state === 'cancelled') effect.outcome = { status: 'cancelled', error: { code: reason, message: reason } }
    this.quarantine.add(effectId, this.state.now, reason)
    const lane = this.state.lanes.get(effect.ownerLaneId)
    if (lane) lane.unresolvedEffectIds = [...new Set([...(lane.unresolvedEffectIds ?? []), effectId])]
    const quarantineEvent = this.emit({ type: 'effect.quarantined', effectId, data: { reason, state: effect.state } })
    this.journalEffect(effect, `effect:${effect.id}:${effect.attemptId}:quarantined`, undefined, [quarantineEvent])
    this.refreshWaits()
    this.schedulePersistence()
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

  private failLane(lane: LaneRecord, failure: RuntimeError): void { lane.status = 'failed'; lane.version++; this.emit({ type: 'lane.failed', laneId: lane.id, data: failure as unknown as JsonValue }); this.refreshWaits() }

  private refreshWaits(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const wait of this.state.waits.values()) {
        if (wait.state !== 'pending') continue
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
          this.cancelWaitDeadline(wait.id)
          wait.state = 'unsatisfied'; wait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error: unsatisfied ?? { code: 'WAIT_QUORUM_UNREACHABLE', message: 'Wait can no longer satisfy its quorum.' } }
          const lane = this.state.lanes.get(wait.laneId); if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'failed'; delete lane.activeWaitId; lane.version++ }
          changed = true
        } else if (modeUnsatisfied || (hardFailure && !pending)) {
          this.cancelWaitDeadline(wait.id)
          wait.state = 'unsatisfied'
          wait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error: unsatisfied ?? { code: 'WAIT_QUORUM_UNREACHABLE', message: 'Wait can no longer satisfy its quorum.' } }
          const lane = this.state.lanes.get(wait.laneId)
          if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'ready'; delete lane.activeWaitId; lane.pendingResumeInput = { type: 'wait', resolution: wait.resolution }; this.enqueueLane(lane.id) }
          changed = true
        } else if (modeSatisfied || (!pending && !unsatisfied && wait.spec.mode === 'all')) {
          this.cancelWaitDeadline(wait.id)
          wait.state = 'satisfied'; wait.resolution = { waitId: wait.id, status: 'satisfied', dependencies: observations }
          const lane = this.state.lanes.get(wait.laneId)
          if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) {
            delete lane.activeWaitId
            if (lane.closingResult) {
              const resultId = `result-${this.state.nextIds.result++}`
              this.state.results.set(resultId, { id: resultId, value: lane.closingResult.value, privacy: lane.closingResult.privacy, ...(lane.closingResult.privacyTaints === undefined ? {} : { privacyTaints: structuredClone(lane.closingResult.privacyTaints) }), derivedFrom: [...(lane.closingResult.derivedFrom ?? [])] })
              if (lane.visibleResultRefs) lane.visibleResultRefs.add(resultId)
              else lane.visibleResultRefs = new Set([resultId])
              lane.status = 'succeeded'; lane.resultRef = resultId; delete lane.closingResult
              this.emit({ type: 'lane.succeeded', laneId: lane.id, data: resultId })
            } else { lane.status = 'ready'; lane.pendingResumeInput = { type: 'wait', resolution: wait.resolution }; this.enqueueLane(lane.id) }
          }
          changed = true
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
    this.waitDeadlineTimers.delete(waitId)
    const wait = this.state.waits.get(waitId)
    if (!wait || wait.state !== 'pending') return
    const observations: Record<string, import('../core/types.js').DependencyObservation> = {}
    for (const dependency of wait.spec.dependencies) {
      const target = dependency.target as TargetRef
      const outcome = target.kind === 'lane' ? outcomeForSeriesMember(this.state, this.state.lanes.get(target.id)!, dependency.key) : this.state.effects.get(target.id)?.outcome
      observations[dependency.key] = outcome === undefined ? { state: 'pending', target } : outcome.status === 'cancelled' && wait.spec.onCancelled === 'ignore' ? { state: 'ignored', target, outcome } : { state: 'settled', target, outcome }
    }
    const error: RuntimeError = { code: 'WAIT_DEADLINE_EXCEEDED', message: 'Wait deadline exceeded.', details: { deadlineAt: wait.spec.deadlineAt ?? this.state.now } }
    wait.state = 'unsatisfied'
    wait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error }
    const lane = this.state.lanes.get(wait.laneId)
    if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) {
      delete lane.activeWaitId
      if (wait.spec.onUnsatisfied === 'fail_lane') { lane.status = 'failed'; lane.version++; this.emit({ type: 'lane.failed', laneId: lane.id, data: error as unknown as JsonValue }) }
      else { lane.status = 'ready'; lane.pendingResumeInput = { type: 'wait', resolution: wait.resolution }; this.enqueueLane(lane.id) }
    }
    this.emit({ type: 'wait.deadline_exceeded', laneId: wait.laneId, data: { waitId: wait.id, deadlineAt: wait.spec.deadlineAt ?? this.state.now } })
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
