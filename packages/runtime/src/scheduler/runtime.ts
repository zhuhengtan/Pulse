import { apply } from '../core/mutations.js'
import { createAgent } from '../core/factory.js'
import { validateStep } from '../transitions/validate.js'
import { ReadyQueue, readyItemFromLane, VirtualClock } from './index.js'
import type { EffectRecord, JsonValue, LaneRecord, LaneStepOutput, Outcome, ResumeInput, RuntimeState, RuntimeError, TargetRef, WaitRecord } from '../core/types.js'
import { createRuntimeState } from '../core/types.js'
import { QuarantineScope } from '../lifecycle/scopes.js'

export interface LaneStepContext { lane: Readonly<LaneRecord>; resumeInput?: ResumeInput; now: number }
export interface LaneProgram { id: string; version: string; step: (context: LaneStepContext) => LaneStepOutput }
export interface EffectExecution { value: JsonValue; privacy?: 'public' | 'cloud_allowed' | 'local_only'; sideEffectState?: 'none' | 'applied' | 'unknown' }
export type EffectExecutor = (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution>

export interface RuntimeConfig {
  maxLaneStepsPerTick?: number
  agingIntervalMs?: number
  agingCap?: number
  maxTotalLanes?: number
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
  readonly clock: VirtualClock
  readonly ready: ReadyQueue
  readonly quarantine = new QuarantineScope()
  private readonly programs = new Map<string, LaneProgram>()
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private readonly executor: EffectExecutor
  private enqueueSeq = 1
  private readonly maxSteps: number

  constructor(config: RuntimeConfig = {}) {
    this.state = createRuntimeState(config.maxTotalLanes ?? 64)
    this.clock = new VirtualClock()
    this.ready = new ReadyQueue(config.agingIntervalMs ?? 1000, config.agingCap ?? Number.POSITIVE_INFINITY)
    this.maxSteps = config.maxLaneStepsPerTick ?? 32
    this.executor = config.effectExecutor ?? (async () => ({ value: null }))
  }

  register(program: LaneProgram): void { this.programs.set(`${program.id}@${program.version}`, program) }
  createAgent(goal: string, program: LaneProgram, agentId?: string): { agentId: string; laneId: string } {
    this.register(program)
    const { agent, root } = createAgent(this.state, goal, { programId: program.id, programVersion: program.version, step: 'start', locals: {} }, agentId === undefined ? {} : { agentId })
    root.enqueueSeq = this.enqueueSeq++
    this.ready.enqueue(readyItemFromLane(root))
    return { agentId: agent.id, laneId: root.id }
  }

  enqueueLane(laneId: string): void { const lane = this.state.lanes.get(laneId); if (lane && lane.status === 'ready') { lane.enqueueSeq = this.enqueueSeq++; lane.readySince = this.state.now; this.ready.enqueue(readyItemFromLane(lane)) } }

  tick(): number {
    this.state.now = this.clock.now()
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
      try { output = program.step({ lane: structuredClone(lane), ...(lane.pendingResumeInput ? { resumeInput: structuredClone(lane.pendingResumeInput) } : {}), now: this.state.now }) }
      catch (cause) { this.failLane(lane, { code: 'STEP_FAILED', message: cause instanceof Error ? cause.message : String(cause) }); continue }
      const result = validateStep(this.state, lane.id, output)
      if ('rejection' in result) {
        lane.pendingResumeInput = { type: 'control_error', error: result.rejection, ...(lane.pendingResumeInput ? { original: lane.pendingResumeInput } : {}) }
        this.state.events.push({ seq: this.state.nextIds.event++, type: 'step.rejected', laneId: lane.id, data: result.rejection as unknown as JsonValue })
        this.enqueueLane(lane.id)
      } else {
        apply(this.state, result.mutations)
        const updated = this.state.lanes.get(lane.id)
        if (updated?.status === 'ready') this.enqueueLane(updated.id)
        this.enqueueNewReadyLanes()
        this.refreshWaits()
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
      if (this.ready.size === 0 && this.executions.size === 0) break
      if (work === 0 && this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise))
      else if (work === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const root = [...this.state.lanes.values()].find((lane) => lane.ownerLaneId === undefined)
    return { status: root?.status === 'failed' ? 'failed' : root?.status === 'cancelled' ? 'cancelled' : 'succeeded', unresolvedEffectIds: this.quarantine.unresolvedEffectIds }
  }

  async waitForIdle(): Promise<void> { while (this.ready.size || this.executions.size) { this.tick(); if (this.executions.size) await Promise.race([...this.executions.values()].map((execution) => execution.promise)) } }

  completeEffect(effectId: string, execution: EffectExecution, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', error?: RuntimeError): void {
    const effect = this.state.effects.get(effectId)
    if (!effect || effect.outcome) return
    effect.state = status
    effect.executionState = status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'failed' : 'failed'
    effect.sideEffectState = execution.sideEffectState ?? 'none'
    const resultId = `result-${this.state.nextIds.result++}`
    const outcome: Outcome = status === 'succeeded' ? { status, resultRef: resultId } : { status, ...(error ? { error } : {}) }
    effect.outcome = outcome
    if (status === 'succeeded') this.state.results.set(resultId, { id: resultId, effectId, value: execution.value, privacy: execution.privacy ?? 'public', derivedFrom: [] })
    this.state.events.push({ seq: this.state.nextIds.event++, type: 'effect.settled', effectId, data: outcome as unknown as JsonValue })
    this.refreshWaits()
  }

  cancelEffect(effectId: string, graceMs = 0): void {
    const running = this.executions.get(effectId)
    if (!running) { const effect = this.state.effects.get(effectId); if (effect && !effect.outcome) this.completeEffect(effectId, { value: null }, 'cancelled'); return }
    running.controller.abort()
    if (graceMs === 0) this.quarantine.add(effectId, this.state.now)
    else this.clock.schedule(graceMs, () => { if (this.executions.has(effectId)) this.quarantine.add(effectId, this.state.now) })
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
    for (const effect of this.state.effects.values()) {
      if (effect.state !== 'queued' || this.executions.has(effect.id)) continue
      effect.state = 'running'
      effect.executionState = 'running'
      const controller = new AbortController()
      const promise = this.executor(effect, controller.signal).then((execution) => this.completeEffect(effect.id, execution)).catch((cause) => this.completeEffect(effect.id, { value: null }, 'failed', { code: 'EFFECT_FAILED', message: cause instanceof Error ? cause.message : String(cause) })).finally(() => { this.executions.delete(effect.id); this.refreshWaits() })
      this.executions.set(effect.id, { controller, promise })
    }
  }

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
        } else if (!pending && !unsatisfied) {
          wait.state = 'satisfied'; wait.resolution = { waitId: wait.id, status: 'satisfied', dependencies: observations }
          const lane = this.state.lanes.get(wait.laneId)
          if (lane && !['succeeded', 'failed', 'cancelled'].includes(lane.status)) { lane.status = 'ready'; delete lane.activeWaitId; lane.pendingResumeInput = { type: 'wait', resolution: wait.resolution }; this.enqueueLane(lane.id) }
          changed = true
        }
      }
    }
  }
}
