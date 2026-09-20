import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
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
export interface WorkerPersistenceBackend { load(): Promise<WorkerCoordinatorSnapshot | undefined>; save(snapshot: WorkerCoordinatorSnapshot, expectedDigest?: string): Promise<void> }

export class FileWorkerPersistenceBackend implements WorkerPersistenceBackend {
  private pending: Promise<void> = Promise.resolve()
  constructor(readonly filePath: string) {}
  async load(): Promise<WorkerCoordinatorSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as WorkerCoordinatorSnapshot }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause }
  }
  async save(snapshot: WorkerCoordinatorSnapshot, expectedDigest?: string): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const lockPath = `${this.filePath}.lock`
      let lock: Awaited<ReturnType<typeof open>> | undefined
      const lockDeadline = Date.now() + 30_000
      while (lock === undefined) {
        try { lock = await open(lockPath, 'wx', 0o600) }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
          const lockStat = await stat(lockPath).catch(() => undefined)
          if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue }
          if (Date.now() >= lockDeadline) throw new Error('WORKER_PERSISTENCE_LOCK_TIMEOUT')
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      }
      try {
        const current = await this.load()
        if (expectedDigest !== undefined && (current === undefined || current.integrity?.digest !== expectedDigest)) throw new Error('WORKER_PERSISTENCE_CONFLICT')
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
      } finally {
        await lock.close().catch(() => undefined)
        await rm(lockPath, { force: true }).catch(() => undefined)
      }
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}

interface WorkerSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
  run(...params: unknown[]): unknown
}

interface WorkerSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): WorkerSqliteStatement
  close(): void
}

type WorkerSqliteDatabaseConstructor = new (path: string) => WorkerSqliteDatabase

/** Durable SQLite snapshot backend for sharing WorkerCoordinator state between processes. */
export class SqliteWorkerPersistenceBackend implements WorkerPersistenceBackend {
  private database: WorkerSqliteDatabase | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async load(): Promise<WorkerCoordinatorSnapshot | undefined> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const row = this.open().prepare('SELECT payload FROM worker_snapshot WHERE id = 1').get()
      if (!row) return undefined
      if (typeof row.payload !== 'string') throw new Error('INVALID_WORKER_SNAPSHOT')
      return JSON.parse(row.payload) as WorkerCoordinatorSnapshot
    })
  }

  async save(snapshot: WorkerCoordinatorSnapshot, expectedDigest?: string): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const database = this.open()
      database.exec('BEGIN IMMEDIATE')
      try {
        const current = database.prepare('SELECT digest FROM worker_snapshot WHERE id = 1').get()
        const currentDigest = current && typeof current.digest === 'string' ? current.digest : undefined
        if (expectedDigest !== undefined && currentDigest !== expectedDigest) throw new Error('WORKER_PERSISTENCE_CONFLICT')
        database.prepare('INSERT INTO worker_snapshot (id, payload, digest) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, digest = excluded.digest').run(JSON.stringify(snapshot), snapshot.integrity?.digest ?? null)
        database.exec('COMMIT')
      } catch (cause) {
        try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
        throw cause
      }
    })
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.database?.close()
      this.database = undefined
    })
  }

  private open(): WorkerSqliteDatabase {
    if (this.database) return this.database
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: WorkerSqliteDatabaseConstructor }
    this.database = new DatabaseSync(this.filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS worker_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, digest TEXT)')
    return this.database
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work, work)
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

export type WorkerHandler = (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>
export interface WorkerSubmitOptions { taskId?: string; idempotencyKey?: string; leaseMs?: number; signal?: AbortSignal }
export interface WorkerCoordinatorOptions { persistenceBackend?: WorkerPersistenceBackend }
export interface WorkerCoordinatorContract {
  submit(payload: JsonValue, options?: WorkerSubmitOptions): Promise<JsonValue>
  register(workerId: string, handler: WorkerHandler): () => void
  registerRemote(workerId: string): () => void
  unregister(workerId: string): void
  claim(workerId: string, now?: number): WorkerLease | undefined
  renewLease(workerId: string, leaseId: string, now?: number, leaseMs?: number): number | undefined
  completeRemote(workerId: string, leaseId: string, value: JsonValue, now?: number): boolean
  failRemote(workerId: string, leaseId: string, error: RuntimeError, now?: number): boolean
  get(taskId: string): WorkerTaskRecord | undefined
  cancel(taskId: string, reason?: string): boolean
  recoverExpired(now?: number): string[]
}
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
export class WorkerCoordinator implements WorkerCoordinatorContract {
  private readonly tasks = new Map<string, WorkerTaskRecord>()
  private readonly deferreds = new Map<string, Deferred>()
  private readonly idempotency = new Map<string, string>()
  private readonly handlers = new Map<string, WorkerHandler>()
  private readonly remoteWorkers = new Set<string>()
  private readonly activeLeases = new Map<string, { leaseId: string; controller: AbortController }>()
  private readonly persistenceBackend: WorkerPersistenceBackend | undefined
  private persistenceDigest: string | undefined
  private persistencePending: Promise<void> = Promise.resolve()
  private sequence = 1

  constructor(options: WorkerCoordinatorOptions = {}) { this.persistenceBackend = options.persistenceBackend }

  static restore(snapshot: WorkerCoordinatorSnapshot, options: WorkerCoordinatorOptions = {}): WorkerCoordinator {
    if (snapshot.schemaVersion !== 1 || !Number.isInteger(snapshot.sequence) || snapshot.sequence < 1 || !Array.isArray(snapshot.tasks)) throw new Error('INVALID_WORKER_SNAPSHOT')
    const coordinator = new WorkerCoordinator(options)
    coordinator.persistenceDigest = snapshot.integrity?.digest ?? workerSnapshotDigest(snapshot)
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

  completeRemote(workerId: string, leaseId: string, value: JsonValue, _now?: number): boolean {
    return this.settleRemote(workerId, leaseId, () => this.completeTask(this.taskForLease(workerId, leaseId)!.id, leaseId, value))
  }

  failRemote(workerId: string, leaseId: string, error: RuntimeError, _now?: number): boolean {
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
    const operation = this.persistencePending.catch(() => undefined).then(async () => {
      const snapshot = this.snapshot()
      await this.persistenceBackend!.save(snapshot, this.persistenceDigest)
      this.persistenceDigest = snapshot.integrity?.digest
    })
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

interface DistributedWorkerSqliteDatabase extends WorkerSqliteDatabase {}

/**
 * A WorkerCoordinator whose lease transitions are owned by SQLite transactions.
 * Separate processes may open the same database and race safely on the same queue.
 */
export class SqliteDistributedWorkerCoordinator implements WorkerCoordinatorContract {
  private database: DistributedWorkerSqliteDatabase | undefined
  private readonly deferreds = new Map<string, Deferred>()
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly handlers = new Map<string, WorkerHandler>()
  private readonly remoteWorkers = new Set<string>()
  private readonly activeLeases = new Map<string, { leaseId: string; controller: AbortController }>()

  constructor(readonly filePath: string) {}

  register(workerId: string, handler: WorkerHandler): () => void {
    if (!workerId || this.handlers.has(workerId) || this.remoteWorkers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.handlers.set(workerId, handler)
    this.pump()
    return () => this.unregister(workerId)
  }

  registerRemote(workerId: string): () => void {
    if (!workerId || this.handlers.has(workerId) || this.remoteWorkers.has(workerId)) throw new Error(`WORKER_ALREADY_REGISTERED:${workerId}`)
    this.remoteWorkers.add(workerId)
    return () => this.unregister(workerId)
  }

  unregister(workerId: string): void {
    this.handlers.delete(workerId)
    this.remoteWorkers.delete(workerId)
    const active = this.activeLeases.get(workerId)
    if (active) { active.controller.abort(); this.activeLeases.delete(workerId) }
    this.requeueWorker(workerId)
    this.pump()
  }

  submit(payload: JsonValue, options: WorkerSubmitOptions = {}): Promise<JsonValue> {
    const leaseMs = options.leaseMs ?? 30_000
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('INVALID_WORKER_LEASE')
    const taskId = this.withTransaction((database) => {
      if (options.idempotencyKey !== undefined) {
        const existing = database.prepare('SELECT id FROM worker_tasks WHERE idempotency_key = ?').get(options.idempotencyKey)
        if (existing && typeof existing.id === 'string') return existing.id
      }
      const id = options.taskId ?? this.nextId(database, 'worker-task')
      if (database.prepare('SELECT id FROM worker_tasks WHERE id = ?').get(id)) throw new Error(`WORKER_TASK_ALREADY_EXISTS:${id}`)
      database.prepare('INSERT INTO worker_tasks (id, payload, state, attempt, lease_ms, idempotency_key) VALUES (?, ?, \'queued\', 0, ?, ?)').run(id, JSON.stringify(payload), leaseMs, options.idempotencyKey ?? null)
      return id
    })
    const result = this.ensureDeferred(taskId)
    if (options.signal) {
      if (options.signal.aborted) this.cancel(taskId)
      else options.signal.addEventListener('abort', () => this.cancel(taskId), { once: true })
    }
    this.pump()
    return result.promise
  }

  claim(workerId: string, now = Date.now()): WorkerLease | undefined {
    if (!this.handlers.has(workerId) && !this.remoteWorkers.has(workerId)) throw new Error(`UNKNOWN_WORKER:${workerId}`)
    const active = this.activeLeases.get(workerId)
    if (active) {
      const activeTask = this.getByLease(workerId, active.leaseId)
      if (activeTask?.leaseExpiresAt !== undefined && activeTask.leaseExpiresAt > now) return undefined
      active.controller.abort()
      this.activeLeases.delete(workerId)
    }
    const lease = this.withTransaction((database) => {
      const row = database.prepare('SELECT id FROM worker_tasks WHERE state = \'queued\' OR (state = \'leased\' AND lease_expires_at <= ?) ORDER BY CASE WHEN state = \'queued\' THEN 0 ELSE 1 END, id LIMIT 1').get(now)
      if (!row || typeof row.id !== 'string') return undefined
      const leaseId = this.nextId(database, 'worker-lease')
      const changed = database.prepare('UPDATE worker_tasks SET state = \'leased\', attempt = attempt + 1, lease_id = ?, worker_id = ?, lease_expires_at = ? WHERE id = ? AND (state = \'queued\' OR (state = \'leased\' AND lease_expires_at <= ?))').run(leaseId, workerId, now + this.leaseMs(database, row.id), row.id, now)
      if (this.changedRows(changed) !== 1) return undefined
      return { id: row.id, leaseId }
    })
    if (!lease) return undefined
    const controller = new AbortController()
    this.activeLeases.set(workerId, { leaseId: lease.leaseId, controller })
    const task = this.get(lease.id)
    if (!task) return undefined
    return { workerId, leaseId: lease.leaseId, task }
  }

  renewLease(workerId: string, leaseId: string, now = Date.now(), leaseMs?: number): number | undefined {
    const expiresAt = this.withTransaction((database) => {
      const task = database.prepare('SELECT lease_ms FROM worker_tasks WHERE id IN (SELECT id FROM worker_tasks WHERE worker_id = ? AND lease_id = ? AND state = \'leased\' AND lease_expires_at > ?)').get(workerId, leaseId, now)
      if (!task) return undefined
      const duration = leaseMs ?? (typeof task.lease_ms === 'number' ? task.lease_ms : 30_000)
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('INVALID_WORKER_LEASE')
      const changed = database.prepare('UPDATE worker_tasks SET lease_expires_at = ?, lease_ms = ? WHERE worker_id = ? AND lease_id = ? AND state = \'leased\' AND lease_expires_at > ?').run(now + duration, duration, workerId, leaseId, now)
      return this.changedRows(changed) === 1 ? now + duration : undefined
    })
    return expiresAt
  }

  completeRemote(workerId: string, leaseId: string, value: JsonValue, now = Date.now()): boolean {
    const taskId = this.taskIdForLease(workerId, leaseId)
    const changed = this.withTransaction((database) => database.prepare('UPDATE worker_tasks SET state = \'succeeded\', result = ?, lease_id = NULL, worker_id = NULL, lease_expires_at = NULL WHERE worker_id = ? AND lease_id = ? AND state = \'leased\' AND lease_expires_at > ?').run(JSON.stringify(value), workerId, leaseId, now))
    if (this.changedRows(changed) !== 1) return false
    this.activeLeases.get(workerId)?.controller.abort()
    this.activeLeases.delete(workerId)
    this.deferreds.get(taskId ?? '')?.resolve(value)
    this.pump()
    return true
  }

  failRemote(workerId: string, leaseId: string, error: RuntimeError, now = Date.now()): boolean {
    const taskId = this.taskIdForLease(workerId, leaseId)
    const changed = this.withTransaction((database) => database.prepare('UPDATE worker_tasks SET state = \'failed\', error = ?, lease_id = NULL, worker_id = NULL, lease_expires_at = NULL WHERE worker_id = ? AND lease_id = ? AND state = \'leased\' AND lease_expires_at > ?').run(JSON.stringify(error), workerId, leaseId, now))
    if (this.changedRows(changed) !== 1) return false
    this.activeLeases.get(workerId)?.controller.abort()
    this.activeLeases.delete(workerId)
    if (taskId) this.deferreds.get(taskId)?.reject(new Error(error.message))
    this.pump()
    return true
  }

  get(taskId: string): WorkerTaskRecord | undefined {
    const row = this.open().prepare('SELECT * FROM worker_tasks WHERE id = ?').get(taskId)
    return row ? this.rowToTask(row) : undefined
  }

  inspect(): WorkerTaskRecord[] { return this.open().prepare('SELECT * FROM worker_tasks ORDER BY id').all().map((row) => this.rowToTask(row)) }

  cancel(taskId: string, reason = 'WORKER_CANCELLED'): boolean {
    const task = this.get(taskId)
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.state)) return false
    const changed = this.withTransaction((database) => database.prepare('UPDATE worker_tasks SET state = \'cancelled\', lease_id = NULL, worker_id = NULL, lease_expires_at = NULL WHERE id = ? AND state NOT IN (\'succeeded\', \'failed\', \'cancelled\')').run(taskId))
    if (this.changedRows(changed) !== 1) return false
    if (task.workerId) {
      this.activeLeases.get(task.workerId)?.controller.abort()
      this.activeLeases.delete(task.workerId)
    }
    this.deferreds.get(taskId)?.reject(new Error(reason))
    this.pump()
    return true
  }

  recoverExpired(now = Date.now()): string[] {
    const ids = this.withTransaction((database) => {
      const rows = database.prepare('SELECT id, worker_id FROM worker_tasks WHERE state = \'leased\' AND lease_expires_at <= ?').all(now)
      database.prepare('UPDATE worker_tasks SET state = \'queued\', lease_id = NULL, worker_id = NULL, lease_expires_at = NULL WHERE state = \'leased\' AND lease_expires_at <= ?').run(now)
      return rows.map((row) => {
        if (typeof row.worker_id === 'string') {
          this.activeLeases.get(row.worker_id)?.controller.abort()
          this.activeLeases.delete(row.worker_id)
        }
        return row.id
      }).filter((id): id is string => typeof id === 'string')
    })
    this.pump()
    return ids
  }

  close(): void {
    for (const watcher of this.watchers.values()) clearInterval(watcher)
    this.watchers.clear()
    this.database?.close()
    this.database = undefined
  }

  private pump(): void {
    for (const [workerId, handler] of this.handlers) {
      const lease = this.claim(workerId)
      if (!lease) continue
      const controller = this.activeLeases.get(workerId)?.controller
      if (!controller) continue
      void handler(lease.task.payload, controller.signal).then((value) => this.completeRemote(workerId, lease.leaseId, value)).catch((cause) => this.failRemote(workerId, lease.leaseId, runtimeError(cause)))
    }
  }

  private ensureDeferred(taskId: string): Deferred {
    const existing = this.deferreds.get(taskId)
    if (existing) return existing
    const result = deferred()
    this.deferreds.set(taskId, result)
    const task = taskId ? this.get(taskId) : undefined
    if (task?.state === 'succeeded') result.resolve(task.result ?? null)
    else if (task?.state === 'failed') result.reject(new Error(task.error?.message ?? 'WORKER_FAILED'))
    else if (task?.state === 'cancelled') result.reject(new Error('WORKER_CANCELLED'))
    else this.watch(taskId, result)
    return result
  }

  private watch(taskId: string, result: Deferred): void {
    if (this.watchers.has(taskId)) return
    const watcher = setInterval(() => {
      const task = this.get(taskId)
      if (!task || (task.state !== 'succeeded' && task.state !== 'failed' && task.state !== 'cancelled')) return
      const timer = this.watchers.get(taskId)
      if (timer) clearInterval(timer)
      this.watchers.delete(taskId)
      if (task.state === 'succeeded') result.resolve(task.result ?? null)
      else if (task.state === 'failed') result.reject(new Error(task.error?.message ?? 'WORKER_FAILED'))
      else result.reject(new Error('WORKER_CANCELLED'))
    }, 10)
    watcher.unref()
    this.watchers.set(taskId, watcher)
  }

  private taskIdForLease(workerId: string, leaseId: string): string | undefined {
    const row = this.open().prepare('SELECT id FROM worker_tasks WHERE worker_id = ? AND lease_id = ?').get(workerId, leaseId)
    return row && typeof row.id === 'string' ? row.id : undefined
  }

  private getByLease(workerId: string, leaseId: string): WorkerTaskRecord | undefined {
    const row = this.open().prepare('SELECT * FROM worker_tasks WHERE worker_id = ? AND lease_id = ? AND state = \'leased\'').get(workerId, leaseId)
    return row ? this.rowToTask(row) : undefined
  }

  private requeueWorker(workerId: string): void {
    this.withTransaction((database) => { database.prepare('UPDATE worker_tasks SET state = \'queued\', lease_id = NULL, worker_id = NULL, lease_expires_at = NULL WHERE worker_id = ? AND state = \'leased\'').run(workerId); return undefined })
  }

  private nextId(database: DistributedWorkerSqliteDatabase, prefix: string): string {
    const row = database.prepare('SELECT value FROM worker_sequence WHERE id = 1').get()
    const sequence = typeof row?.value === 'number' ? row.value : 1
    database.prepare('UPDATE worker_sequence SET value = ? WHERE id = 1').run(sequence + 1)
    return `${prefix}-${sequence}`
  }

  private leaseMs(database: DistributedWorkerSqliteDatabase, taskId: string): number {
    const row = database.prepare('SELECT lease_ms FROM worker_tasks WHERE id = ?').get(taskId)
    return typeof row?.lease_ms === 'number' ? row.lease_ms : 30_000
  }

  private rowToTask(row: Record<string, unknown>): WorkerTaskRecord {
    const task: WorkerTaskRecord = { id: String(row.id), payload: JSON.parse(String(row.payload)) as JsonValue, state: String(row.state) as WorkerTaskRecord['state'], attempt: Number(row.attempt), leaseMs: Number(row.lease_ms) }
    if (typeof row.lease_id === 'string') task.leaseId = row.lease_id
    if (typeof row.worker_id === 'string') task.workerId = row.worker_id
    if (typeof row.lease_expires_at === 'number') task.leaseExpiresAt = row.lease_expires_at
    if (typeof row.idempotency_key === 'string') task.idempotencyKey = row.idempotency_key
    if (typeof row.result === 'string') task.result = JSON.parse(row.result) as JsonValue
    if (typeof row.error === 'string') task.error = JSON.parse(row.error) as RuntimeError
    return task
  }

  private changedRows(result: unknown): number { return typeof result === 'object' && result !== null && typeof (result as { changes?: unknown }).changes === 'number' ? (result as { changes: number }).changes : 0 }

  private open(): DistributedWorkerSqliteDatabase {
    if (this.database) return this.database
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: WorkerSqliteDatabaseConstructor }
    this.database = new DatabaseSync(this.filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS worker_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT OR IGNORE INTO worker_sequence (id, value) VALUES (1, 1); CREATE TABLE IF NOT EXISTS worker_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, lease_id TEXT, worker_id TEXT, lease_expires_at INTEGER, lease_ms INTEGER NOT NULL, idempotency_key TEXT UNIQUE, result TEXT, error TEXT)')
    return this.database
  }

  private withTransaction<T>(work: (database: DistributedWorkerSqliteDatabase) => T): T {
    const database = this.open()
    database.exec('BEGIN IMMEDIATE')
    try { const result = work(database); database.exec('COMMIT'); return result }
    catch (cause) { try { database.exec('ROLLBACK') } catch { /* transaction already closed */ } throw cause }
  }
}

export function createWorkerEffectExecutor(coordinator: Pick<WorkerCoordinatorContract, 'submit'>, options: { leaseMs?: number } = {}): (effect: Readonly<EffectRecord>, signal: AbortSignal) => Promise<EffectExecution> {
  return async (effect, signal) => {
    const value = await coordinator.submit({ effectId: effect.id, attemptId: effect.attemptId, kind: effect.kind, input: effect.input }, { taskId: `${effect.id}:${effect.attemptId}`, idempotencyKey: effect.idempotencyKey ?? `${effect.id}:${effect.attemptId}`, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }), signal })
    return { value, executionState: 'succeeded', sideEffectState: 'none' }
  }
}
