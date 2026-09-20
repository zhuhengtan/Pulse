import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
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
export interface WorkerCoordinatorSnapshot { schemaVersion: 1; sequence: number; tasks: WorkerTaskRecord[]; idempotency: Record<string, string>; integrity?: { algorithm: 'sha256'; digest: string } }
export interface WorkerPersistenceBackend { load(): Promise<WorkerCoordinatorSnapshot | undefined>; save(snapshot: WorkerCoordinatorSnapshot): Promise<void> }

export class FileWorkerPersistenceBackend implements WorkerPersistenceBackend {
  private pending: Promise<void> = Promise.resolve()
  constructor(readonly filePath: string) {}
  async load(): Promise<WorkerCoordinatorSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as WorkerCoordinatorSnapshot }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause }
  }
  async save(snapshot: WorkerCoordinatorSnapshot): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString()}`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporaryPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify(snapshot), 'utf8')
        await handle.sync()
        await handle.close(); handle = undefined
        await rename(temporaryPath, this.filePath)
        try {
          const directory = await open(dirname(this.filePath), 'r')
          try { await directory.sync() } finally { await directory.close() }
        } catch {
          // Some filesystems do not expose directory fsync; the rename remains atomic.
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

export type WorkerHandler = (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>
export interface WorkerSubmitOptions { taskId?: string; idempotencyKey?: string; leaseMs?: number; signal?: AbortSignal }
export interface WorkerCoordinatorOptions { persistenceBackend?: WorkerPersistenceBackend }
type Deferred = { promise: Promise<JsonValue>; resolve: (value: JsonValue) => void; reject: (error: unknown) => void }

function deferred(): Deferred {
  let resolve!: (value: JsonValue) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<JsonValue>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function runtimeError(cause: unknown): RuntimeError {
  if (typeof cause === 'object' && cause !== null && typeof (cause as { retryable?: unknown }).retryable === 'boolean') return { code: 'WORKER_FAILED', message: cause instanceof Error ? cause.message : String(cause), retryable: (cause as { retryable: boolean }).retryable }
  return { code: 'WORKER_FAILED', message: cause instanceof Error ? cause.message : String(cause) }
}

function workerSnapshotDigest(snapshot: WorkerCoordinatorSnapshot): string {
  const copy = structuredClone(snapshot) as unknown as Record<string, unknown>
  delete copy.integrity
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex')
}

/** A lease-based worker coordinator. A network transport can implement the same claim/complete contract. */
export class WorkerCoordinator {
  private readonly tasks = new Map<string, WorkerTaskRecord>()
  private readonly deferreds = new Map<string, Deferred>()
  private readonly idempotency = new Map<string, string>()
  private readonly handlers = new Map<string, WorkerHandler>()
  private readonly remoteWorkers = new Set<string>()
  private readonly activeLeases = new Map<string, { leaseId: string; controller: AbortController }>()
  private readonly persistenceBackend: WorkerPersistenceBackend | undefined
  private persistencePending: Promise<void> = Promise.resolve()
  private sequence = 1

  constructor(options: WorkerCoordinatorOptions = {}) { this.persistenceBackend = options.persistenceBackend }

  static restore(snapshot: WorkerCoordinatorSnapshot, options: WorkerCoordinatorOptions = {}): WorkerCoordinator {
    if (snapshot.schemaVersion !== 1 || !Number.isInteger(snapshot.sequence) || snapshot.sequence < 1 || !Array.isArray(snapshot.tasks)) throw new Error('INVALID_WORKER_SNAPSHOT')
    const coordinator = new WorkerCoordinator(options)
    coordinator.sequence = snapshot.sequence
    for (const input of snapshot.tasks) {
      if (!input || typeof input.id !== 'string' || typeof input.payload !== 'object' && input.payload !== null && typeof input.payload !== 'string' && typeof input.payload !== 'number' && typeof input.payload !== 'boolean' || !['queued', 'leased', 'succeeded', 'failed', 'cancelled'].includes(input.state)) throw new Error('INVALID_WORKER_SNAPSHOT')
      const task = structuredClone(input)
      if (coordinator.tasks.has(task.id)) throw new Error('DUPLICATE_WORKER_TASK')
      if (task.state === 'leased') { task.state = 'queued'; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt }
      coordinator.tasks.set(task.id, task)
    }
    if (snapshot.integrity !== undefined && (snapshot.integrity.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(snapshot.integrity.digest) || snapshot.integrity.digest !== workerSnapshotDigest(snapshot))) throw new Error('INVALID_WORKER_INTEGRITY')
    for (const [key, taskId] of Object.entries(snapshot.idempotency ?? {})) if (coordinator.tasks.has(taskId)) coordinator.idempotency.set(key, taskId)
    return coordinator
  }

  static async fromPersistence(backend: WorkerPersistenceBackend): Promise<WorkerCoordinator> {
    const snapshot = await backend.load()
    return snapshot === undefined ? new WorkerCoordinator({ persistenceBackend: backend }) : WorkerCoordinator.restore(snapshot, { persistenceBackend: backend })
  }

  async flushPersistence(): Promise<void> { await this.persistencePending }

  register(workerId: string, handler: WorkerHandler): () => void {
    if (!workerId || this.handlers.has(workerId) || this.remoteWorkers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.handlers.set(workerId, handler)
    this.pump()
    this.schedulePersistence()
    return () => this.unregister(workerId)
  }

  registerRemote(workerId: string): () => void {
    if (!workerId || this.handlers.has(workerId) || this.remoteWorkers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.remoteWorkers.add(workerId)
    this.pump()
    this.schedulePersistence()
    return () => this.unregister(workerId)
  }

  unregister(workerId: string): void {
    this.handlers.delete(workerId)
    this.remoteWorkers.delete(workerId)
    const active = this.activeLeases.get(workerId)
    if (active) { active.controller.abort(); this.activeLeases.delete(workerId) }
    for (const task of this.tasks.values()) if (task.state === 'leased' && task.workerId === workerId) this.requeue(task)
    this.pump()
    this.schedulePersistence()
  }

  submit(payload: JsonValue, options: WorkerSubmitOptions = {}): Promise<JsonValue> {
    const existingId = options.idempotencyKey === undefined ? undefined : this.idempotency.get(options.idempotencyKey)
    if (existingId !== undefined) return this.promiseFor(this.tasks.get(existingId)!).promise
    const taskId = options.taskId ?? `worker-task-${this.sequence++}`
    if (this.tasks.has(taskId)) throw new Error(`WORKER_TASK_ALREADY_EXISTS:${taskId}`)
    const leaseMs = options.leaseMs ?? 30_000
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('INVALID_WORKER_LEASE')
    const task: WorkerTaskRecord = { id: taskId, payload: structuredClone(payload), state: 'queued', attempt: 0, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) }
    const result = this.ensureDeferred(taskId)
    this.tasks.set(taskId, task)
    this.deferreds.set(taskId, result)
    if (options.idempotencyKey !== undefined) this.idempotency.set(options.idempotencyKey, taskId)
    if (options.signal) {
      if (options.signal.aborted) this.cancel(taskId, 'WORKER_CANCELLED')
      else options.signal.addEventListener('abort', () => this.cancel(taskId, 'WORKER_CANCELLED'), { once: true })
    }
    task.leaseMs = leaseMs
    this.pump()
    this.schedulePersistence()
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
    this.schedulePersistence()
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
    this.schedulePersistence()
    return { workerId, leaseId: lease.leaseId, task: structuredClone(task) }
  }

  renewLease(workerId: string, leaseId: string, now = Date.now(), leaseMs?: number): number | undefined {
    const active = this.activeLeases.get(workerId)
    const task = [...this.tasks.values()].find((candidate) => candidate.state === 'leased' && candidate.workerId === workerId && candidate.leaseId === leaseId)
    if (active?.leaseId !== leaseId || !task) return undefined
    const duration = leaseMs ?? task.leaseMs ?? 30_000
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('INVALID_WORKER_LEASE')
    task.leaseExpiresAt = now + duration
    this.schedulePersistence()
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

  snapshot(): WorkerCoordinatorSnapshot {
    const snapshot: WorkerCoordinatorSnapshot = { schemaVersion: 1, sequence: this.sequence, tasks: this.inspect(), idempotency: Object.fromEntries(this.idempotency) }
    return { ...snapshot, integrity: { algorithm: 'sha256', digest: workerSnapshotDigest(snapshot) } }
  }

  cancel(taskId: string, reason = 'WORKER_CANCELLED'): boolean {
    const task = this.tasks.get(taskId)
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.state)) return false
    const active = task.workerId === undefined ? undefined : this.activeLeases.get(task.workerId)
    if (active !== undefined && active.leaseId === task.leaseId) { active.controller.abort(); this.activeLeases.delete(task.workerId!) }
    task.state = 'cancelled'; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
    this.ensureDeferred(task.id).reject(new Error(reason))
    this.pump()
    this.schedulePersistence()
    return true
  }

  inspect(): WorkerTaskRecord[] { return [...this.tasks.values()].map((task) => structuredClone(task)) }

  private schedulePersistence(): void {
    if (!this.persistenceBackend) return
    const snapshot = this.snapshot()
    const operation = this.persistencePending.catch(() => undefined).then(() => this.persistenceBackend!.save(snapshot))
    this.persistencePending = operation
  }

  private requeue(task: WorkerTaskRecord): void {
    task.state = 'queued'; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
  }

  private ensureDeferred(taskId: string): Deferred {
    const existing = this.deferreds.get(taskId)
    if (existing) return existing
    const result = deferred()
    this.deferreds.set(taskId, result)
    const task = this.tasks.get(taskId)
    if (task?.state === 'succeeded') result.resolve(task.result ?? null)
    else if (task?.state === 'failed') result.reject(new Error(task.error?.message ?? 'WORKER_FAILED'))
    else if (task?.state === 'cancelled') result.reject(new Error('WORKER_CANCELLED'))
    return result
  }

  private promiseFor(task: WorkerTaskRecord): Deferred {
    if (!task) throw new Error('WORKER_IDEMPOTENCY_TARGET_MISSING')
    return this.ensureDeferred(task.id)
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
    this.ensureDeferred(taskId).resolve(value)
    this.schedulePersistence()
    return true
  }

  private failTask(taskId: string, leaseId: string, error: RuntimeError): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.state !== 'leased' || task.leaseId !== leaseId) return false
    task.state = 'failed'; task.error = error; delete task.leaseId; delete task.workerId; delete task.leaseExpiresAt
    this.ensureDeferred(taskId).reject(new Error(error.message))
    this.schedulePersistence()
    return true
  }
}

export function createWorkerEffectExecutor(coordinator: WorkerCoordinator, options: { leaseMs?: number } = {}): (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution> {
  return async (effect, signal) => {
    const value = await coordinator.submit({ effectId: effect.id, attemptId: effect.attemptId, kind: effect.kind, input: effect.input }, { taskId: `${effect.id}:${effect.attemptId}`, idempotencyKey: effect.idempotencyKey ?? `${effect.id}:${effect.attemptId}`, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }), signal })
    return { value, executionState: 'succeeded', sideEffectState: 'none' }
  }
}
