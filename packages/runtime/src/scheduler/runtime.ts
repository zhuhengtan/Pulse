import { commitMutationTransaction, MutationLog } from '../storage/mutation-log.js'
import { createAgent } from '../core/factory.js'
import { validateStep } from '../transitions/validate.js'
import { PriorityInheritance, ReadyQueue, readyItemFromLane, VirtualClock } from './index.js'
import type { EffectRecord, JsonValue, LaneRecord, LaneStepOutput, Outcome, ResumeInput, RuntimeState, RuntimeError, TargetRef, WaitRecord } from '../core/types.js'
import { createRuntimeState } from '../core/types.js'
import { QuarantineScope } from '../lifecycle/scopes.js'
import { PulseSession } from '../dsl/session.js'
import { FactInbox } from '../core/inbox.js'
import { observeProgress } from '../lifecycle/watchdog.js'
import { EffectOutbox } from '../storage/outbox.js'
import { exportRuntimePersistence, importRuntimePersistence, type RuntimePersistenceBackend, type RuntimePersistenceSnapshot } from '../storage/persistence.js'
import { ResourceLockManager } from './locks.js'
import { appendRuntimeEvent } from '../core/events.js'
import type { Mutation } from '../core/mutations.js'
import { ContextMerger, type MergePlan } from '../context/merger.js'
import { historyPressure } from '../context/builder.js'

export interface LaneStepContext { lane: Readonly<LaneRecord>; state: Readonly<RuntimeState>; resumeInput?: ResumeInput; now: number }
export interface LaneProgram { id: string; version: string; step: (context: LaneStepContext) => LaneStepOutput; errorBoundary?: (error: RuntimeError, context: LaneStepContext) => LaneStepOutput }
export interface EffectExecution { value: JsonValue; summary?: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; sideEffectState?: 'none' | 'applied' | 'known' | 'unknown'; executionState?: 'succeeded' | 'failed' | 'remote_unknown'; status?: 'succeeded' | 'failed' | 'cancelled'; metadata?: JsonValue }
export type EffectExecutor = (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution>
type HostCommand = { type: 'reply'; effectId: string; value: JsonValue } | { type: 'cancel'; agentId: string; reason: string }

export interface RuntimeConfig {
  maxLaneStepsPerTick?: number
  agingIntervalMs?: number
  agingCap?: number
  maxTotalLanes?: number
  maxQueuedEffects?: number
  maxRunning?: Partial<Record<'llm' | 'tool' | 'agent' | 'none', number>>
  forkAffinity?: 'off' | 'advise'
  historySoftTokens?: number
  historyHardTokens?: number
  maxConsecutiveControlErrors?: number
  maxRuntimeMs?: number
  sessionId?: string
  maxAgentDepth?: number
  watchdogNoProgressThreshold?: number
  persistence?: RuntimePersistenceSnapshot
  effectExecutor?: EffectExecutor
}

export interface WarmStartSpec { agentId: string; globalVersion?: number | 'latest' }
export interface AgentCreateRequest { goal: string; program: LaneProgram; agentId?: string; maxActiveLanes?: number; warmStart?: WarmStartSpec; parentAgentId?: string }

function outcomeForLane(lane: LaneRecord): Outcome | undefined {
  if (lane.status === 'succeeded') return { status: 'succeeded', ...(lane.resultRef === undefined ? {} : { resultRef: lane.resultRef }) }
  if (lane.status === 'failed') return { status: 'failed' }
  if (lane.status === 'cancelled') return { status: 'cancelled' }
  return undefined
}

export class PulseRuntime {
  readonly state: RuntimeState
  readonly mutationLog: MutationLog
  readonly outbox: EffectOutbox
  readonly clock: VirtualClock
  readonly ready: ReadyQueue
  readonly quarantine = new QuarantineScope()
  readonly priorityInheritance = new PriorityInheritance()
  readonly resourceLocks = new ResourceLockManager()
  readonly factInbox = new FactInbox<HostCommand>()
  private readonly programs = new Map<string, LaneProgram>()
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void>; timeoutTimer?: string; deadlineTimer?: string; cancelTimer?: string }>()
  private readonly lockReleases = new Map<string, Array<() => void>>()
  private readonly lockBlocked = new Set<string>()
  private readonly executor: EffectExecutor
  private readonly customExecutor: boolean
  private enqueueSeq = 1
  private readonly maxSteps: number
  private readonly maxConsecutiveControlErrors: number
  private readonly maxRuntimeMs?: number
  private readonly watchdogNoProgressThreshold: number
  private readonly maxAgentDepth: number
  private readonly sessionId: string
  private hostCommandSeq = 1
  private factWaiters: Array<() => void> = []

  constructor(config: RuntimeConfig = {}) {
    const restored = config.persistence === undefined ? undefined : importRuntimePersistence(config.persistence)
    this.state = restored?.state ?? createRuntimeState(config.maxTotalLanes ?? 64, { ...(config.maxQueuedEffects === undefined ? {} : { maxQueuedEffects: config.maxQueuedEffects }), ...(config.maxRunning === undefined ? {} : { maxRunning: config.maxRunning }), ...(config.forkAffinity === undefined ? {} : { forkAffinity: config.forkAffinity }), ...(config.historySoftTokens === undefined ? {} : { historySoftTokens: config.historySoftTokens }), ...(config.historyHardTokens === undefined ? {} : { historyHardTokens: config.historyHardTokens }) })
    this.sessionId = config.sessionId ?? 'session-local'
    this.mutationLog = restored?.mutationLog ?? new MutationLog()
    this.outbox = restored?.outbox ?? new EffectOutbox()
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
        if (effect.state === 'running' && outboxEntry?.state === 'pending') {
          if (effect.sideEffectPolicy === 'write') { effect.state = 'reconcile_required'; effect.executionState = 'remote_unknown'; effect.sideEffectState = 'unknown'; this.quarantine.add(effect.id, this.state.now, 'recovery_in_doubt') }
          else { effect.state = 'queued'; effect.executionState = 'local' }
        }
        if (effect.state === 'retry_wait' && effect.retryAt !== undefined) this.clock.timers.schedule(effect.retryAt, () => { if (!effect.outcome && effect.state === 'retry_wait') { effect.state = 'queued'; delete effect.retryAt; this.dispatchQueuedEffects() } })
      }
    }
    this.maxSteps = config.maxLaneStepsPerTick ?? 32
    this.maxConsecutiveControlErrors = config.maxConsecutiveControlErrors ?? 2
    if (config.maxRuntimeMs !== undefined) this.maxRuntimeMs = config.maxRuntimeMs
    this.watchdogNoProgressThreshold = config.watchdogNoProgressThreshold ?? 3
    this.maxAgentDepth = config.maxAgentDepth ?? 1
    this.customExecutor = config.effectExecutor !== undefined
    this.executor = config.effectExecutor ?? (async () => ({ value: null }))
  }

  register(program: LaneProgram): void { this.programs.set(`${program.id}@${program.version}`, program) }
  createAgent(request: AgentCreateRequest): { agentId: string; laneId: string }
  createAgent(goal: string, program: LaneProgram, agentId?: string): { agentId: string; laneId: string }
  createAgent(goalOrRequest: string | AgentCreateRequest, program?: LaneProgram, agentId?: string): { agentId: string; laneId: string } {
    const request: AgentCreateRequest = typeof goalOrRequest === 'string' ? { goal: goalOrRequest, program: program!, ...(agentId === undefined ? {} : { agentId }) } : goalOrRequest
    const warmStart = request.warmStart
    let initialGlobal: JsonValue | undefined
    if (warmStart) {
      const source = this.state.agents.get(warmStart.agentId)
      if (!source) throw new Error(`WARM_START_SOURCE_NOT_FOUND:${warmStart.agentId}`)
      const version = warmStart.globalVersion === 'latest' || warmStart.globalVersion === undefined ? source.latestGlobalVersion : warmStart.globalVersion
      const value = source.globalVersions.get(version)
      if (value === undefined) throw new Error(`WARM_START_VERSION_NOT_FOUND:${version}`)
      initialGlobal = structuredClone(value)
    }
    this.register(request.program)
    if (this.state.lanes.size >= this.state.maxTotalLanes) throw new Error('MAX_TOTAL_LANES')
    const parent = request.parentAgentId === undefined ? undefined : this.state.agents.get(request.parentAgentId)
    if (request.parentAgentId !== undefined && !parent) throw new Error(`PARENT_AGENT_NOT_FOUND:${request.parentAgentId}`)
    const { agent, root } = createAgent(this.state, request.goal, { programId: request.program.id, programVersion: request.program.version, step: (request.program as LaneProgram & { entry?: string }).entry ?? 'start', locals: {} }, { ...(request.agentId === undefined ? {} : { agentId: request.agentId }), ...(initialGlobal === undefined ? {} : { initialGlobal }), ...(request.parentAgentId === undefined ? {} : { parentAgentId: request.parentAgentId, depth: (parent?.depth ?? 0) + 1 }) })
    root.enqueueSeq = this.enqueueSeq++
    agent.state = 'running'
    this.ready.enqueue(readyItemFromLane(root))
    return { agentId: agent.id, laneId: root.id }
  }
  start(agentId: string): PulseSession { if (!this.state.agents.has(agentId)) throw new Error(`UNKNOWN_AGENT:${agentId}`); return new PulseSession(this, agentId) }
  exportPersistence(): RuntimePersistenceSnapshot { return exportRuntimePersistence(this.state, this.mutationLog, this.outbox) }
  async persist(backend: RuntimePersistenceBackend): Promise<void> { await backend.save(this.exportPersistence()) }
  mergeProposals(agentId: string, proposalIds?: string[]): MergePlan {
    const plan = new ContextMerger(this.state).plan(agentId, proposalIds)
    if (plan.conflicts.length || plan.mutations.length === 0) return plan
    commitMutationTransaction(this.state, this.mutationLog, `context-merge:${agentId}:${plan.version ?? this.state.now}`, plan.mutations, this.state.now, this.sessionId)
    return plan
  }

  private emit(event: import('../core/types.js').RuntimeEventInput): import('../core/types.js').RuntimeEvent { return appendRuntimeEvent(this.state, event, { sessionId: this.sessionId, timestamp: this.state.now }) }
  private journalEffect(effect: EffectRecord, transactionId: string, result?: import('../core/types.js').ResultRecord, events: import('../core/types.js').RuntimeEvent[] = []): void {
    const mutations: Mutation[] = [{ op: 'setEffect', effectId: effect.id, record: structuredClone(effect) }]
    if (result) mutations.push({ op: 'publishResult', record: structuredClone(result) })
    for (const event of events) { const { seq: _seq, ...input } = event; mutations.push({ op: 'appendEvent', event: input }) }
    this.mutationLog.append(transactionId, mutations, this.state.now)
  }

  enqueueHostCommand(command: HostCommand): void {
    this.factInbox.enqueue(command, `host-command-${this.hostCommandSeq++}`)
    for (const resolve of this.factWaiters.splice(0)) resolve()
  }

  enqueueLane(laneId: string): void { const lane = this.state.lanes.get(laneId); if (lane && lane.status === 'ready') { lane.enqueueSeq = this.enqueueSeq++; lane.readySince = this.state.now; this.ready.enqueue(readyItemFromLane(lane)) } }

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
      const stepContext: LaneStepContext = { lane: structuredClone(lane), state: structuredClone(this.state), ...(lane.pendingResumeInput ? { resumeInput: structuredClone(lane.pendingResumeInput) } : {}), now: this.state.now }
      try { output = program.step(stepContext) }
      catch (cause) {
        const failure: RuntimeError = { code: 'STEP_FAILED', message: cause instanceof Error ? cause.message : String(cause) }
        if (!program.errorBoundary) { this.failLane(lane, failure); continue }
        try { output = program.errorBoundary(failure, stepContext) }
        catch (boundaryCause) { this.failLane(lane, { code: 'ERROR_BOUNDARY_FAILED', message: boundaryCause instanceof Error ? boundaryCause.message : String(boundaryCause) }); continue }
      }
      const result = validateStep(this.state, lane.id, output)
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
        commitMutationTransaction(this.state, this.mutationLog, `step:${lane.id}:${lane.version + 1}`, result.mutations, this.state.now, this.sessionId)
        for (const mutation of result.mutations) if (mutation.op === 'insertEffect') this.outbox.enqueue(mutation.record, this.state.now)
        const updated = this.state.lanes.get(lane.id)
        if (updated) delete updated.consecutiveControlErrors
        if (updated && updated.pendingResumeInput) delete updated.pendingResumeInput
        if (updated) {
          const watchdog = observeProgress(lane, output, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold })
          updated.progressWatchdog = watchdog.state
          if (!watchdog.progressed) this.emit({ type: watchdog.state.interventionLevel >= 3 ? 'progress.no_progress_detected' : 'progress.intervention_applied', laneId: lane.id, data: { noProgressCount: watchdog.state.noProgressCount, interventionLevel: watchdog.state.interventionLevel } })
          if (watchdog.state.interventionLevel >= 3 && !['succeeded', 'failed', 'cancelled'].includes(updated.status)) this.failLane(updated, { code: 'NO_PROGRESS_DETECTED', message: 'Lane made no observable progress within the watchdog threshold.' })
        }
        if (updated?.status === 'ready') this.enqueueLane(updated.id)
        this.enqueueNewReadyLanes()
        this.refreshWaits()
        this.propagateCancelledLanes()
      }
      this.dispatchQueuedEffects()
      progressed++
    }
    this.completeFinishedChildAgents()
    return progressed
  }

  async run(maxTicks = 10_000): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> {
    for (let tick = 0; tick < maxTicks; tick++) {
      const work = this.tick()
      this.refreshWaits()
      if (this.ready.size === 0 && this.executions.size === 0) {
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
    return { status, unresolvedEffectIds: this.quarantine.unresolvedEffectIds }
  }

  async waitForIdle(): Promise<void> { while (this.ready.size || this.executions.size) { this.tick(); if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise)) } }

  private hasPendingHostInteraction(): boolean { return [...this.state.effects.values()].some((effect) => effect.kind === 'human' && !effect.outcome) }
  private waitForFact(): Promise<void> { return new Promise((resolve) => this.factWaiters.push(resolve)) }
  private completeFinishedChildAgents(): void {
    for (const effect of this.state.effects.values()) {
      if (effect.kind !== 'agent' || !effect.childAgentId || effect.outcome) continue
      const child = this.state.agents.get(effect.childAgentId)
      const root = child ? this.state.lanes.get(child.rootLaneId) : undefined
      if (!child || !root || !['succeeded', 'failed', 'cancelled'].includes(root.status)) continue
      const status = root.status === 'succeeded' ? 'succeeded' : root.status === 'cancelled' ? 'cancelled' : 'failed'
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
    const effectiveStatus = effect.cancelRequested && (execution.status ?? status) === 'succeeded' ? 'cancelled' : (execution.status ?? status)
    effect.state = effectiveStatus
    effect.executionState = effectiveStatus === 'succeeded' ? 'succeeded' : effectiveStatus === 'cancelled' ? 'failed' : 'failed'
    effect.sideEffectState = execution.sideEffectState ?? 'none'
    const attempt = effect.attempts?.at(-1)
    if (attempt) { attempt.executionState = effect.executionState; attempt.sideEffectState = effect.sideEffectState; attempt.settledAt = this.state.now; if (error) attempt.error = error }
    const settledAttemptId = effect.attemptId
    if (effectiveStatus === 'failed' && this.scheduleRetry(effect, error)) {
      this.releaseEffectLocks(effectId)
      this.outbox.ack(`${effect.id}:${settledAttemptId}`)
      this.refreshWaits()
      return
    }
    const resultId = `result-${this.state.nextIds.result++}`
    const outcome: Outcome = effectiveStatus === 'succeeded' ? { status: effectiveStatus, resultRef: resultId } : { status: effectiveStatus, ...(error ? { error } : {}) }
    effect.outcome = outcome
    this.releaseEffectLocks(effectId)
    this.outbox.ack(`${effect.id}:${effect.attemptId}`)
    const result = effectiveStatus === 'succeeded' ? { id: resultId, effectId, value: execution.value, privacy: execution.privacy ?? 'public', derivedFrom: [], ...(execution.summary === undefined ? {} : { summary: execution.summary }) } : undefined
    if (result) this.state.results.set(resultId, result)
    const settledEvent = this.emit({ type: 'effect.settled', effectId, data: outcome as unknown as JsonValue })
    const metadataEvent = execution.metadata === undefined ? undefined : this.emit({ type: 'effect.execution_metadata', effectId, data: execution.metadata })
    this.journalEffect(effect, `effect:${effect.id}:${settledAttemptId}:settled`, result, [settledEvent, ...(metadataEvent ? [metadataEvent] : [])])
    this.refreshWaits()
    this.dispatchQueuedEffects()
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
        this.releaseEffectLocks(effectId)
        this.outbox.ack(`${effect.id}:${settledAttemptId}`)
        this.refreshWaits()
        return
      }
      effect.state = 'failed'
      effect.outcome = { status: 'failed', error: { code: 'REMOTE_UNKNOWN', message: 'Remote execution outcome is unknown but no side effect was recorded.' } }
      this.emit({ type: 'effect.remote_unknown', effectId, data: { executionState: 'remote_unknown', sideEffectState } })
      this.releaseEffectLocks(effectId)
    }
    if (sideEffectState !== 'unknown') this.releaseEffectLocks(effectId)
    this.refreshWaits()
  }

  reconcileEffect(effectId: string, value: JsonValue, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return
    this.quarantine.reconcile(effectId)
    this.completeEffect(effectId, { value, sideEffectState: 'known' }, status)
  }

  abandonEffect(effectId: string): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.state !== 'reconcile_required') return
    if (!this.quarantine.abandon(effectId)) return
    effect.state = 'failed'
    effect.executionState = 'local_closed'
    effect.sideEffectState = 'unknown'
    effect.outcome = { status: 'failed', error: { code: 'RESOURCE_ABANDONED', message: 'Host abandoned reconciliation for an unknown side effect.' } }
    if (effect.sideEffectState !== 'unknown') this.releaseEffectLocks(effectId)
    const lane = this.state.lanes.get(effect.ownerLaneId)
    if (lane?.unresolvedEffectIds) lane.unresolvedEffectIds = lane.unresolvedEffectIds.filter((id) => id !== effectId)
    this.emit({ type: 'resource.abandoned', effectId, data: { code: 'RESOURCE_ABANDONED' } })
    this.refreshWaits()
  }

  cancelEffect(effectId: string, graceMs = 0): void {
    this.requestEffectCancellation(effectId, 'USER_REQUESTED', graceMs)
  }

  cancelAgent(agentId: string, reason: 'USER_REQUESTED' | 'SUPERSEDED' | 'POLICY' | 'TIMEOUT' = 'USER_REQUESTED'): void {
    const agent = this.state.agents.get(agentId)
    if (!agent || ['succeeded', 'failed', 'cancelled'].includes(agent.state ?? '')) return
    agent.state = 'cancelling'
    for (const lane of this.state.lanes.values()) if (lane.agentId === agentId && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'cancelled'; lane.version++; this.emit({ type: 'lane.cancelling', laneId: lane.id, data: reason }); for (const effectId of lane.ownedEffectIds) { const childAgentId = this.state.effects.get(effectId)?.childAgentId; if (childAgentId) this.cancelAgent(childAgentId, reason); this.requestEffectCancellation(effectId, reason, this.state.effects.get(effectId)?.cancelGraceMs ?? 0) } }
    agent.state = 'cancelled'
    this.emit({ type: 'agent.cancelled', data: reason })
  }

  explain(laneId?: string): JsonValue {
    const lanes = [...this.state.lanes.values()].filter((lane) => laneId === undefined || lane.id === laneId).map((lane) => ({ id: lane.id, agentId: lane.agentId, status: lane.status, goal: lane.goal, basePriority: lane.priority, effectivePriority: this.ready.snapshot(this.state.now).find((item) => item.laneId === lane.id)?.effectivePriority ?? lane.priority, activeWaitId: lane.activeWaitId ?? null, consecutiveControlErrors: lane.consecutiveControlErrors ?? 0, unresolvedEffectIds: lane.unresolvedEffectIds ?? [] }))
    const effects = [...this.state.effects.values()].filter((effect) => laneId === undefined || effect.ownerLaneId === laneId).map((effect) => ({ id: effect.id, state: effect.state, executionState: effect.executionState, sideEffectState: effect.sideEffectState, attemptId: effect.attemptId, inheritedFloor: effect.inheritedFloor ?? null, deadlineAt: effect.deadlineAt ?? null }))
    return { now: this.state.now, lanes, effects, quarantine: this.quarantine.unresolvedEffectIds }
  }

  retryEffect(effectId: string, delayMs: number): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    this.scheduleRetry(effect, undefined, delayMs)
  }

  private scheduleRetry(effect: EffectRecord, error?: RuntimeError, forcedDelayMs?: number): boolean {
    if (effect.cancelRequested || (!forcedDelayMs && !effect.retryPolicy)) return false
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
      if (effect.concurrencyClass !== 'none' && this.runningCount(effect.concurrencyClass) >= this.state.maxRunning[effect.concurrencyClass]) continue
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
        const child = this.createAgent({ goal, program: childProgram, parentAgentId: effect.agentId })
        effect.childAgentId = child.agentId
        this.emit({ type: 'agent.effect_started', effectId: effect.id, data: child.agentId })
        continue
      }
      const promise = this.executor(effect, controller.signal).then((execution) => this.completeEffect(effect.id, execution)).catch((cause) => { this.emit({ type: 'effect.dispatch_failed', effectId: effect.id, data: { message: cause instanceof Error ? cause.message : String(cause) } }); this.completeEffect(effect.id, { value: null, sideEffectState: 'none' }, 'failed', { code: 'EFFECT_FAILED', message: cause instanceof Error ? cause.message : String(cause) }) }).finally(() => { this.executions.delete(effect.id); this.refreshWaits() })
      executionRecord.promise = promise
      if (effect.attemptTimeoutMs !== undefined) executionRecord.timeoutTimer = this.clock.schedule(effect.attemptTimeoutMs, () => this.expireEffect(effect.id, 'ATTEMPT_TIMEOUT'))
      if (effect.deadlineAt !== undefined) executionRecord.deadlineTimer = this.clock.timers.schedule(effect.deadlineAt, () => this.expireEffect(effect.id, 'TIMEOUT'))
      this.executions.set(effect.id, executionRecord)
    }
  }

  private expireEffect(effectId: string, reason: 'ATTEMPT_TIMEOUT' | 'TIMEOUT'): void {
    const effect = this.state.effects.get(effectId)
    const execution = this.executions.get(effectId)
    if (!effect || effect.outcome || !execution) return
    effect.cancelRequested = { reason, at: this.state.now = this.clock.now() }
    execution.controller.abort()
    this.emit({ type: 'limit.rejected', effectId, data: { code: reason } })
    this.quarantineEffect(effectId, reason, effect.cancelGraceMs ?? 0)
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
    this.emit({ type: 'effect.quarantined', effectId, data: { reason, state: effect.state } })
    this.refreshWaits()
  }

  private propagateCancelledLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'cancelled') for (const effectId of lane.ownedEffectIds) this.requestEffectCancellation(effectId, 'LANE_CANCELLED', this.state.effects.get(effectId)?.cancelGraceMs ?? 0)
  }

  private runningCount(concurrencyClass: import('../core/types.js').ConcurrencyClass): number { return [...this.state.effects.values()].filter((effect) => effect.concurrencyClass === concurrencyClass && effect.state === 'running').length }

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
        for (const dependency of wait.spec.dependencies) {
          const target = dependency.target as TargetRef
          const outcome = target.kind === 'lane' ? outcomeForLane(this.state.lanes.get(target.id)!) : this.state.effects.get(target.id)?.outcome
          if (!outcome) { observations[dependency.key] = { state: 'pending', target }; pending = true; continue }
          if (outcome.status === 'cancelled' && wait.spec.onCancelled === 'ignore') observations[dependency.key] = { state: 'ignored', target, outcome }
          else if (dependency.condition === 'success' && outcome.status !== 'succeeded') { observations[dependency.key] = { state: 'settled', target, outcome }; unsatisfied = { code: 'DEPENDENCY_FAILED', message: `${dependency.key} did not succeed` } }
          else observations[dependency.key] = { state: 'settled', target, outcome }
        }
        if (unsatisfied && wait.spec.onUnsatisfied === 'fail_lane') {
          wait.state = 'unsatisfied'; wait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error: unsatisfied }
          const lane = this.state.lanes.get(wait.laneId); if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'failed'; delete lane.activeWaitId; lane.version++ }
          changed = true
        } else if (unsatisfied && !pending) {
          wait.state = 'unsatisfied'
          wait.resolution = { waitId: wait.id, status: 'unsatisfied', dependencies: observations, error: unsatisfied }
          const lane = this.state.lanes.get(wait.laneId)
          if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'ready'; delete lane.activeWaitId; lane.pendingResumeInput = { type: 'wait', resolution: wait.resolution }; this.enqueueLane(lane.id) }
          changed = true
        } else if (!pending && !unsatisfied) {
          wait.state = 'satisfied'; wait.resolution = { waitId: wait.id, status: 'satisfied', dependencies: observations }
          const lane = this.state.lanes.get(wait.laneId)
          if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) {
            delete lane.activeWaitId
            if (lane.closingResult) {
              const resultId = `result-${this.state.nextIds.result++}`
              this.state.results.set(resultId, { id: resultId, value: lane.closingResult.value, privacy: lane.closingResult.privacy, derivedFrom: [] })
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

  private recomputePriorityInheritance(): void {
    this.priorityInheritance.clear()
    for (const effect of this.state.effects.values()) delete effect.inheritedFloor
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
          }
        }
      }
    }
  }
}
