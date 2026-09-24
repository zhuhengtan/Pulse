import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 1_000
export const MAX_SCHEDULED_TASK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_STORE_BYTES = 8 * 1024 * 1024
const MAX_TASKS = 1_000
const CLAIM_LEASE_MS = 60_000
const EXECUTION_TIMEOUT_MS = 15 * 60_000

const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workspace: z.string().refine(isAbsolute).optional(),
  instruction: z.string().trim().min(1).max(10_000),
  intervalMs: z.number().int().min(MIN_SCHEDULED_TASK_INTERVAL_MS).max(MAX_SCHEDULED_TASK_INTERVAL_MS),
}).strict()

const errorSchema = z.object({ code: z.string().min(1).max(80), message: z.string().max(500) }).strict()
const runRecordSchema = z.object({
  id: z.string().uuid(),
  ownerPid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  scheduledFor: z.number().int().nonnegative(),
  leaseExpiresAt: z.number().int().nonnegative().optional(),
  quarantined: z.boolean().optional(),
}).strict()
const lastRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  status: z.enum(['succeeded', 'failed', 'interrupted']),
  error: errorSchema.optional(),
}).strict()
const taskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  workspace: z.string().refine(isAbsolute).optional(),
  instruction: z.string().min(1).max(10_000),
  intervalMs: z.number().int().min(MIN_SCHEDULED_TASK_INTERVAL_MS).max(MAX_SCHEDULED_TASK_INTERVAL_MS),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  nextRunAt: z.number().int().nonnegative(),
  paused: z.boolean(),
  runCount: z.number().int().nonnegative(),
  run: runRecordSchema.optional(),
  lastRun: lastRunSchema.optional(),
}).strict()
const storeSchema = z.object({ schemaVersion: z.literal(1), tasks: z.array(taskSchema).max(MAX_TASKS) }).strict()

export type ScheduledTask = z.infer<typeof taskSchema>
export type CreateScheduledTaskInput = z.infer<typeof scheduleInputSchema>
export type ScheduledTaskRunError = z.infer<typeof errorSchema>
export type ScheduledTaskRunStatus = z.infer<typeof lastRunSchema>['status']

export interface ScheduledTaskStoreOptions {
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  lockTimeoutMs?: number
  lockPollMs?: number
  /** Injectable rename primitive for cross-platform replacement tests. */
  renameFile?: typeof rename
}

function taskError(code: string, cause?: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  return Object.assign(new Error(code), { code, retryable: false, ...(cause === undefined ? {} : { cause }) })
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function advancePast(nextRunAt: number, intervalMs: number, now: number): number {
  if (nextRunAt > now) return nextRunAt
  const intervals = Math.floor((now - nextRunAt) / intervalMs) + 1
  return nextRunAt + intervals * intervalMs
}

function sanitizedError(error: unknown): ScheduledTaskRunError {
  const record = error !== null && typeof error === 'object' ? error as { code?: unknown; message?: unknown; name?: unknown } : undefined
  const rawCode = typeof record?.code === 'string' ? record.code : typeof record?.name === 'string' ? record.name : 'SCHEDULED_TASK_FAILED'
  const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Scheduled task execution failed.'
  const code = rawCode.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'SCHEDULED_TASK_FAILED'
  const message = rawMessage
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|BEARER|COOKIE)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 500)
  return { code, message }
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return structuredClone(task)
}

export class ScheduledTaskStore {
  readonly filePath: string
  private readonly lockPath: string
  private readonly now: () => number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly lockTimeoutMs: number
  private readonly lockPollMs: number
  private readonly renameFile: typeof rename
  private tail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: ScheduledTaskStoreOptions = {}) {
    this.filePath = resolve(filePath)
    this.lockPath = `${this.filePath}.lock`
    this.now = options.now ?? Date.now
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000
    this.lockPollMs = options.lockPollMs ?? 10
    this.renameFile = options.renameFile ?? rename
  }

  async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const parsed = scheduleInputSchema.safeParse(input)
    if (!parsed.success) throw taskError('INVALID_SCHEDULED_TASK_INPUT', parsed.error)
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      await this.recoverInterrupted(document)
      if (document.tasks.length >= MAX_TASKS) throw taskError('SCHEDULED_TASK_LIMIT_REACHED')
      const now = this.timestamp()
      const task: ScheduledTask = {
        schemaVersion: 1,
        id: randomUUID(),
        ...parsed.data,
        workspace: parsed.data.workspace ?? resolve(process.cwd()),
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + parsed.data.intervalMs,
        paused: false,
        runCount: 0,
      }
      document.tasks.push(task)
      await this.saveUnlocked(document)
      return cloneTask(task)
    })
  }

  async list(): Promise<ScheduledTask[]> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const recovered = await this.recoverInterrupted(document)
      if (recovered) await this.saveUnlocked(document)
      return document.tasks.map(cloneTask).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    })
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const recovered = await this.recoverInterrupted(document)
      if (recovered) await this.saveUnlocked(document)
      const task = document.tasks.find((candidate) => candidate.id === id)
      return task ? cloneTask(task) : undefined
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const recovered = await this.recoverInterrupted(document)
      const index = document.tasks.findIndex((task) => task.id === id)
      if (index < 0) { if (recovered) await this.saveUnlocked(document); return false }
      if (document.tasks[index]?.run) throw taskError('SCHEDULED_TASK_STILL_RUNNING')
      document.tasks.splice(index, 1)
      await this.saveUnlocked(document)
      return true
    })
  }

  async pause(id: string, paused = true): Promise<ScheduledTask | undefined> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const recovered = await this.recoverInterrupted(document)
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (!task) { if (recovered) await this.saveUnlocked(document); return undefined }
      if (task.paused !== paused) {
        task.paused = paused
        task.updatedAt = this.timestamp()
        await this.saveUnlocked(document)
      } else if (recovered) await this.saveUnlocked(document)
      return cloneTask(task)
    })
  }

  async claimDue(limit = 1, now = this.timestamp()): Promise<ScheduledTask[]> {
    if (limit !== 1) throw taskError('INVALID_SCHEDULED_TASK_CLAIM_LIMIT')
    if (!Number.isSafeInteger(now) || now < 0) throw taskError('INVALID_SCHEDULED_TASK_CLOCK')
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const recovered = await this.recoverInterrupted(document)
      // This store deliberately permits one running task at a time across all
      // workers/processes. The lock + durable run claim prevents duplicate runs.
      if (document.tasks.some((task) => task.run)) {
        if (recovered) await this.saveUnlocked(document)
        return []
      }
      const due = document.tasks
        .filter((task) => !task.paused && !task.run && task.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(0, 1)
      if (due.length === 0) { if (recovered) await this.saveUnlocked(document); return [] }
      for (const task of due) {
        const runId = randomUUID()
        task.run = { id: runId, ownerPid: process.pid, startedAt: now, scheduledFor: task.nextRunAt, leaseExpiresAt: now + CLAIM_LEASE_MS }
        task.nextRunAt = advancePast(task.nextRunAt, task.intervalMs, now)
        task.updatedAt = now
        task.runCount++
      }
      await this.saveUnlocked(document)
      return due.map(cloneTask)
    })
  }

  async renew(id: string, runId: string, now = this.timestamp()): Promise<boolean> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (!task?.run || task.run.id !== runId) return false
      task.run.leaseExpiresAt = now + CLAIM_LEASE_MS
      task.updatedAt = now
      await this.saveUnlocked(document)
      return true
    })
  }

  async quarantine(id: string, runId: string): Promise<boolean> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (!task?.run || task.run.id !== runId) return false
      task.run.quarantined = true
      task.updatedAt = this.timestamp()
      await this.saveUnlocked(document)
      return true
    })
  }

  /** Explicit operator recovery after confirming all detached side effects stopped. */
  async recoverQuarantined(id: string, runId: string): Promise<ScheduledTask | undefined> {
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (!task?.run || task.run.id !== runId || !task.run.quarantined) return undefined
      const { run } = task
      const now = this.timestamp()
      task.lastRun = { id: run.id, startedAt: run.startedAt, finishedAt: now, status: 'interrupted', error: { code: 'OPERATOR_RECOVERED_QUARANTINED_RUN', message: 'An operator confirmed the previous execution and its child processes have stopped.' } }
      delete task.run
      task.nextRunAt = advancePast(task.nextRunAt, task.intervalMs, now)
      task.updatedAt = now
      await this.saveUnlocked(document)
      return cloneTask(task)
    })
  }

  async finish(id: string, runId: string, status: Exclude<ScheduledTaskRunStatus, 'interrupted'>, error?: ScheduledTaskRunError, now = this.timestamp()): Promise<ScheduledTask | undefined> {
    if (status === 'failed' && error === undefined) throw taskError('SCHEDULED_TASK_FAILURE_REQUIRES_ERROR')
    return this.withLock(async () => {
      const document = await this.loadUnlocked()
      const recovered = await this.recoverInterrupted(document)
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (!task) { if (recovered) await this.saveUnlocked(document); return undefined }
      if (!task.run || task.run.id !== runId) throw taskError('SCHEDULED_TASK_RUN_MISMATCH')
      const { run } = task
      const finishedAt = Math.max(now, run.startedAt)
      task.lastRun = { id: run.id, startedAt: run.startedAt, finishedAt, status, ...(error === undefined ? {} : { error: errorSchema.parse(error) }) }
      delete task.run
      task.nextRunAt = advancePast(task.nextRunAt, task.intervalMs, finishedAt)
      task.updatedAt = finishedAt
      await this.saveUnlocked(document)
      return cloneTask(task)
    })
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw taskError('INVALID_SCHEDULED_TASK_CLOCK')
    return value
  }

  private async recoverInterrupted(document: z.infer<typeof storeSchema>): Promise<boolean> {
    const now = this.timestamp()
    let changed = false
    for (const task of document.tasks) {
      if (!task.run) continue
      if (task.run.quarantined) continue
      // Lease expiry is not proof that side effects stopped. Fail closed while
      // the owner is alive (including an ambiguous reused PID).
      if (this.isProcessAlive(task.run.ownerPid)) continue
      const { run } = task
      task.lastRun = { id: run.id, startedAt: run.startedAt, finishedAt: now, status: 'interrupted', error: { code: 'WORKER_PROCESS_EXITED', message: 'The worker stopped before recording a result; the next interval remains scheduled.' } }
      delete task.run
      task.nextRunAt = advancePast(task.nextRunAt, task.intervalMs, now)
      task.updatedAt = now
      changed = true
    }
    return changed
  }

  private async loadUnlocked(): Promise<z.infer<typeof storeSchema>> {
    const backupPath = `${this.filePath}.bak`
    const mainExists = await stat(this.filePath).then(() => true, () => false)
    if (!mainExists) await this.renameFile(backupPath, this.filePath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    else await rm(backupPath, { force: true }).catch(() => undefined)
    let body: string
    try {
      const info = await stat(this.filePath)
      if (info.size > MAX_STORE_BYTES) throw taskError('SCHEDULED_TASK_STORE_TOO_LARGE')
      body = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, tasks: [] }
      throw error instanceof Error && 'code' in error ? error : taskError('SCHEDULED_TASK_STORE_READ_FAILED', error)
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES) throw taskError('SCHEDULED_TASK_STORE_TOO_LARGE')
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch (cause) { throw taskError('SCHEDULED_TASK_STORE_INVALID_JSON', cause) }
    const result = storeSchema.safeParse(parsed)
    if (!result.success) throw taskError('SCHEDULED_TASK_STORE_SCHEMA_INVALID', result.error)
    if (new Set(result.data.tasks.map((task) => task.id)).size !== result.data.tasks.length) throw taskError('SCHEDULED_TASK_STORE_DUPLICATE_ID')
    return result.data
  }

  private async saveUnlocked(document: z.infer<typeof storeSchema>): Promise<void> {
    const parsed = storeSchema.safeParse(document)
    if (!parsed.success) throw taskError('SCHEDULED_TASK_STORE_SCHEMA_INVALID', parsed.error)
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`
    if (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES) throw taskError('SCHEDULED_TASK_STORE_TOO_LARGE')
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(body, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      const backupPath = `${this.filePath}.bak`
      const hasExistingFile = await stat(this.filePath).then(() => true, () => false)
      if (hasExistingFile) await this.renameFile(this.filePath, backupPath)
      try { await this.renameFile(temporaryPath, this.filePath) }
      catch (cause) {
        if (hasExistingFile) await this.renameFile(backupPath, this.filePath).catch(() => undefined)
        throw cause
      }
      if (hasExistingFile) await rm(backupPath, { force: true })
      const directory = await open(dirname(this.filePath), 'r').catch(() => undefined)
      if (directory) { await directory.sync().catch(() => undefined); await directory.close().catch(() => undefined) }
    } catch (cause) {
      throw taskError('SCHEDULED_TASK_STORE_WRITE_FAILED', cause)
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const inProcess = this.tail.then(() => this.withFileLock(work), () => this.withFileLock(work))
    this.tail = inProcess.then(() => undefined, () => undefined)
    return inProcess
  }

  private async withFileLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const deadline = Date.now() + this.lockTimeoutMs
    const token = randomUUID()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (!handle) {
      try {
        handle = await open(this.lockPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8')
        await handle.sync()
      } catch (cause) {
        const createdByUs = handle !== undefined
        await handle?.close().catch(() => undefined)
        handle = undefined
        if (createdByUs) {
          await rm(this.lockPath, { force: true }).catch(() => undefined)
          throw taskError('SCHEDULED_TASK_LOCK_FAILED', cause)
        }
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw taskError('SCHEDULED_TASK_LOCK_FAILED', cause)
        const body = await readFile(this.lockPath, 'utf8').catch(() => undefined)
        let owner: { pid?: unknown; token?: unknown } | undefined
        try { owner = body ? JSON.parse(body) as { pid?: unknown; token?: unknown } : undefined } catch { owner = undefined }
        const lockStat = await stat(this.lockPath).catch(() => undefined)
        const stale = typeof owner?.pid === 'number'
          ? !this.isProcessAlive(owner.pid)
          : lockStat !== undefined && Date.now() - lockStat.mtimeMs > 30_000
        if (stale) {
          const current = await readFile(this.lockPath, 'utf8').catch(() => undefined)
          if (current === body) { await rm(this.lockPath, { force: true }); continue }
        }
        if (Date.now() >= deadline) throw taskError('SCHEDULED_TASK_LOCK_TIMEOUT')
        await new Promise((resolve) => setTimeout(resolve, this.lockPollMs))
      }
    }
    try { return await work() } finally {
      await handle.close().catch(() => undefined)
      const body = await readFile(this.lockPath, 'utf8').catch(() => undefined)
      try {
        const owner = body ? JSON.parse(body) as { token?: unknown } : undefined
        if (owner?.token === token) await rm(this.lockPath, { force: true })
      } catch { /* an unrecognized lock is left for the next stale-lock check */ }
    }
  }
}

export interface ScheduledTaskWorkerOptions {
  pollIntervalMs?: number
  executionTimeoutMs?: number
  cancellationGraceMs?: number
}

export interface ScheduledTaskWorkerRunSummary { claimed: number; succeeded: number; failed: number }

/** Resolve/reject only after all owned side effects have stopped. If that cannot
 * be confirmed, reject with code SCHEDULED_TASK_CANCELLATION_UNCONFIRMED. */
export type ScheduledTaskExecutor = (task: Readonly<ScheduledTask>, signal: AbortSignal) => Promise<unknown>

export class ScheduledTaskWorker {
  private readonly pollIntervalMs: number
  private readonly executionTimeoutMs: number
  private readonly cancellationGraceMs: number

  constructor(private readonly store: ScheduledTaskStore, private readonly execute: ScheduledTaskExecutor, options: ScheduledTaskWorkerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.cancellationGraceMs = options.cancellationGraceMs ?? 1_000
    if (!Number.isInteger(this.cancellationGraceMs) || this.cancellationGraceMs < 1 || this.cancellationGraceMs > 60_000) throw taskError('INVALID_SCHEDULED_TASK_CANCELLATION_GRACE')
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS
    if (!Number.isInteger(this.executionTimeoutMs) || this.executionTimeoutMs < 100 || this.executionTimeoutMs > 24 * 60 * 60_000) throw taskError('INVALID_SCHEDULED_TASK_EXECUTION_TIMEOUT')
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 100 || this.pollIntervalMs > 60_000) throw taskError('INVALID_SCHEDULED_TASK_POLL_INTERVAL')
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<ScheduledTaskWorkerRunSummary> {
    const summary: ScheduledTaskWorkerRunSummary = { claimed: 0, succeeded: 0, failed: 0 }
    while (!signal.aborted) {
      const [task] = await this.store.claimDue(1)
      if (!task?.run) break
      summary.claimed++
      const executionController = new AbortController()
      const heartbeat = setInterval(() => { void this.store.renew(task.id, task.run!.id).then((ok) => { if (!ok) executionController.abort(new Error('SCHEDULED_TASK_LEASE_LOST')) }, () => executionController.abort(new Error('SCHEDULED_TASK_LEASE_RENEWAL_FAILED'))) }, Math.floor(CLAIM_LEASE_MS / 3))
      let timeout: NodeJS.Timeout | undefined
      let rejectAbort: ((error: Error) => void) | undefined
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
      const abortExecution = (): void => { executionController.abort(signal.reason); rejectAbort?.(taskError('SCHEDULED_RUN_ABORTED')) }
      signal.addEventListener('abort', abortExecution, { once: true })
      executionController.signal.addEventListener('abort', () => rejectAbort?.(taskError('SCHEDULED_RUN_ABORTED')), { once: true })
      let settled = false
      let executionError: unknown
      const execution = Promise.resolve().then(() => {
        if (executionController.signal.aborted) throw taskError('SCHEDULED_RUN_ABORTED')
        return this.execute(task, executionController.signal)
      }).catch((error: unknown) => { executionError = error; throw error }).finally(() => { settled = true })
      if (signal.aborted) abortExecution()
      try {
        await Promise.race([execution, aborted, new Promise<never>((_, reject) => { timeout = setTimeout(() => { reject(taskError('SCHEDULED_TASK_EXECUTION_TIMEOUT')); executionController.abort(new Error('SCHEDULED_TASK_EXECUTION_TIMEOUT')) }, this.executionTimeoutMs) })])
        const completed = await this.store.finish(task.id, task.run.id, 'succeeded')
        if (completed) summary.succeeded++
      } catch (error) {
        executionController.abort(error)
        if (!settled) {
          let grace: NodeJS.Timeout | undefined
          try {
            await Promise.race([execution.catch(() => undefined), new Promise<void>((resolve) => { grace = setTimeout(resolve, this.cancellationGraceMs) })])
          } finally { if (grace) clearTimeout(grace) }
        }
        // Do not release durable ownership or dispatch more work if cancellation
        // is unconfirmed. The owner must stop before another worker can recover.
        if (!settled || (error as { code?: string } | null)?.code === 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' || (executionError as { code?: string } | null)?.code === 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED') {
          await this.store.quarantine(task.id, task.run.id)
          throw taskError('SCHEDULED_TASK_CANCELLATION_UNCONFIRMED', error)
        }
        const failure = sanitizedError(error)
        const completed = await this.store.finish(task.id, task.run.id, 'failed', failure)
        if (completed) summary.failed++
      } finally {
        if (timeout) clearTimeout(timeout)
        clearInterval(heartbeat)
        signal.removeEventListener('abort', abortExecution)
      }
    }
    return summary
  }

  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runOnce(signal)
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const done = (): void => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        if (signal.aborted) { done(); return }
        timer = setTimeout(done, this.pollIntervalMs)
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
}
