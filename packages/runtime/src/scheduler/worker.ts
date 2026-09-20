import type { EffectExecution } from './runtime.js'
import type { EffectRecord, JsonValue, RuntimeError } from '../core/types.js'

export interface WorkerTaskRecord {
  id: string
  payload: JsonValue
  state: 'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled'
  attempt: number
  leaseId?: string
  workerId?: string
  leaseExpiresAt?: number
  leaseMs?: number
  idempotencyKey?: string
  result?: JsonValue
  error?: RuntimeError
}

export interface WorkerLease { task: WorkerTaskRecord; workerId: string; leaseId: string }

export type WorkerHandler = (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>
export interface WorkerSubmitOptions { taskId?: string; idempotencyKey?: string; leaseMs?: number; signal?: AbortSignal }
type Deferred = { promise: Promise<JsonValue>; resolve: (value: JsonValue) => void; reject: (error: unknown) => void }

function deferred(): Deferred {
  let resolve!: (value: JsonValue) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<JsonValue>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function runtimeError(cause: unknown): RuntimeError { return { code: 'WORKER_FAILED', message: cause instanceof Error ? cause.message : String(cause) } }

/** A lease-based worker coordinator. A network transport can implement the same claim/complete contract. */
export class WorkerCoordinator {
  private readonly tasks = new Map<string, WorkerTaskRecord>()
  private readonly deferreds = new Map<string, Deferred>()
  private readonly idempotency = new Map<string, string>()
  private readonly handlers = new Map<string, WorkerHandler>()
  private readonly remoteWorkers = new Set<string>()
  private readonly activeLeases = new Map<string, { leaseId: string; controller: AbortController }>()
  private sequence = 1

  register(workerId: string, handler: WorkerHandler): () => void {
    if (!workerId || this.handlers.has(workerId) || this.remoteWorkers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.handlers.set(workerId, handler)
    this.pump()
    return () => this.unregister(workerId)
  }

  registerRemote(workerId: string): () => void {
    if (!workerId || this.handlers.has(workerId) || this.remoteWorkers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.remoteWorkers.add(workerId)
    this.pump()
    return () => this.unregister(workerId)
  }

  unregister(workerId: string): void {
    this.handlers.delete(workerId)
    this.remoteWorkers.delete(workerId)
    const active = this.activeLeases.get(workerId)
    if (active) { active.controller.abort(); this.activeLeases.delete(workerId) }
    for (const task of this.tasks.values()) if (task.state === 'leased' && task.workerId === workerId) this.requeue(task)
    this.pump()
  }

  submit(payload: JsonValue, options: WorkerSubmitOptions = {}): Promise<JsonValue> {
    const existingId = options.idempotencyKey === undefined ? undefined : this.idempotency.get(options.idempotencyKey)
    if (existingId !== undefined) return this.deferreds.get(existingId)!.promise
    const taskId = options.taskId ?? `worker-task-${this.sequence++}`
    if (this.tasks.has(taskId)) throw new Error(`WORKER_TASK_ALREADY_EXISTS:${taskId}`)
    const leaseMs = options.leaseMs ?? 30_000
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('INVALID_WORKER_LEASE')
    const task: WorkerTaskRecord = { id: taskId, payload: structuredClone(payload), state: 'queued', attempt: 0, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) }
    const result = deferred()
    this.tasks.set(taskId, task)
    this.deferreds.set(taskId, result)
    if (options.idempotencyKey !== undefined) this.idempotency.set(options.idempotencyKey, taskId)
    if (options.signal) {
      if (options.signal.aborted) this.cancel(taskId, 'WORKER_CANCELLED')
      else options.signal.addEventListener('abort', () => this.cancel(taskId, 'WORKER_CANCELLED'), { once: true })
    }
    task.leaseMs = leaseMs
    this.pump()
    return result.promise
  }

  recoverExpired(now = Date.now()): string[] {
    const recovered: string[] = []
    for (const task of this.tasks.values()) if (task.state === 'leased' && task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= now) {
      const active = task.workerId === undefined ? undefined : this.activeLeases.get(task.workerId)
      if (active !== undefined && active.leaseId === task.leaseId) { active.controller.abort(); this.activeLeases.delete(task.workerId!) }
      this.requeue(task)
      recovered.push(task.id)
    }
    this.pump()
    return recovered
  }

  claim(workerId: string, now = Date.now()): WorkerLease | undefined {
    if (!this.handlers.has(workerId) && !this.remoteWorkers.has(workerId)) throw new Error(`UNKNOWN_WORKER:${workerId}`)
    const active = this.activeLeases.get(workerId)
    if (active !== undefined) {
      const activeTask = [...this.tasks.values()].find((task) => task.state === 'leased' && task.workerId === workerId && task.leaseId === active.leaseId)
      if (activeTask?.leaseExpiresAt !== undefined && activeTask.leaseExpiresAt <= now) {
        active.controller.abort()
        this.activeLeases.delete(workerId)
        this.requeue(activeTask)
      } else return undefined
    }
    const task = [...this.tasks.values()].find((candidate) => candidate.state === 'queued')
    if (!task) return undefined
    const lease = this.assign(workerId, task, now)
    return { workerId, leaseId: lease.leaseId, task: structuredClone(task) }
  }

  renewLease(workerId: string, leaseId: string, now = Date.now(), leaseMs?: number): number | undefined {
    const active = this.activeLeases.get(workerId)
    const task = [...this.tasks.values()].find((candidate) => candidate.state === 'leased' && candidate.workerId === workerId && candidate.leaseId === leaseId)
    if (active?.leaseId !== leaseId || !task) return undefined
    const duration = leaseMs ?? task.leaseMs ?? 30_000
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('INVALID_WORKER_LEASE')
    task.leaseExpiresAt = now + duration
    return task.leaseExpiresAt
  }

  completeRemote(workerId: string, leaseId: string, value: JsonValue): boolean {
    return this.settleRemote(workerId, leaseId, () => this.completeTask(this.taskForLease(workerId, leaseId)!.id, leaseId, value))
  }

  failRemote(workerId: string, leaseId: string, error: RuntimeError): boolean {
    return this.settleRemote(workerId, leaseId, () => this.failTask(this.taskForLease(workerId, leaseId)!.id, leaseId, error))
  }

  get(taskId: string): WorkerTaskRecord | undefined {
    const task = this.tasks.get(taskId)
    return task === undefined ? undefined : structuredClone(task)
  }

  cancel(taskId: string, reason = 'WORKER_CANCELLED'): boolean {
    const task = this.tasks.get(taskId)
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.state)) return false
    const active = task.workerId === undefined ? undefined : this.activeLeases.get(task.workerId)
    if (active !== undefined && active.leaseId === task.leaseId) { active.controller.abort(); this.activeLeases.delete(task.workerId!) }
    task.state = 'cancelled'; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
    this.deferreds.get(task.id)?.reject(new Error(reason))
    this.pump()
    return true
  }

  inspect(): WorkerTaskRecord[] { return [...this.tasks.values()].map((task) => structuredClone(task)) }

  private requeue(task: WorkerTaskRecord): void {
    task.state = 'queued'; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
  }

  private pump(): void {
    for (const [workerId, handler] of this.handlers) {
      const lease = this.claim(workerId)
      if (!lease) continue
      const controller = this.activeLeases.get(workerId)!.controller
      void handler(lease.task.payload, controller.signal).then((value) => this.completeTask(lease.task.id, lease.leaseId, value)).catch((cause) => this.failTask(lease.task.id, lease.leaseId, runtimeError(cause))).finally(() => {
        const active = this.activeLeases.get(workerId)
        if (active?.leaseId === lease.leaseId) this.activeLeases.delete(workerId)
        this.pump()
      })
    }
  }

  private assign(workerId: string, task: WorkerTaskRecord, now: number): { leaseId: string; controller: AbortController } {
    const leaseId = `worker-lease-${this.sequence++}`
    const controller = new AbortController()
    const leaseMs = task.leaseMs ?? 30_000
    task.state = 'leased'; task.attempt++; task.leaseId = leaseId; task.workerId = workerId; task.leaseExpiresAt = now + leaseMs
    this.activeLeases.set(workerId, { leaseId, controller })
    return { leaseId, controller }
  }

  private taskForLease(workerId: string, leaseId: string): WorkerTaskRecord | undefined {
    const active = this.activeLeases.get(workerId)
    if (active?.leaseId !== leaseId) return undefined
    return [...this.tasks.values()].find((task) => task.state === 'leased' && task.workerId === workerId && task.leaseId === leaseId)
  }

  private settleRemote(workerId: string, leaseId: string, settle: () => boolean): boolean {
    if (this.taskForLease(workerId, leaseId) === undefined) return false
    const settled = settle()
    if (settled) this.activeLeases.delete(workerId)
    this.pump()
    return settled
  }

  private completeTask(taskId: string, leaseId: string, value: JsonValue): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.state !== 'leased' || task.leaseId !== leaseId) return false
    task.state = 'succeeded'; task.result = structuredClone(value); delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
    this.deferreds.get(taskId)?.resolve(value)
    return true
  }

  private failTask(taskId: string, leaseId: string, error: RuntimeError): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.state !== 'leased' || task.leaseId !== leaseId) return false
    task.state = 'failed'; task.error = error; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
    this.deferreds.get(taskId)?.reject(new Error(error.message))
    return true
  }
}

export function createWorkerEffectExecutor(coordinator: WorkerCoordinator, options: { leaseMs?: number } = {}): (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution> {
  return async (effect, signal) => {
    const value = await coordinator.submit({ effectId: effect.id, attemptId: effect.attemptId, kind: effect.kind, input: effect.input }, { taskId: `${effect.id}:${effect.attemptId}`, idempotencyKey: effect.idempotencyKey ?? `${effect.id}:${effect.attemptId}`, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }), signal })
    return { value, executionState: 'succeeded', sideEffectState: 'none' }
  }
}
