import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type Database = { exec(sql: string): void; prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown }; close(): void }
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Database }
export type AdmissionStatus = 'queued' | 'starting' | 'running' | 'cancelling' | 'quarantined' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type AdmissionOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** Evidence only: PID, boot changes and elapsed time never release capacity. */
export interface AdmissionProcessIdentity { pid: number; bootId?: string; startedAt?: string; processGroupId?: number }
export interface AdmissionInput { jobId: string; conversationKey: string; projectKey: string; ownerToken: string; metadata?: Record<string, string | number | boolean | null> }
export interface AdmissionRecord extends AdmissionInput { sequence: number; status: AdmissionStatus; createdAt: number; updatedAt: number; processIdentity?: AdmissionProcessIdentity; reason?: string }
export interface HostTaskAdmissionOptions { directory?: string; maxRunning?: number; maxQueued?: number; maxTerminal?: number }
interface State { version: 1; sequence: number; lastProject: string | null; limits: { maxRunning: number; maxQueued: number; maxTerminal: number }; jobs: AdmissionRecord[] }
export class AdmissionError extends Error {
  constructor(readonly code: 'HOST_TASK_QUEUE_FULL' | 'CONVERSATION_BUSY' | 'REQUEST_ID_REUSED' | 'NOT_FOUND' | 'OWNER_MISMATCH' | 'INVALID_TRANSITION' | 'CONFIGURATION_MISMATCH' | 'STALE_ADMISSION', message: string) { super(message); this.name = 'AdmissionError' }
}
export const defaultHostTaskAdmissionDirectory = () => join(homedir(), '.pulse', 'host-admission')
const terminal = (status: AdmissionStatus) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
const occupied = (status: AdmissionStatus) => status !== 'queued' && !terminal(status)
const validateLimits = (options: Pick<HostTaskAdmissionOptions, 'maxRunning' | 'maxQueued'>) => {
  for (const key of ['maxRunning', 'maxQueued'] as const) {
    const value = options[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'maxRunning' ? 1 : 0) || value > (key === 'maxRunning' ? 16 : 256))) throw new TypeError(`Invalid ${key}`)
  }
}
const canonical = (value: AdmissionInput['metadata']) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)))

/** Same-user durable host ledger independent of dataDir/PULSE_HOME. SQLite owns
 * locking and crash recovery: no TTL stealing, no implicit lease reclamation.
 * Only launch after claim succeeds. Closing this object never releases jobs. */
export class HostTaskAdmissionStore {
  readonly directory: string
  private readonly db: Database
  constructor(options: HostTaskAdmissionOptions = {}) {
    validateLimits(options)
    this.directory = resolve(options.directory ?? defaultHostTaskAdmissionDirectory())
    for (const key of ['maxRunning', 'maxQueued', 'maxTerminal'] as const) {
      const value = options[key]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'maxRunning' ? 1 : 0))) throw new TypeError(`Invalid ${key}`)
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(this.directory, 'admission.sqlite'))
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS host_admission (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const row = this.db.prepare('SELECT state FROM host_admission WHERE id=1').get() as { state: string } | undefined
        if (!row) {
          const initial: State = { version: 1, sequence: 0, lastProject: null, limits: { maxRunning: options.maxRunning ?? 2, maxQueued: options.maxQueued ?? 32, maxTerminal: options.maxTerminal ?? 256 }, jobs: [] }
          this.db.prepare('INSERT INTO host_admission(id,state) VALUES(1,?)').run(JSON.stringify(initial))
        } else {
          const state = this.decode(row.state)
          for (const key of ['maxRunning', 'maxQueued', 'maxTerminal'] as const) if (options[key] !== undefined && options[key] !== state.limits[key]) throw new AdmissionError('CONFIGURATION_MISMATCH', `Host admission ${key} is already ${state.limits[key]}`)
        }
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) { this.db.close(); throw error }
  }
  private decode(json: string): State {
    const state = JSON.parse(json) as State
    const invalid = () => { throw new Error('Invalid host admission ledger; refusing admission') }
    if (!state || state.version !== 1 || !Array.isArray(state.jobs) || !state.limits) invalid()
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || (state.lastProject !== null && typeof state.lastProject !== 'string')) invalid()
    if (typeof state.limits.maxRunning !== 'number' || typeof state.limits.maxQueued !== 'number') invalid()
    try { validateLimits(state.limits) } catch { invalid() }
    if (!Number.isSafeInteger(state.limits.maxTerminal) || state.limits.maxTerminal < 0) invalid()
    const ids = new Set<string>(), sequences = new Set<number>()
    for (const job of state.jobs) {
      if (!job || !['queued', 'starting', 'running', 'cancelling', 'quarantined', 'completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) invalid()
      for (const key of ['jobId', 'conversationKey', 'projectKey', 'ownerToken'] as const) if (typeof job[key] !== 'string' || !job[key].trim()) invalid()
      if (ids.has(job.jobId) || sequences.has(job.sequence) || !Number.isSafeInteger(job.sequence) || job.sequence <= 0 || job.sequence > state.sequence) invalid()
      if (!Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt) || job.createdAt < 0 || job.updatedAt < job.createdAt) invalid()
      if (job.metadata !== undefined && (!job.metadata || typeof job.metadata !== 'object' || Array.isArray(job.metadata) || Object.values(job.metadata).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) invalid()
      ids.add(job.jobId); sequences.add(job.sequence)
    }
    return state
  }
  private read(): State { return this.decode((this.db.prepare('SELECT state FROM host_admission WHERE id=1').get() as { state: string }).state) }
  private transaction<T>(change: (state: State) => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.read(), result = change(state)
      const finished = state.jobs.filter(job => terminal(job.status)).sort((a, b) => b.updatedAt - a.updatedAt || b.sequence - a.sequence)
      const keep = new Set(finished.slice(0, state.limits.maxTerminal).map(job => job.jobId))
      state.jobs = state.jobs.filter(job => !terminal(job.status) || keep.has(job.jobId))
      this.db.prepare('UPDATE host_admission SET state=? WHERE id=1').run(JSON.stringify(state))
      this.db.exec('COMMIT')
      return structuredClone(result)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private job(state: State, id: string, owner?: string): AdmissionRecord {
    const job = state.jobs.find(item => item.jobId === id)
    if (!job) throw new AdmissionError('NOT_FOUND', `Unknown admission job ${id}`)
    if (owner !== undefined && job.ownerToken !== owner) throw new AdmissionError('OWNER_MISMATCH', 'Admission owner does not match')
    return job
  }
  enqueue(input: AdmissionInput): AdmissionRecord {
    for (const key of ['jobId', 'conversationKey', 'projectKey', 'ownerToken'] as const) if (!input[key]?.trim() || input[key].length > 2048) throw new TypeError(`Invalid ${key}`)
    if (canonical(input.metadata).length > 4096) throw new TypeError('Admission metadata exceeds 4096 characters; store summaries only')
    return this.transaction(state => {
      const old = state.jobs.find(job => job.jobId === input.jobId)
      if (old) {
        if (old.ownerToken === input.ownerToken && old.conversationKey === input.conversationKey && old.projectKey === input.projectKey && canonical(old.metadata) === canonical(input.metadata)) return old
        throw new AdmissionError('REQUEST_ID_REUSED', 'Job ID already reserved with different identity or metadata')
      }
      if (state.jobs.some(job => job.conversationKey === input.conversationKey && !terminal(job.status))) throw new AdmissionError('CONVERSATION_BUSY', 'Conversation already has an admitted task')
      if (state.jobs.filter(job => job.status === 'queued').length >= state.limits.maxQueued + Math.max(0, state.limits.maxRunning - state.jobs.filter(job => occupied(job.status)).length)) throw new AdmissionError('HOST_TASK_QUEUE_FULL', 'Host task queue is full')
      const now = Date.now()
      const job: AdmissionRecord = { ...structuredClone(input), sequence: ++state.sequence, status: 'queued', createdAt: now, updatedAt: now }
      state.jobs.push(job); return job
    })
  }
  /** Null means wait. Not idempotent: a second claim must never launch twice. */
  claim(id: string, owner: string): AdmissionRecord | null {
    return this.transaction(state => {
      const job = this.job(state, id, owner)
      if (job.status !== 'queued' || state.jobs.filter(item => occupied(item.status)).length >= state.limits.maxRunning) return null
      const queued = state.jobs.filter(item => item.status === 'queued')
      const projects = [...new Set(queued.map(item => item.projectKey))].sort()
      const project = projects.find(key => state.lastProject === null || key > state.lastProject) ?? projects[0]
      const next = queued.filter(item => item.projectKey === project).sort((a, b) => a.sequence - b.sequence)[0]
      if (next?.jobId !== id) return null
      job.status = 'starting'; job.updatedAt = Math.max(Date.now(), job.updatedAt + 1); state.lastProject = job.projectKey; return job
    })
  }
  markRunning(id: string, owner: string, identity: AdmissionProcessIdentity): AdmissionRecord {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new TypeError('A valid process identity is required')
    return this.transaction(state => {
      const job = this.job(state, id, owner)
      // Cancellation may race spawn: attach evidence without undoing cancellation.
      if (job.status !== 'starting' && job.status !== 'cancelling') throw new AdmissionError('INVALID_TRANSITION', 'Only a starting task can become running')
      if (job.status === 'starting') job.status = 'running'
      job.processIdentity = structuredClone(identity); job.updatedAt = Math.max(Date.now(), job.updatedAt + 1); return job
    })
  }
  cancel(id: string): AdmissionRecord {
    return this.transaction(state => {
      const job = this.job(state, id)
      if (job.status === 'queued') job.status = 'cancelled'
      else if (job.status === 'starting' || job.status === 'running') job.status = 'cancelling'
      job.updatedAt = Math.max(Date.now(), job.updatedAt + 1); return job
    })
  }
  /** Caller confirms no spawn occurred or the entire process tree has closed. */
  release(id: string, owner: string, result: { confirmed: true; outcome: AdmissionOutcome; reason?: string }): AdmissionRecord {
    if (result.confirmed !== true || !terminal(result.outcome)) throw new TypeError('Release requires explicitly confirmed closure and terminal outcome')
    return this.transaction(state => {
      const job = this.job(state, id, owner)
      if (!terminal(job.status)) { job.status = result.outcome; if (result.reason !== undefined) job.reason = result.reason; job.updatedAt = Math.max(Date.now(), job.updatedAt + 1) }
      return job
    })
  }
  quarantine(id: string, reason: string): AdmissionRecord {
    return this.transaction(state => {
      const job = this.job(state, id)
      if (!occupied(job.status)) throw new AdmissionError('INVALID_TRANSITION', 'Only an occupied task can be quarantined')
      job.status = 'quarantined'; job.reason = reason; job.updatedAt = Math.max(Date.now(), job.updatedAt + 1); return job
    })
  }
  /** Only after establishing this specific owner is gone. Never sweep other live owners at startup. */
  reconcileOwner(owner: string): AdmissionRecord[] {
    return this.transaction(state => {
      const jobs = state.jobs.filter(job => job.ownerToken === owner && !terminal(job.status))
      for (const job of jobs) { job.status = job.status === 'queued' ? 'interrupted' : 'quarantined'; job.reason = 'Owner unavailable; process closure unconfirmed'; job.updatedAt = Math.max(Date.now(), job.updatedAt + 1) }
      return jobs
    })
  }
  /** Explicit administrator update; occupied work and queued requests are never evicted. */
  configure(options: Pick<HostTaskAdmissionOptions, 'maxRunning' | 'maxQueued'>) {
    validateLimits(options)
    return this.transaction(state => {
      if (options.maxRunning !== undefined) state.limits.maxRunning = options.maxRunning
      if (options.maxQueued !== undefined) state.limits.maxQueued = options.maxQueued
      return state.limits
    })
  }
  /** Caller must obtain operator confirmation that the entire process tree stopped.
   * CAS rejects a stale review. Recovery never automatically reruns the task. */
  recoverQuarantined(id: string, expectedUpdatedAt: number): AdmissionRecord {
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new TypeError('Invalid expectedUpdatedAt')
    return this.transaction(state => {
      const job = this.job(state, id)
      if (job.status !== 'quarantined') throw new AdmissionError('INVALID_TRANSITION', 'Only a quarantined task can be recovered')
      if (job.updatedAt !== expectedUpdatedAt) throw new AdmissionError('STALE_ADMISSION', 'Admission changed since operator review')
      job.status = 'interrupted'; job.reason = 'Operator confirmed process tree stopped'
      job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
      return job
    })
  }
  get(id: string): AdmissionRecord | undefined { return this.read().jobs.find(job => job.jobId === id) }
  list(): AdmissionRecord[] { return this.read().jobs }
  snapshot() {
    const state = this.read()
    return { ...state.limits, occupied: state.jobs.filter(job => occupied(job.status)).length, queued: state.jobs.filter(job => job.status === 'queued').length, quarantined: state.jobs.filter(job => job.status === 'quarantined').length, jobs: state.jobs }
  }
  close(): void { this.db.close() }
}
