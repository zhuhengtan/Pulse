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
  private readonly activeLeases = new Map<string, { leaseId: string; controller: AbortController }>()
  private sequence = 1

  register(workerId: string, handler: WorkerHandler): () => void {
    if (!workerId || this.handlers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.handlers.set(workerId, handler)
    this.pump()
    return () => this.unregister(workerId)
  }

  unregister(workerId: string): void {
    this.handlers.delete(workerId)
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
      if (this.activeLeases.has(workerId)) continue
      const task = [...this.tasks.values()].find((candidate) => candidate.state === 'queued')
      if (!task) continue
      const leaseId = `worker-lease-${this.sequence++}`
      const controller = new AbortController()
      const leaseMs = task.leaseMs ?? 30_000
      task.state = 'leased'; task.attempt++; task.leaseId = leaseId; task.workerId = workerId; task.leaseExpiresAt = Date.now() + leaseMs
      this.activeLeases.set(workerId, { leaseId, controller })
      void handler(task.payload, controller.signal).then((value) => this.complete(task.id, leaseId, value)).catch((cause) => this.fail(task.id, leaseId, runtimeError(cause))).finally(() => {
        const active = this.activeLeases.get(workerId)
        if (active?.leaseId === leaseId) this.activeLeases.delete(workerId)
        this.pump()
      })
    }
  }

  private complete(taskId: string, leaseId: string, value: JsonValue): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.state !== 'leased' || task.leaseId !== leaseId) return false
    task.state = 'succeeded'; task.result = structuredClone(value); delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
    this.deferreds.get(taskId)?.resolve(value)
    return true
  }

  private fail(taskId: string, leaseId: string, error: RuntimeError): boolean {
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
