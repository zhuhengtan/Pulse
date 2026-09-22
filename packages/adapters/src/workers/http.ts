import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { isSideEffectful, type EffectExecution, type EffectExecutor, type EffectRecord, type JsonValue, type RuntimeError, type WorkerCoordinatorContract, type WorkerHandler, type WorkerLease, type WorkerSubmitOptions, type WorkerTaskRecord } from '@hunterzhu/pulse-runtime'

interface JsonObject { [key: string]: JsonValue }

function object(value: JsonValue | undefined): JsonObject {
  return value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

async function readBody(request: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += value.byteLength
    if (size > 4 * 1024 * 1024) throw new Error('WORKER_HTTP_BODY_TOO_LARGE')
    chunks.push(value)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue } catch { throw new Error('WORKER_HTTP_INVALID_JSON') }
}

function responseBody(value: JsonValue): string { return JSON.stringify(value) }

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code)
  return value
}

function validWorkerTask(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  if (!requiredField(task.id) || !['queued', 'leased', 'succeeded', 'failed', 'cancelled'].includes(String(task.state)) || !Number.isInteger(task.attempt) || (task.attempt as number) < 0 || task.payload === undefined) return false
  if (task.leaseId !== undefined && !requiredField(task.leaseId)) return false
  if (task.workerId !== undefined && !requiredField(task.workerId)) return false
  if (task.leaseExpiresAt !== undefined && (typeof task.leaseExpiresAt !== 'number' || !Number.isFinite(task.leaseExpiresAt))) return false
  if (task.leaseMs !== undefined && (typeof task.leaseMs !== 'number' || !Number.isFinite(task.leaseMs) || task.leaseMs <= 0)) return false
  if (task.idempotencyKey !== undefined && !requiredField(task.idempotencyKey)) return false
  if (task.error !== undefined && (!task.error || typeof task.error !== 'object' || Array.isArray(task.error) || !requiredField((task.error as Record<string, unknown>).code) || typeof (task.error as Record<string, unknown>).message !== 'string')) return false
  return true
}

function requiredField(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }

function validWorkerLease(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const lease = value as Record<string, unknown>
  return requiredField(lease.workerId) && requiredField(lease.leaseId) && validWorkerTask(lease.task as JsonValue)
}

function send(response: import('node:http').ServerResponse, status: number, value: JsonValue): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(responseBody(value))
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }

function workerHttpError(code: string, status?: number): Error & { code: string; retryable: boolean } {
  const retryable = status === undefined ? true : status === 408 || status === 425 || status === 429 || status >= 500
  return Object.assign(new Error(code), { code, retryable })
}

function workerControlError(code: string, retryable = false, details?: JsonValue): Error & { code: string; retryable: boolean; details?: JsonValue } {
  return Object.assign(new Error(code), { code, retryable, ...(details === undefined ? {} : { details }) })
}

function workerTaskError(error: RuntimeError | undefined): Error & { code: string; retryable?: boolean; details?: JsonValue } {
  const code = error?.code ?? 'WORKER_FAILED'
  return Object.assign(new Error(error?.message ?? code), { code, ...(error?.retryable === undefined ? {} : { retryable: error.retryable }), ...(error?.details === undefined ? {} : { details: error.details }) })
}

function workerRuntimeError(cause: unknown): RuntimeError {
  if (cause && typeof cause === 'object') {
    const candidate = cause as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'WORKER_FAILED',
      message: typeof candidate.message === 'string' ? candidate.message : errorMessage(cause),
      ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
      ...(candidate.details === undefined ? {} : { details: candidate.details as JsonValue }),
    }
  }
  return { code: 'WORKER_FAILED', message: errorMessage(cause) }
}

type AuthTokenSource = string | readonly string[]

function secretEquals(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function authorized(request: IncomingMessage, source: AuthTokenSource | undefined): boolean {
  if (source === undefined) return true
  const tokens = typeof source === 'string' ? [source] : source
  const presented = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice('Bearer '.length) : undefined
  return presented !== undefined && tokens.some((token) => secretEquals(presented, token))
}

export interface WorkerHttpServer {
  readonly url: string
  close(): Promise<void>
}

export interface WorkerHttpServerOptions {
  host?: string
  port?: number
  authToken?: string
  authTokens?: readonly string[]
  /** Resolve accepted credentials for every request so key rotation can overlap old and new tokens. */
  authTokenProvider?: () => AuthTokenSource
  /** Enable HTTPS for the coordinator transport. The caller owns certificate rotation and reload. */
  tls?: Pick<HttpsServerOptions, 'key' | 'cert' | 'ca' | 'passphrase' | 'requestCert' | 'rejectUnauthorized'>
  recoveryIntervalMs?: number
}

export async function startWorkerCoordinatorServer(coordinator: WorkerCoordinatorContract, options: WorkerHttpServerOptions = {}): Promise<WorkerHttpServer> {
  const registrations = new Map<string, () => void>()
  const handler = async (request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? 'GET'
      const path = request.url?.split('?')[0] ?? '/'
      const configuredTokens = options.authTokenProvider?.() ?? options.authTokens ?? options.authToken
      if (!authorized(request, configuredTokens)) { send(response, 401, { error: 'WORKER_HTTP_UNAUTHORIZED' }); return }
      if (method === 'GET' && path === '/health') { send(response, 200, { ok: true }); return }
      if (method !== 'POST') { send(response, 405, { error: 'WORKER_HTTP_METHOD_NOT_ALLOWED' }); return }
      const body = object(await readBody(request))
      if (path === '/workers/register') {
        const workerId = requiredString(body.workerId, 'INVALID_WORKER_ID')
        const unregister = coordinator.registerRemote(workerId)
        registrations.set(workerId, unregister)
        send(response, 200, { workerId, registered: true }); return
      }
      if (path === '/workers/unregister') {
        const workerId = requiredString(body.workerId, 'INVALID_WORKER_ID')
        registrations.get(workerId)?.()
        registrations.delete(workerId)
        send(response, 200, { workerId, registered: false }); return
      }
      if (path === '/tasks/submit') {
        const taskId = requiredString(body.taskId, 'WORKER_HTTP_TASK_ID_REQUIRED')
        if (!('payload' in body)) throw new Error('WORKER_HTTP_PAYLOAD_REQUIRED')
        if (body.idempotencyKey !== undefined && !requiredField(body.idempotencyKey)) throw new Error('INVALID_WORKER_IDEMPOTENCY_KEY')
        if (body.leaseMs !== undefined && (typeof body.leaseMs !== 'number' || !Number.isFinite(body.leaseMs) || body.leaseMs <= 0)) throw new Error('INVALID_WORKER_LEASE')
        const options: WorkerSubmitOptions = { taskId, ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }), ...(body.leaseMs === undefined ? {} : { leaseMs: body.leaseMs }) }
        const pending = coordinator.submit(body.payload!, options)
        void pending.catch(() => undefined)
        send(response, 200, { taskId }); return
      }
      if (path === '/tasks/get') {
        const taskId = requiredString(body.taskId, 'WORKER_HTTP_TASK_ID_REQUIRED')
        send(response, 200, (coordinator.get(taskId) ?? null) as unknown as JsonValue); return
      }
      if (path === '/tasks/claim') {
        const workerId = requiredString(body.workerId, 'INVALID_WORKER_ID')
        send(response, 200, (coordinator.claim(workerId) ?? null) as unknown as JsonValue); return
      }
      if (path === '/tasks/renew') {
        const workerId = body.workerId; const leaseId = body.leaseId
        if (!requiredField(workerId) || !requiredField(leaseId)) throw new Error('INVALID_WORKER_LEASE')
        if (body.leaseMs !== undefined && (typeof body.leaseMs !== 'number' || !Number.isFinite(body.leaseMs) || body.leaseMs <= 0)) throw new Error('INVALID_WORKER_LEASE')
        const expiresAt = coordinator.renewLease(workerId, leaseId, Date.now(), body.leaseMs === undefined ? undefined : body.leaseMs)
        if (expiresAt === undefined) { send(response, 409, { error: 'WORKER_LEASE_NOT_FOUND' }); return }
        send(response, 200, { leaseExpiresAt: expiresAt }); return
      }
      if (path === '/tasks/complete') {
        const workerId = body.workerId; const leaseId = body.leaseId
        if (!requiredField(workerId) || !requiredField(leaseId) || !('value' in body)) throw new Error('INVALID_WORKER_COMPLETION')
        if (!coordinator.completeRemote(workerId, leaseId, body.value!)) { send(response, 409, { error: 'WORKER_LEASE_NOT_FOUND' }); return }
        send(response, 200, { completed: true }); return
      }
      if (path === '/tasks/fail') {
        const workerId = body.workerId; const leaseId = body.leaseId
        if (!requiredField(workerId) || !requiredField(leaseId)) throw new Error('INVALID_WORKER_COMPLETION')
        const rawError = object(body.error)
        const error: RuntimeError = { code: typeof rawError.code === 'string' ? rawError.code : 'WORKER_FAILED', message: typeof rawError.message === 'string' ? rawError.message : 'Worker failed.', ...(typeof rawError.retryable === 'boolean' ? { retryable: rawError.retryable } : {}), ...(rawError.details === undefined ? {} : { details: rawError.details }) }
        if (!coordinator.failRemote(workerId, leaseId, error)) { send(response, 409, { error: 'WORKER_LEASE_NOT_FOUND' }); return }
        send(response, 200, { failed: true }); return
      }
      if (path === '/tasks/cancel') {
        const taskId = requiredString(body.taskId, 'WORKER_HTTP_TASK_ID_REQUIRED')
        send(response, 200, { cancelled: coordinator.cancel(taskId) }); return
      }
      send(response, 404, { error: 'WORKER_HTTP_NOT_FOUND' })
    } catch (cause) {
      send(response, 400, { error: errorMessage(cause) })
    }
  }
  const server: Server = options.tls === undefined ? createServer(handler) : createHttpsServer(options.tls, handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('WORKER_HTTP_ADDRESS_UNAVAILABLE')
  const host = options.host === '0.0.0.0' || options.host === '::' || options.host === undefined ? '127.0.0.1' : options.host
  const url = `${options.tls === undefined ? 'http' : 'https'}://${host}:${(address as AddressInfo).port}`
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 1_000
  const recoveryTimer = recoveryIntervalMs > 0 ? setInterval(() => { coordinator.recoverExpired(Date.now()) }, recoveryIntervalMs) : undefined
  recoveryTimer?.unref()
  return { url, close: async () => { if (recoveryTimer) clearInterval(recoveryTimer); await new Promise<void>((resolve, reject) => { server.close((cause) => cause ? reject(cause) : resolve()) }) } }
}

export interface HttpWorkerClientOptions { baseUrl: string; workerId: string; pollMs?: number; authToken?: string; requestTimeoutMs?: number; fetch?: typeof globalThis.fetch }

export class HttpWorkerClient {
  private readonly baseUrl: string
  private readonly workerId: string
  private readonly pollMs: number
  private readonly requestTimeoutMs: number
  private readonly authToken: string | undefined
  private readonly fetcher: typeof globalThis.fetch
  private sequence = 1

  constructor(options: HttpWorkerClientOptions) {
    if (!options.baseUrl || !options.workerId) throw new Error('INVALID_WORKER_HTTP_CLIENT')
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.workerId = options.workerId
    this.pollMs = options.pollMs ?? 10
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) throw new Error('INVALID_WORKER_POLL_INTERVAL')
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) throw new Error('INVALID_WORKER_HTTP_TIMEOUT')
    this.authToken = options.authToken
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  private async request(path: string, body: JsonObject): Promise<JsonValue> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.authToken === undefined ? {} : { authorization: `Bearer ${this.authToken}` }) }, body: JSON.stringify(body), signal: controller.signal })
      const text = await response.text()
      let value: JsonValue = null
      try { value = text.length === 0 ? null : JSON.parse(text) as JsonValue } catch { throw workerHttpError('WORKER_HTTP_INVALID_RESPONSE', 502) }
      if (!response.ok) {
        const code = object(value).error && typeof object(value).error === 'string' ? object(value).error as string : `WORKER_HTTP_${response.status}`
        throw workerHttpError(code, response.status)
      }
      return value
    } catch (cause) {
      if (controller.signal.aborted) throw workerHttpError('WORKER_HTTP_TIMEOUT')
      if (cause instanceof Error && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string' && 'retryable' in cause && typeof (cause as { retryable?: unknown }).retryable === 'boolean') throw cause
      throw Object.assign(workerHttpError('WORKER_HTTP_NETWORK_ERROR'), { cause })
    } finally { clearTimeout(timeout) }
  }

  async register(): Promise<void> { await this.request('/workers/register', { workerId: this.workerId }); }
  async unregister(): Promise<void> { await this.request('/workers/unregister', { workerId: this.workerId }); }
  async claim(): Promise<WorkerLease | undefined> {
    const result = await this.request('/tasks/claim', { workerId: this.workerId })
    if (result === null) return undefined
    if (!validWorkerLease(result)) throw new Error('WORKER_HTTP_INVALID_LEASE')
    return result as unknown as WorkerLease
  }
  async renew(leaseId: string, leaseMs?: number): Promise<number> {
    requiredString(leaseId, 'INVALID_WORKER_LEASE')
    if (leaseMs !== undefined && (!Number.isFinite(leaseMs) || leaseMs <= 0)) throw new Error('INVALID_WORKER_LEASE')
    const result = await this.request('/tasks/renew', { workerId: this.workerId, leaseId, ...(leaseMs === undefined ? {} : { leaseMs }) })
    const expiresAt = object(result).leaseExpiresAt
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) throw new Error('WORKER_HTTP_INVALID_LEASE')
    return expiresAt
  }
  async complete(leaseId: string, value: JsonValue): Promise<void> { await this.request('/tasks/complete', { workerId: this.workerId, leaseId, value }); }
  async fail(leaseId: string, error: RuntimeError): Promise<void> { await this.request('/tasks/fail', { workerId: this.workerId, leaseId, error: error as unknown as JsonValue }); }
  async cancel(taskId: string): Promise<boolean> { return Boolean(object(await this.request('/tasks/cancel', { taskId })).cancelled) }
  async get(taskId: string): Promise<WorkerTaskRecord | undefined> {
    requiredString(taskId, 'WORKER_HTTP_TASK_ID_REQUIRED')
    const result = await this.request('/tasks/get', { taskId })
    if (result === null) return undefined
    if (!validWorkerTask(result)) throw new Error('WORKER_HTTP_INVALID_TASK')
    return result as unknown as WorkerTaskRecord
  }

  async submit(payload: JsonValue, options: Omit<WorkerSubmitOptions, 'signal'> & { signal?: AbortSignal } = {}): Promise<JsonValue> {
    const taskId = options.taskId ?? `http-worker-task-${this.sequence++}`
    await this.request('/tasks/submit', { taskId, payload, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }), ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }) })
    if (options.signal?.aborted) { await this.cancel(taskId); throw workerControlError('WORKER_CANCELLED') }
    let abort: (() => void) | undefined
    const cancellation = options.signal === undefined ? undefined : new Promise<never>((_, reject) => {
      abort = () => { void this.cancel(taskId).catch(() => undefined); reject(workerControlError('WORKER_CANCELLED')) }
      options.signal!.addEventListener('abort', abort, { once: true })
    })
    const poll = async (): Promise<JsonValue> => {
      while (true) {
        const task = await this.get(taskId)
        if (task?.state === 'succeeded') return task.result ?? null
        if (task?.state === 'failed') throw workerTaskError(task.error)
        if (task?.state === 'cancelled') throw workerControlError('WORKER_CANCELLED')
        await new Promise((resolve) => setTimeout(resolve, this.pollMs))
      }
    }
    try { return await (cancellation === undefined ? poll() : Promise.race([poll(), cancellation])) }
    finally { if (options.signal !== undefined && abort !== undefined) options.signal.removeEventListener('abort', abort) }
  }
}

export interface HttpWorkerHandle { stop(): Promise<void> }

export async function startHttpWorker(client: HttpWorkerClient, handler: WorkerHandler, options: { signal?: AbortSignal; renewMs?: number } = {}): Promise<HttpWorkerHandle> {
  await client.register()
  const stopping = new AbortController()
  const onAbort = (): void => stopping.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const loop = (async (): Promise<void> => {
    while (!stopping.signal.aborted) {
      try {
        const lease = await client.claim()
        if (lease === undefined) { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
        const taskController = new AbortController()
        const stopTask = (): void => taskController.abort()
        stopping.signal.addEventListener('abort', stopTask, { once: true })
        const renewMs = options.renewMs ?? Math.max(1, Math.floor((lease.task.leaseMs ?? 30_000) / 3))
        const timer = setInterval(() => { void client.renew(lease.leaseId, lease.task.leaseMs).catch(() => undefined) }, renewMs)
        try {
          const value = await handler(lease.task.payload, taskController.signal)
          if (!stopping.signal.aborted) await client.complete(lease.leaseId, value)
        } catch (cause) {
          if (!stopping.signal.aborted) await client.fail(lease.leaseId, workerRuntimeError(cause))
        } finally {
          clearInterval(timer)
          stopping.signal.removeEventListener('abort', stopTask)
        }
      } catch {
        if (!stopping.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  })()
  return { stop: async () => { stopping.abort(); await loop; options.signal?.removeEventListener('abort', onAbort); await client.unregister() } }
}

export function createHttpWorkerEffectExecutor(client: HttpWorkerClient, options: { leaseMs?: number } = {}): EffectExecutor {
  return async (effect: Readonly<EffectRecord>, signal: AbortSignal): Promise<EffectExecution> => {
    const taskId = `${effect.id}:${effect.attemptId}`
    const idempotencyKey = effect.idempotencyKey ?? taskId
    const executionRef = { transport: 'http-worker', taskId, idempotencyKey }
    const sideEffectState = isSideEffectful(effect.sideEffectPolicy) ? 'applied' as const : 'none' as const
    try {
      const value = await client.submit({ effectId: effect.id, attemptId: effect.attemptId, kind: effect.kind, input: effect.input }, { taskId, idempotencyKey, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }), signal })
      return { value, executionState: 'succeeded', sideEffectState, executionRef }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message === 'WORKER_CANCELLED' || message === 'WORKER_FAILED' || /^WORKER_HTTP_4\d\d$/.test(message) || (cause && typeof cause === 'object' && 'retryable' in cause && (cause as { retryable?: unknown }).retryable === false)) throw cause
      const task = await client.get(taskId).catch(() => undefined)
      if (task?.state === 'succeeded') return { value: task.result ?? null, executionState: 'succeeded', sideEffectState, executionRef }
      if (task?.state === 'failed') return { value: null, status: 'failed', executionState: 'failed', sideEffectState: 'none', executionRef, error: task.error ?? { code: 'WORKER_FAILED', message: 'Remote Worker task failed.' } }
      if (task?.state === 'cancelled') return { value: null, status: 'cancelled', executionState: 'failed', sideEffectState: 'none', executionRef, error: { code: 'WORKER_CANCELLED', message: 'Remote Worker task was cancelled.' } }
      return { value: null, executionState: 'remote_unknown', sideEffectState: isSideEffectful(effect.sideEffectPolicy) ? 'unknown' : 'none', executionRef, error: { code: 'WORKER_EXECUTION_UNKNOWN', message: `Remote Worker task outcome is unknown: ${message}` } }
    }
  }
}
