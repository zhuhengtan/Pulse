import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { EffectExecution, EffectExecutor, EffectRecord, JsonValue, RuntimeError, WorkerHandler, WorkerLease, WorkerSubmitOptions, WorkerTaskRecord } from '@pulse/runtime'
import { WorkerCoordinator } from '@pulse/runtime'

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

function send(response: import('node:http').ServerResponse, status: number, value: JsonValue): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(responseBody(value))
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }

export interface WorkerHttpServer {
  readonly url: string
  close(): Promise<void>
}

export interface WorkerHttpServerOptions { host?: string; port?: number; authToken?: string; recoveryIntervalMs?: number }

export async function startWorkerCoordinatorServer(coordinator: WorkerCoordinator, options: WorkerHttpServerOptions = {}): Promise<WorkerHttpServer> {
  const registrations = new Map<string, () => void>()
  const server: Server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET'
      const path = request.url?.split('?')[0] ?? '/'
      const configuredToken = options.authToken
      if (configuredToken !== undefined && request.headers.authorization !== `Bearer ${configuredToken}`) { send(response, 401, { error: 'WORKER_HTTP_UNAUTHORIZED' }); return }
      if (method === 'GET' && path === '/health') { send(response, 200, { ok: true }); return }
      if (method !== 'POST') { send(response, 405, { error: 'WORKER_HTTP_METHOD_NOT_ALLOWED' }); return }
      const body = object(await readBody(request))
      if (path === '/workers/register') {
        const workerId = body.workerId
        if (typeof workerId !== 'string') throw new Error('INVALID_WORKER_ID')
        const unregister = coordinator.registerRemote(workerId)
        registrations.set(workerId, unregister)
        send(response, 200, { workerId, registered: true }); return
      }
      if (path === '/workers/unregister') {
        const workerId = body.workerId
        if (typeof workerId !== 'string') throw new Error('INVALID_WORKER_ID')
        registrations.get(workerId)?.()
        registrations.delete(workerId)
        send(response, 200, { workerId, registered: false }); return
      }
      if (path === '/tasks/submit') {
        const taskId = body.taskId
        if (typeof taskId !== 'string') throw new Error('WORKER_HTTP_TASK_ID_REQUIRED')
        if (!('payload' in body)) throw new Error('WORKER_HTTP_PAYLOAD_REQUIRED')
        const options: WorkerSubmitOptions = { taskId, ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}), ...(typeof body.leaseMs === 'number' ? { leaseMs: body.leaseMs } : {}) }
        const pending = coordinator.submit(body.payload!, options)
        void pending.catch(() => undefined)
        send(response, 200, { taskId }); return
      }
      if (path === '/tasks/get') {
        const taskId = body.taskId
        if (typeof taskId !== 'string') throw new Error('WORKER_HTTP_TASK_ID_REQUIRED')
        send(response, 200, (coordinator.get(taskId) ?? null) as unknown as JsonValue); return
      }
      if (path === '/tasks/claim') {
        const workerId = body.workerId
        if (typeof workerId !== 'string') throw new Error('INVALID_WORKER_ID')
        send(response, 200, (coordinator.claim(workerId) ?? null) as unknown as JsonValue); return
      }
      if (path === '/tasks/renew') {
        const workerId = body.workerId; const leaseId = body.leaseId
        if (typeof workerId !== 'string' || typeof leaseId !== 'string') throw new Error('INVALID_WORKER_LEASE')
        const expiresAt = coordinator.renewLease(workerId, leaseId, Date.now(), typeof body.leaseMs === 'number' ? body.leaseMs : undefined)
        if (expiresAt === undefined) { send(response, 409, { error: 'WORKER_LEASE_NOT_FOUND' }); return }
        send(response, 200, { leaseExpiresAt: expiresAt }); return
      }
      if (path === '/tasks/complete') {
        const workerId = body.workerId; const leaseId = body.leaseId
        if (typeof workerId !== 'string' || typeof leaseId !== 'string' || !('value' in body)) throw new Error('INVALID_WORKER_COMPLETION')
        if (!coordinator.completeRemote(workerId, leaseId, body.value!)) { send(response, 409, { error: 'WORKER_LEASE_NOT_FOUND' }); return }
        send(response, 200, { completed: true }); return
      }
      if (path === '/tasks/fail') {
        const workerId = body.workerId; const leaseId = body.leaseId
        if (typeof workerId !== 'string' || typeof leaseId !== 'string') throw new Error('INVALID_WORKER_COMPLETION')
        const rawError = object(body.error)
        const error: RuntimeError = { code: typeof rawError.code === 'string' ? rawError.code : 'WORKER_FAILED', message: typeof rawError.message === 'string' ? rawError.message : 'Worker failed.', ...(typeof rawError.retryable === 'boolean' ? { retryable: rawError.retryable } : {}), ...(rawError.details === undefined ? {} : { details: rawError.details }) }
        if (!coordinator.failRemote(workerId, leaseId, error)) { send(response, 409, { error: 'WORKER_LEASE_NOT_FOUND' }); return }
        send(response, 200, { failed: true }); return
      }
      if (path === '/tasks/cancel') {
        const taskId = body.taskId
        if (typeof taskId !== 'string') throw new Error('WORKER_HTTP_TASK_ID_REQUIRED')
        send(response, 200, { cancelled: coordinator.cancel(taskId) }); return
      }
      send(response, 404, { error: 'WORKER_HTTP_NOT_FOUND' })
    } catch (cause) {
      send(response, 400, { error: errorMessage(cause) })
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('WORKER_HTTP_ADDRESS_UNAVAILABLE')
  const host = options.host === '0.0.0.0' || options.host === '::' || options.host === undefined ? '127.0.0.1' : options.host
  const url = `http://${host}:${(address as AddressInfo).port}`
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 1_000
  const recoveryTimer = recoveryIntervalMs > 0 ? setInterval(() => { coordinator.recoverExpired(Date.now()) }, recoveryIntervalMs) : undefined
  recoveryTimer?.unref()
  return { url, close: async () => { if (recoveryTimer) clearInterval(recoveryTimer); await new Promise<void>((resolve, reject) => { server.close((cause) => cause ? reject(cause) : resolve()) }) } }
}

export interface HttpWorkerClientOptions { baseUrl: string; workerId: string; pollMs?: number; authToken?: string; fetch?: typeof globalThis.fetch }

export class HttpWorkerClient {
  private readonly baseUrl: string
  private readonly workerId: string
  private readonly pollMs: number
  private readonly authToken: string | undefined
  private readonly fetcher: typeof globalThis.fetch
  private sequence = 1

  constructor(options: HttpWorkerClientOptions) {
    if (!options.baseUrl || !options.workerId) throw new Error('INVALID_WORKER_HTTP_CLIENT')
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.workerId = options.workerId
    this.pollMs = options.pollMs ?? 10
    this.authToken = options.authToken
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  private async request(path: string, body: JsonObject): Promise<JsonValue> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.authToken === undefined ? {} : { authorization: `Bearer ${this.authToken}` }) }, body: JSON.stringify(body) })
    const text = await response.text()
    let value: JsonValue = null
    try { value = text.length === 0 ? null : JSON.parse(text) as JsonValue } catch { throw new Error('WORKER_HTTP_INVALID_RESPONSE') }
    if (!response.ok) throw new Error(object(value).error && typeof object(value).error === 'string' ? object(value).error as string : `WORKER_HTTP_${response.status}`)
    return value
  }

  async register(): Promise<void> { await this.request('/workers/register', { workerId: this.workerId }); }
  async unregister(): Promise<void> { await this.request('/workers/unregister', { workerId: this.workerId }); }
  async claim(): Promise<WorkerLease | undefined> { return await this.request('/tasks/claim', { workerId: this.workerId }) as unknown as WorkerLease | undefined }
  async renew(leaseId: string, leaseMs?: number): Promise<number> { const result = await this.request('/tasks/renew', { workerId: this.workerId, leaseId, ...(leaseMs === undefined ? {} : { leaseMs }) }); return Number(object(result).leaseExpiresAt) }
  async complete(leaseId: string, value: JsonValue): Promise<void> { await this.request('/tasks/complete', { workerId: this.workerId, leaseId, value }); }
  async fail(leaseId: string, error: RuntimeError): Promise<void> { await this.request('/tasks/fail', { workerId: this.workerId, leaseId, error: error as unknown as JsonValue }); }
  async cancel(taskId: string): Promise<boolean> { return Boolean(object(await this.request('/tasks/cancel', { taskId })).cancelled) }
  async get(taskId: string): Promise<WorkerTaskRecord | undefined> { return await this.request('/tasks/get', { taskId }) as unknown as WorkerTaskRecord | undefined }

  async submit(payload: JsonValue, options: Omit<WorkerSubmitOptions, 'signal'> & { signal?: AbortSignal } = {}): Promise<JsonValue> {
    const taskId = options.taskId ?? `http-worker-task-${this.sequence++}`
    await this.request('/tasks/submit', { taskId, payload, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }), ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }) })
    if (options.signal?.aborted) { await this.cancel(taskId); throw new Error('WORKER_CANCELLED') }
    let abort: (() => void) | undefined
    const cancellation = options.signal === undefined ? undefined : new Promise<never>((_, reject) => {
      abort = () => { void this.cancel(taskId).catch(() => undefined); reject(new Error('WORKER_CANCELLED')) }
      options.signal!.addEventListener('abort', abort, { once: true })
    })
    const poll = async (): Promise<JsonValue> => {
      while (true) {
        const task = await this.get(taskId)
        if (task?.state === 'succeeded') return task.result ?? null
        if (task?.state === 'failed') throw new Error(task.error?.message ?? 'WORKER_FAILED')
        if (task?.state === 'cancelled') throw new Error('WORKER_CANCELLED')
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
          if (!stopping.signal.aborted) await client.fail(lease.leaseId, { code: 'WORKER_FAILED', message: errorMessage(cause) })
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
    const value = await client.submit({ effectId: effect.id, attemptId: effect.attemptId, kind: effect.kind, input: effect.input }, { taskId: `${effect.id}:${effect.attemptId}`, idempotencyKey: effect.idempotencyKey ?? `${effect.id}:${effect.attemptId}`, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }), signal })
    return { value, executionState: 'succeeded', sideEffectState: 'none' }
  }
}
