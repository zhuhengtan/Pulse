import { setTimeout as delay } from 'node:timers/promises'
import type { JsonValue, Outcome } from '@hunterzhu/pulse-runtime'
import type { AssistantEvent, RunHandle, RunUsage } from './index.js'
import { HostTaskAdmissionStore } from './task-admission.js'
import type { WebRunAdmission } from './protocol.js'

export interface TaskAdmissionPermit { directory: string; jobId: string; ownerToken: string; runId: string; conversationKey: string }
const emptyUsage = (): RunUsage => ({ schemaVersion: 1, inputTokens: null, outputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, reasoningTokens: null, visibleOutputChars: null, modelCalls: 0, truncationEvents: 0, durationMs: null, providerCosts: [], completeness: 'unavailable' })
const error = (code: string) => Object.assign(new Error(code), { code, retryable: false })

/** A queue item is a tracked, cancellable handle before any worker is created. */
export class AdmittedTaskRun {
  readonly handle: RunHandle
  private actual: RunHandle | undefined
  private finished = false
  private cancelled = false
  private claimed = false
  private readonly ready: Promise<RunHandle | undefined>
  private readonly result: Promise<Outcome & { text?: string }>
  private beginOutcome!: () => void
  private readonly outcomeRequested = new Promise<void>(resolve => { this.beginOutcome = resolve })
  private readonly createdAt: number
  private startedAt: number | undefined
  private checkpointClosed = false
  private rejectCheckpoint!: (cause: Error) => void
  private readonly checkpoint = new Promise<never>((_resolve, reject) => { this.rejectCheckpoint = reject })
  constructor(private readonly store: HostTaskAdmissionStore, readonly permit: TaskAdmissionPermit, conversationId: string, launch: (permit: TaskAdmissionPermit) => Promise<RunHandle>, private readonly authorize: (operation: string) => Promise<unknown>, preclaimed = false) {
    void this.checkpoint.catch(() => undefined)
    this.createdAt = Date.now()
    this.claimed = preclaimed
    this.ready = this.start(launch)
    void this.ready.catch(() => undefined)
    this.result = this.ready.then(async actual => {
      if (!actual) return { status: 'cancelled' as const, reason: 'CANCELLED_BEFORE_START' }
      try {
        await Promise.race([this.outcomeRequested, this.checkpoint])
        const outcome = await Promise.race([actual.outcome(), this.checkpoint])
        if (outcome.unresolvedEffectIds?.length) this.store.quarantine(permit.jobId, 'TASK_EFFECTS_UNCONFIRMED')
        else this.store.release(permit.jobId, permit.ownerToken, { confirmed: true, outcome: outcome.status === 'succeeded' ? 'completed' : outcome.status })
        return outcome
      } catch (cause) {
        const cleanWorkerStop = Boolean(actual.shutdown && actual.isActive?.() === false && cause instanceof Error && cause.message === 'WORKER_EXITED:0')
        if (this.checkpointClosed || cleanWorkerStop) this.store.release(permit.jobId, permit.ownerToken, { confirmed: true, outcome: 'interrupted', reason: 'CHECKPOINTED_HOST_CLOSED' })
        else this.store.quarantine(permit.jobId, 'TASK_STOP_UNCONFIRMED')
        throw cause
      }
    }).finally(() => { this.finished = true })
    void this.result.catch(() => undefined)
    const actual = async () => { const value = await this.ready; if (!value) throw error('RUN_NOT_ACTIVE'); return value }
    const self = this
    this.handle = {
      id: permit.runId, conversationId,
      admission: () => self.admission(),
      events: (async function* (): AsyncGenerator<AssistantEvent> {
        let seq = 0, lastAdmission = ''
        while (!self.actual && !self.finished) {
          const admission = self.admission()
          const signature = JSON.stringify(admission)
          if (signature !== lastAdmission) {
            lastAdmission = signature
            yield { schemaVersion: 1, type: 'status', conversationId, runId: permit.runId, seq: ++seq / 1000, data: { kind: 'working', label: admission.phase === 'queued' ? '排队中' : '正在启动', admission: admission as unknown as JsonValue } }
          }
          await Promise.race([self.ready.catch(() => undefined), delay(250)])
        }
        const run = await self.ready
        if (run) {
          yield { schemaVersion: 1, type: 'status', conversationId, runId: permit.runId, seq: ++seq / 1000, data: { kind: 'working', label: '执行中', admission: self.admission() as unknown as JsonValue } }
          for await (const event of run.events) yield event
          self.beginOutcome(); await self.result
        } else yield { schemaVersion: 1, type: 'complete', conversationId, runId: permit.runId, seq: ++seq, data: { status: 'cancelled', taskRequired: false } }
      })(),
      outcome: () => { this.beginOutcome(); return this.result },
      usage: async () => { this.beginOutcome(); const run = await this.ready; return run ? run.usage() : emptyUsage() },
      taskOutcome: async () => { this.beginOutcome(); const run = await this.ready; return run?.taskOutcome() },
      cancel: async reason => { await this.authorize('cancel'); const record = this.store.cancel(permit.jobId); this.cancelled = true; if (record.status !== 'cancelled') { const run = await this.ready; await run?.cancel(reason); this.beginOutcome() } },
      pendingInteractions: async () => this.actual ? this.actual.pendingInteractions() : [],
      reviewApproval: async (effectId, signal) => (await actual()).reviewApproval(effectId, signal),
      reply: async (effectId, value) => (await actual()).reply(effectId, value),
      replyBatch: async (groupId, answers) => (await actual()).replyBatch(groupId, answers),
      submitHumanInput: async (text, target, options) => { if (!this.actual) throw error('CONVERSATION_BUSY'); await this.actual.submitHumanInput(text, target, options) },
      processes: async () => this.actual?.processes ? this.actual.processes() : [],
      pollProcess: async (id, offset) => { const run = await actual(); if (!run.pollProcess) throw error('RUN_NOT_ACTIVE'); return run.pollProcess(id, offset) },
      cancelProcess: async id => { const run = await actual(); if (!run.cancelProcess) throw error('RUN_NOT_ACTIVE'); return run.cancelProcess(id) },
      isActive: () => !this.finished,
      checkpointForUpdate: async () => { if (this.actual) { await this.actual.checkpointForUpdate?.() } },
      shutdown: async options => { if (!this.claimed) { this.store.cancel(permit.jobId); this.cancelled = true; await this.result; return } const run = await this.ready; if (run?.shutdown) { await run.shutdown(options); this.beginOutcome() } else if (!options?.preserveRuns) { await run?.cancel('SERVER_STOPPED'); this.beginOutcome() } },
    }
  }
  get completion(): Promise<Outcome & { text?: string }> { return this.result }
  get hasClaim(): boolean { return this.claimed }
  get isInProcess(): boolean { return Boolean(this.actual && !this.actual.shutdown) }
  retireAfterCheckpoint(): void { this.checkpointClosed = true; this.rejectCheckpoint(error('HOST_TASK_CHECKPOINTED')) }
  retireUnconfirmed(): void { this.rejectCheckpoint(error('HOST_TASK_STOP_UNCONFIRMED')) }
  async waitForStart(): Promise<void> { await this.ready }
  admission(): WebRunAdmission {
    const record = this.store.get(this.permit.jobId)
    const status = record?.status
    const phase = status === 'queued' || status === 'starting' || status === 'cancelling' || status === 'quarantined' ? status : 'running'
    const queued = this.store.list().filter(item => item.status === 'queued').sort((a, b) => a.sequence - b.sequence)
    const position = queued.findIndex(item => item.jobId === this.permit.jobId) + 1
    return { phase, ...(phase === 'queued' && position > 0 ? { position } : {}), queuedAt: this.createdAt, ...(this.startedAt ? { startedAt: this.startedAt } : {}) }
  }
  private async start(launch: (permit: TaskAdmissionPermit) => Promise<RunHandle>): Promise<RunHandle | undefined> {
    while (!this.claimed) {
      const record = this.store.get(this.permit.jobId)
      if (record?.status === 'cancelled' || this.cancelled) return undefined
      if (!record || record.status !== 'queued') throw error('HOST_TASK_ADMISSION_INTERRUPTED')
      const claim = this.store.claim(this.permit.jobId, this.permit.ownerToken)
      if (claim) { this.claimed = true; break }
      await delay(100)
    }
    try { await this.authorize('send') }
    catch (cause) { this.store.release(this.permit.jobId, this.permit.ownerToken, { confirmed: true, outcome: 'interrupted', reason: 'START_AUTHORIZATION_CHANGED' }); throw cause }
    try {
      if (this.store.get(this.permit.jobId)?.status === 'cancelling' || this.cancelled) {
        this.store.release(this.permit.jobId, this.permit.ownerToken, { confirmed: true, outcome: 'cancelled' }); return undefined
      }
      const run = await launch(this.permit)
      this.actual = run
      if (run.id !== this.permit.runId) { await run.shutdown?.(); throw error('HOST_TASK_RUN_ID_MISMATCH') }
      this.startedAt = Date.now()
      if (this.cancelled) await run.cancel('USER_REQUESTED')
      return run
    } catch (cause) { if (['starting', 'running', 'cancelling'].includes(this.store.get(this.permit.jobId)?.status ?? '')) { if ((cause as { admissionNotStarted?: boolean }).admissionNotStarted === true) this.store.release(this.permit.jobId, this.permit.ownerToken, { confirmed: true, outcome: 'interrupted', reason: 'ADMISSION_FROZEN' }); else this.store.quarantine(this.permit.jobId, 'TASK_START_UNCONFIRMED') } throw cause }
  }
}
