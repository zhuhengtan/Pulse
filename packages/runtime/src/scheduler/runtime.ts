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
import { exportRuntimePersistence, importRuntimePersistence, type RuntimePersistenceSnapshot } from '../storage/persistence.js'

export interface LaneStepContext { lane: Readonly<LaneRecord>; state: Readonly<RuntimeState>; resumeInput?: ResumeInput; now: number }
export interface LaneProgram { id: string; version: string; step: (context: LaneStepContext) => LaneStepOutput }
export interface EffectExecution { value: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; sideEffectState?: 'none' | 'applied' | 'known' | 'unknown'; executionState?: 'succeeded' | 'failed' | 'remote_unknown'; status?: 'succeeded' | 'failed' | 'cancelled' }
export type EffectExecutor = (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution>
type HostCommand = { type: 'reply'; effectId: string; value: JsonValue } | { type: 'cancel'; agentId: string; reason: string }

export interface RuntimeConfig {
  maxLaneStepsPerTick?: number
  agingIntervalMs?: number
  agingCap?: number
  maxTotalLanes?: number
  maxQueuedEffects?: number
  maxRunning?: Partial<Record<'llm' | 'tool' | 'agent' | 'none', number>>
  maxConsecutiveControlErrors?: number
  maxRuntimeMs?: number
  watchdogNoProgressThreshold?: number
  persistence?: RuntimePersistenceSnapshot
  effectExecutor?: EffectExecutor
}

function outcomeForLane(lane: LaneRecord): Outcome | undefined {
  if (lane.status === 'succeeded') return { status: 'succeeded' }
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
  readonly factInbox = new FactInbox<HostCommand>()
  private readonly programs = new Map<string, LaneProgram>()
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void>; timeoutTimer?: string; deadlineTimer?: string; cancelTimer?: string }>()
  private readonly executor: EffectExecutor
  private readonly customExecutor: boolean
  private enqueueSeq = 1
  private readonly maxSteps: number
  private readonly maxConsecutiveControlErrors: number
  private readonly maxRuntimeMs?: number
  private readonly watchdogNoProgressThreshold: number
  private hostCommandSeq = 1
  private factWaiters: Array<() => void> = []

  constructor(config: RuntimeConfig = {}) {
    const restored = config.persistence === undefined ? undefined : importRuntimePersistence(config.persistence)
    this.state = restored?.state ?? createRuntimeState(config.maxTotalLanes ?? 64, { ...(config.maxQueuedEffects === undefined ? {} : { maxQueuedEffects: config.maxQueuedEffects }), ...(config.maxRunning === undefined ? {} : { maxRunning: config.maxRunning }) })
    this.mutationLog = restored?.mutationLog ?? new MutationLog()
    this.outbox = restored?.outbox ?? new EffectOutbox()
    if (restored) {
      const recovery = this.outbox.recover(this.state)
      for (const id of recovery.requeued) this.state.events.push({ seq: this.state.nextIds.event++, type: 'outbox.requeued', data: id })
      for (const id of recovery.unknown) this.state.events.push({ seq: this.state.nextIds.event++, type: 'outbox.discarded', data: id })
    }
    this.clock = new VirtualClock()
    this.ready = new ReadyQueue(config.agingIntervalMs ?? 1000, config.agingCap ?? Number.POSITIVE_INFINITY)
    this.maxSteps = config.maxLaneStepsPerTick ?? 32
    this.maxConsecutiveControlErrors = config.maxConsecutiveControlErrors ?? 2
    if (config.maxRuntimeMs !== undefined) this.maxRuntimeMs = config.maxRuntimeMs
    this.watchdogNoProgressThreshold = config.watchdogNoProgressThreshold ?? 3
    this.customExecutor = config.effectExecutor !== undefined
    this.executor = config.effectExecutor ?? (async () => ({ value: null }))
  }

  register(program: LaneProgram): void { this.programs.set(`${program.id}@${program.version}`, program) }
  createAgent(goal: string, program: LaneProgram, agentId?: string): { agentId: string; laneId: string } {
    this.register(program)
    const { agent, root } = createAgent(this.state, goal, { programId: program.id, programVersion: program.version, step: (program as LaneProgram & { entry?: string }).entry ?? 'start', locals: {} }, agentId === undefined ? {} : { agentId })
    root.enqueueSeq = this.enqueueSeq++
    agent.state = 'running'
    this.ready.enqueue(readyItemFromLane(root))
    return { agentId: agent.id, laneId: root.id }
  }
  start(agentId: string): PulseSession { if (!this.state.agents.has(agentId)) throw new Error(`UNKNOWN_AGENT:${agentId}`); return new PulseSession(this, agentId) }
  exportPersistence(): RuntimePersistenceSnapshot { return exportRuntimePersistence(this.state, this.mutationLog, this.outbox) }

  enqueueHostCommand(command: HostCommand): void {
    this.factInbox.enqueue(command, `host-command-${this.hostCommandSeq++}`)
    for (const resolve of this.factWaiters.splice(0)) resolve()
  }

  enqueueLane(laneId: string): void { const lane = this.state.lanes.get(laneId); if (lane && lane.status === 'ready') { lane.enqueueSeq = this.enqueueSeq++; lane.readySince = this.state.now; this.ready.enqueue(readyItemFromLane(lane)) } }

  tick(): number {
    this.state.now = this.clock.now()
    for (const envelope of this.factInbox.drain()) {
      this.state.events.push({ seq: this.state.nextIds.event++, id: envelope.eventId, type: 'command.enqueued', data: envelope.fact as unknown as JsonValue })
      if (envelope.fact.type === 'reply') this.completeEffect(envelope.fact.effectId, { value: envelope.fact.value })
      else this.cancelAgent(envelope.fact.agentId, 'USER_REQUESTED')
      this.state.events.push({ seq: this.state.nextIds.event++, type: 'command.applied', data: { eventId: envelope.eventId } })
    }
    if (this.maxRuntimeMs !== undefined && this.state.now >= this.maxRuntimeMs) for (const agent of this.state.agents.values()) if (agent.state === 'running') this.cancelAgent(agent.id, 'TIMEOUT')
    for (const timer of this.clock.timers.due(this.state.now)) timer.callback()
    let progressed = 0
    while (progressed < this.maxSteps) {
      const laneId = this.ready.dequeue(this.state.now)
      if (!laneId) break
      const lane = this.state.lanes.get(laneId)
      if (!lane || lane.status !== 'ready') continue
      const program = this.programs.get(`${lane.resume.programId}@${lane.resume.programVersion}`)
      if (!program) { this.failLane(lane, { code: 'PROGRAM_NOT_REGISTERED', message: `${lane.resume.programId}@${lane.resume.programVersion}` }); continue }
      let output: LaneStepOutput
      try { output = program.step({ lane: structuredClone(lane), state: structuredClone(this.state), ...(lane.pendingResumeInput ? { resumeInput: structuredClone(lane.pendingResumeInput) } : {}), now: this.state.now }) }
      catch (cause) { this.failLane(lane, { code: 'STEP_FAILED', message: cause instanceof Error ? cause.message : String(cause) }); continue }
      const result = validateStep(this.state, lane.id, output)
      if ('rejection' in result) {
        const consecutive = (lane.consecutiveControlErrors ?? 0) + 1
        lane.consecutiveControlErrors = consecutive
        if (consecutive >= this.maxConsecutiveControlErrors) this.failLane(lane, { code: 'CONTROL_ERROR_LOOP', message: 'Lane exceeded the consecutive control error limit.', details: { lastError: result.rejection as unknown as JsonValue } })
        else {
          lane.pendingResumeInput = { type: 'control_error', error: result.rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
          this.state.events.push({ seq: this.state.nextIds.event++, type: 'step.rejected', laneId: lane.id, data: result.rejection as unknown as JsonValue })
          this.enqueueLane(lane.id)
        }
      } else {
        commitMutationTransaction(this.state, this.mutationLog, `step:${lane.id}:${lane.version + 1}`, result.mutations, this.state.now)
        for (const mutation of result.mutations) if (mutation.op === 'insertEffect') this.outbox.enqueue(mutation.record, this.state.now)
        const updated = this.state.lanes.get(lane.id)
        if (updated) delete updated.consecutiveControlErrors
        if (updated && updated.pendingResumeInput) delete updated.pendingResumeInput
        if (updated) {
          const watchdog = observeProgress(lane, output, this.state, lane.progressWatchdog, { noProgressThreshold: this.watchdogNoProgressThreshold })
          updated.progressWatchdog = watchdog.state
          if (!watchdog.progressed) this.state.events.push({ seq: this.state.nextIds.event++, type: watchdog.state.interventionLevel >= 3 ? 'progress.no_progress_detected' : 'progress.intervention_applied', laneId: lane.id, data: { noProgressCount: watchdog.state.noProgressCount, interventionLevel: watchdog.state.interventionLevel } })
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
    return progressed
  }

  async run(maxTicks = 10_000): Promise<{ status: 'succeeded' | 'failed' | 'cancelled'; unresolvedEffectIds: string[] }> {
    for (let tick = 0; tick < maxTicks; tick++) {
      const work = this.tick()
      this.refreshWaits()
      if (this.ready.size === 0 && this.executions.size === 0) {
        if (this.factInbox.size > 0) continue
        if (this.hasPendingHostInteraction()) { await this.waitForFact(); continue }
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
    if (root && !['succeeded', 'failed', 'cancelled'].includes(root.status)) this.state.events.push({ seq: this.state.nextIds.event++, type: 'runtime.idle_blocked', laneId: root.id, data: { status: root.status } })
    const agent = root ? this.state.agents.get(root.agentId) : undefined
    if (agent && ['succeeded', 'failed', 'cancelled'].includes(root?.status ?? 'failed')) agent.state = status
    return { status, unresolvedEffectIds: this.quarantine.unresolvedEffectIds }
  }

  async waitForIdle(): Promise<void> { while (this.ready.size || this.executions.size) { this.tick(); if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise)) } }

  private hasPendingHostInteraction(): boolean { return [...this.state.effects.values()].some((effect) => effect.kind === 'human' && !effect.outcome) }
  private waitForFact(): Promise<void> { return new Promise((resolve) => this.factWaiters.push(resolve)) }

  completeEffect(effectId: string, execution: EffectExecution, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', error?: RuntimeError): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    const running = this.executions.get(effectId)
    if (running) { running.controller.abort(); this.executions.delete(effectId) }
    if (execution.executionState === 'remote_unknown') { this.markRemoteUnknown(effectId, execution.sideEffectState ?? 'none'); return }
    const effectiveStatus = effect.cancelRequested && (execution.status ?? status) === 'succeeded' ? 'cancelled' : (execution.status ?? status)
    effect.state = effectiveStatus
    effect.executionState = effectiveStatus === 'succeeded' ? 'succeeded' : effectiveStatus === 'cancelled' ? 'failed' : 'failed'
    effect.sideEffectState = execution.sideEffectState ?? 'none'
    const resultId = `result-${this.state.nextIds.result++}`
    const outcome: Outcome = effectiveStatus === 'succeeded' ? { status: effectiveStatus, resultRef: resultId } : { status: effectiveStatus, ...(error ? { error } : {}) }
    effect.outcome = outcome
    this.outbox.ack(`${effect.id}:${effect.attemptId}`)
    const attempt = effect.attempts?.at(-1)
    if (attempt) { attempt.executionState = effect.executionState; attempt.sideEffectState = effect.sideEffectState; attempt.settledAt = this.state.now; if (error) attempt.error = error }
    if (effectiveStatus === 'succeeded') this.state.results.set(resultId, { id: resultId, effectId, value: execution.value, privacy: execution.privacy ?? 'public', derivedFrom: [] })
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'effect.settled', effectId, data: outcome as unknown as JsonValue })
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
      effect.state = 'failed'
      effect.outcome = { status: 'failed', error: { code: 'REMOTE_UNKNOWN', message: 'Remote execution outcome is unknown but no side effect was recorded.' } }
      this.state.events.push({ seq: this.state.nextIds.event++, type: 'effect.remote_unknown', effectId, data: { executionState: 'remote_unknown', sideEffectState } })
    }
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
    const lane = this.state.lanes.get(effect.ownerLaneId)
    if (lane?.unresolvedEffectIds) lane.unresolvedEffectIds = lane.unresolvedEffectIds.filter((id) => id !== effectId)
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'resource.abandoned', effectId, data: { code: 'RESOURCE_ABANDONED' } })
    this.refreshWaits()
  }

  cancelEffect(effectId: string, graceMs = 0): void {
    this.requestEffectCancellation(effectId, 'USER_REQUESTED', graceMs)
  }

  cancelAgent(agentId: string, reason: 'USER_REQUESTED' | 'SUPERSEDED' | 'POLICY' | 'TIMEOUT' = 'USER_REQUESTED'): void {
    const agent = this.state.agents.get(agentId)
    if (!agent || ['succeeded', 'failed', 'cancelled'].includes(agent.state ?? '')) return
    agent.state = 'cancelling'
    for (const lane of this.state.lanes.values()) if (lane.agentId === agentId && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'cancelled'; lane.version++; this.state.events.push({ seq: this.state.nextIds.event++, type: 'lane.cancelling', laneId: lane.id, data: reason }); for (const effectId of lane.ownedEffectIds) this.requestEffectCancellation(effectId, reason, this.state.effects.get(effectId)?.cancelGraceMs ?? 0) }
    agent.state = 'cancelled'
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'agent.cancelled', data: reason })
  }

  explain(laneId?: string): JsonValue {
    const lanes = [...this.state.lanes.values()].filter((lane) => laneId === undefined || lane.id === laneId).map((lane) => ({ id: lane.id, agentId: lane.agentId, status: lane.status, goal: lane.goal, basePriority: lane.priority, effectivePriority: this.ready.snapshot(this.state.now).find((item) => item.laneId === lane.id)?.effectivePriority ?? lane.priority, activeWaitId: lane.activeWaitId ?? null, consecutiveControlErrors: lane.consecutiveControlErrors ?? 0, unresolvedEffectIds: lane.unresolvedEffectIds ?? [] }))
    const effects = [...this.state.effects.values()].filter((effect) => laneId === undefined || effect.ownerLaneId === laneId).map((effect) => ({ id: effect.id, state: effect.state, executionState: effect.executionState, sideEffectState: effect.sideEffectState, attemptId: effect.attemptId, inheritedFloor: effect.inheritedFloor ?? null, deadlineAt: effect.deadlineAt ?? null }))
    return { now: this.state.now, lanes, effects, quarantine: this.quarantine.unresolvedEffectIds }
  }

  retryEffect(effectId: string, delayMs: number): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    effect.state = 'retry_wait'
    effect.attemptNo += 1
    effect.attemptId = `${effect.id}-attempt-${effect.attemptNo}`
    effect.executionState = 'local'
    effect.retryAt = this.state.now + delayMs
    this.clock.timers.schedule(effect.retryAt, () => { if (!effect.outcome) { effect.state = 'queued'; delete effect.retryAt; this.dispatchQueuedEffects() } })
  }

  private dispatchQueuedEffects(): void {
    const queued = [...this.state.effects.values()].filter((effect) => effect.state === 'queued' && !this.executions.has(effect.id)).sort((a, b) => (Math.max(a.schedulePriority ?? 0, a.inheritedFloor ?? Number.NEGATIVE_INFINITY) - Math.max(b.schedulePriority ?? 0, b.inheritedFloor ?? Number.NEGATIVE_INFINITY)) || a.id.localeCompare(b.id))
    for (const effect of queued) {
      if (effect.state !== 'queued' || this.executions.has(effect.id)) continue
      if (effect.concurrencyClass !== 'none' && this.runningCount(effect.concurrencyClass) >= this.state.maxRunning[effect.concurrencyClass]) continue
      const outboxEntry = this.outbox.enqueue(effect, this.state.now)
      if (outboxEntry.state === 'claimed' || !this.outbox.claim(outboxEntry.id)) continue
      effect.state = 'running'
      effect.executionState = 'running'
      const attempt: import('../core/types.js').AttemptRecord = { id: effect.attemptId, effectId: effect.id, executionState: 'running', sideEffectState: effect.sideEffectState, startedAt: this.state.now }
      effect.attempts = [...(effect.attempts ?? []), attempt]
      const controller = new AbortController()
      if (effect.kind === 'human' && !this.customExecutor) {
        this.state.events.push({ seq: this.state.nextIds.event++, type: 'human.requested', effectId: effect.id, data: effect.input })
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
      const promise = this.executor(effect, controller.signal).then((execution) => this.completeEffect(effect.id, execution)).catch((cause) => { this.state.events.push({ seq: this.state.nextIds.event++, type: 'effect.dispatch_failed', effectId: effect.id, data: { message: cause instanceof Error ? cause.message : String(cause) } }); this.completeEffect(effect.id, { value: null, sideEffectState: 'none' }, 'failed', { code: 'EFFECT_FAILED', message: cause instanceof Error ? cause.message : String(cause) }) }).finally(() => { this.executions.delete(effect.id); this.refreshWaits() })
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
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'limit.rejected', effectId, data: { code: reason } })
    this.quarantineEffect(effectId, reason, effect.cancelGraceMs ?? 0)
  }

  private requestEffectCancellation(effectId: string, reason: string, graceMs: number): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    effect.cancelRequested = { reason, at: this.state.now }
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'effect.cancel_requested', effectId, data: { reason } })
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
    effect.executionState = 'remote_unknown'
    effect.sideEffectState = effect.sideEffectPolicy === 'write' ? 'unknown' : 'none'
    effect.state = effect.sideEffectState === 'unknown' ? 'reconcile_required' : 'cancelled'
    if (effect.state === 'cancelled') effect.outcome = { status: 'cancelled', error: { code: reason, message: reason } }
    this.quarantine.add(effectId, this.state.now, reason)
    const lane = this.state.lanes.get(effect.ownerLaneId)
    if (lane) lane.unresolvedEffectIds = [...new Set([...(lane.unresolvedEffectIds ?? []), effectId])]
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'effect.quarantined', effectId, data: { reason, state: effect.state } })
    this.refreshWaits()
  }

  private propagateCancelledLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'cancelled') for (const effectId of lane.ownedEffectIds) this.requestEffectCancellation(effectId, 'LANE_CANCELLED', this.state.effects.get(effectId)?.cancelGraceMs ?? 0)
  }

  private runningCount(concurrencyClass: import('../core/types.js').ConcurrencyClass): number { return [...this.state.effects.values()].filter((effect) => effect.concurrencyClass === concurrencyClass && effect.state === 'running').length }

  private enqueueNewReadyLanes(): void {
    for (const lane of this.state.lanes.values()) if (lane.status === 'ready' && !this.ready.has(lane.id)) this.enqueueLane(lane.id)
  }

  private failLane(lane: LaneRecord, failure: RuntimeError): void { lane.status = 'failed'; lane.version++; this.state.events.push({ seq: this.state.nextIds.event++, type: 'lane.failed', laneId: lane.id, data: failure as unknown as JsonValue }); this.refreshWaits() }

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
              lane.status = 'succeeded'; delete lane.closingResult
              this.state.events.push({ seq: this.state.nextIds.event++, type: 'lane.succeeded', laneId: lane.id, data: resultId })
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
