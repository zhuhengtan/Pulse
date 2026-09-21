import { describe, expect, it } from 'vitest'
import { createHttpWorkerEffectExecutor, HttpWorkerClient, startHttpWorker, startWorkerCoordinatorServer } from '@pulse/adapters'
import { PulseRuntime } from '@pulse/runtime'
import type { EffectRecord, JsonValue, LaneProgram, WorkerCoordinator } from '@pulse/runtime'
import { WorkerCoordinator as Coordinator } from '@pulse/runtime'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('HTTP Worker transport', () => {
  it('round-trips a remote claim, lease renewal, and completion', async () => {
    const coordinator: WorkerCoordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator)
    const client = new HttpWorkerClient({ baseUrl: server.url, workerId: 'remote-protocol', pollMs: 1 })
    try {
      await client.register()
      const result = coordinator.submit({ job: 'protocol' }, { taskId: 'http-protocol', leaseMs: 10 })
      const lease = await client.claim()
      expect(lease).toMatchObject({ workerId: 'remote-protocol', leaseId: expect.any(String), task: { id: 'http-protocol', attempt: 1, state: 'leased' } })
      const renewed = await client.renew(lease!.leaseId, 100)
      expect(renewed).toBeGreaterThan(Date.now())
      await client.complete(lease!.leaseId, { ok: true })
      await expect(result).resolves.toEqual({ ok: true })
      expect(coordinator.get('http-protocol')).toMatchObject({ state: 'succeeded', attempt: 1, result: { ok: true } })
    } finally {
      await client.unregister().catch(() => undefined)
      await server.close()
    }
  })

  it('rejects unauthenticated Worker transport requests before task access', async () => {
    const coordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator, { authToken: 'test-worker-token' })
    const unauthenticated = new HttpWorkerClient({ baseUrl: server.url, workerId: 'unauthenticated', pollMs: 1 })
    const authenticated = new HttpWorkerClient({ baseUrl: server.url, workerId: 'authenticated', pollMs: 1, authToken: 'test-worker-token' })
    try {
      await expect(unauthenticated.register()).rejects.toThrow('WORKER_HTTP_UNAUTHORIZED')
      await expect(authenticated.register()).resolves.toBeUndefined()
      await expect(authenticated.unregister()).resolves.toBeUndefined()
    } finally { await server.close() }
  })

  it('supports overlapping token rotation without restarting the coordinator', async () => {
    const coordinator = new Coordinator()
    let acceptedTokens: readonly string[] = ['old-worker-token']
    const server = await startWorkerCoordinatorServer(coordinator, { authTokenProvider: () => acceptedTokens })
    const oldClient = new HttpWorkerClient({ baseUrl: server.url, workerId: 'old-worker', pollMs: 1, authToken: 'old-worker-token' })
    const newClient = new HttpWorkerClient({ baseUrl: server.url, workerId: 'new-worker', pollMs: 1, authToken: 'new-worker-token' })
    try {
      await oldClient.register()
      acceptedTokens = ['new-worker-token', 'old-worker-token']
      await newClient.register()
      acceptedTokens = ['new-worker-token']
      await expect(oldClient.unregister()).rejects.toThrow('WORKER_HTTP_UNAUTHORIZED')
      await expect(newClient.unregister()).resolves.toBeUndefined()
    } finally {
      await oldClient.unregister().catch(() => undefined)
      await newClient.unregister().catch(() => undefined)
      await server.close()
    }
  })

  it('serves the coordinator over HTTPS with the configured Bearer policy', async () => {
    const coordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator, {
      authToken: 'tls-worker-token',
      tls: {
        key: await readFile(resolve('tests/fixtures/worker-http-key.pem')),
        cert: await readFile(resolve('tests/fixtures/worker-http-cert.pem')),
      },
    })
    try {
      expect(server.url.startsWith('https://')).toBe(true)
      const response = await new Promise<{ statusCode?: number; body: string }>((resolveResponse, reject) => {
        const request = httpsRequest(`${server.url}/health`, { rejectUnauthorized: false, headers: { authorization: 'Bearer tls-worker-token' } }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          response.on('end', () => resolveResponse({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        request.on('error', reject)
        request.end()
      })
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ ok: true })
    } finally { await server.close() }
  })

  it('bounds a hung Coordinator request during a network partition', async () => {
    const hangingFetch: typeof globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('ABORT_ERR')), { once: true })
    })
    const client = new HttpWorkerClient({ baseUrl: 'http://unreachable.invalid', workerId: 'partitioned', requestTimeoutMs: 5, fetch: hangingFetch })
    await expect(client.register()).rejects.toThrow('WORKER_HTTP_TIMEOUT')
  })

  it('fails closed on malformed lease and task responses', async () => {
    const malformedFetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname
      const body = path === '/tasks/claim'
        ? JSON.stringify({ workerId: 'worker', leaseId: 'lease', task: { id: 'task', state: 'leased', attempt: 1 } })
        : JSON.stringify({ leaseExpiresAt: 'later' })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const client = new HttpWorkerClient({ baseUrl: 'http://malformed.invalid', workerId: 'worker', fetch: malformedFetch })
    await expect(client.claim()).rejects.toThrow('WORKER_HTTP_INVALID_LEASE')
    await expect(client.renew('lease')).rejects.toThrow('WORKER_HTTP_INVALID_LEASE')
  })

  it('routes an ambiguous remote write into reconciliation instead of retrying blindly', async () => {
    const coordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator)
    const nativeFetch = globalThis.fetch
    const partitionedFetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/tasks/get')) throw new Error('fetch failed')
      return nativeFetch(input, init)
    }
    const client = new HttpWorkerClient({ baseUrl: server.url, workerId: 'runtime-host', requestTimeoutMs: 50, fetch: partitionedFetch })
    const executor = createHttpWorkerEffectExecutor(client)
    const effect = { id: 'effect-remote-unknown', attemptId: 'effect-remote-unknown-attempt-1', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'running', executionState: 'running', sideEffectState: 'none', sideEffectPolicy: 'write' } as EffectRecord
    try {
      const result = await executor(effect, new AbortController().signal)
      expect(result.executionState).toBe('remote_unknown')
      expect(result.sideEffectState).toBe('unknown')
      expect(result.executionRef).toMatchObject({ transport: 'http-worker', taskId: 'effect-remote-unknown:effect-remote-unknown-attempt-1' })
      expect(coordinator.get('effect-remote-unknown:effect-remote-unknown-attempt-1')).toMatchObject({ state: 'queued' })
    } finally { await server.close() }
  })

  it('executes a Runtime Effect through an HTTP polling Worker with heartbeat renewal', async () => {
    const coordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator)
    const workerClient = new HttpWorkerClient({ baseUrl: server.url, workerId: 'runtime-remote', pollMs: 1 })
    const worker = await startHttpWorker(workerClient, async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const task = payload as { [key: string]: JsonValue }
      return { remote: true, effectId: task.effectId ?? null }
    }, { renewMs: 2 })
    try {
      const runtimeClient = new HttpWorkerClient({ baseUrl: server.url, workerId: 'runtime-host', pollMs: 1 })
      const runtime = new PulseRuntime({ effectExecutor: createHttpWorkerEffectExecutor(runtimeClient, { leaseMs: 10 }) })
      const program: LaneProgram = { id: 'http-worker-runtime', version: '1', step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'remote', kind: 'tool', concurrencyClass: 'tool', input: { request: 'run' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('http-worker-runtime', 'finish') }
        : { actions: [{ type: 'complete', result: { ok: true } }], next: point('http-worker-runtime', 'finish') } }
      const { agentId } = runtime.createAgent('HTTP worker', program)
      expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
      const effect = runtime.state.effects.get('effect-1')
      expect(effect?.outcome?.status).toBe('succeeded')
      expect(runtime.state.results.get(effect!.outcome!.resultRef!)?.value).toEqual({ remote: true, effectId: 'effect-1' })
      expect(coordinator.get('effect-1:effect-1-attempt-1')).toMatchObject({ state: 'succeeded', attempt: 1 })
    } finally {
      await worker.stop()
      await server.close()
    }
  })

  it('preserves a Worker handler retryability decision across HTTP', async () => {
    const coordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator)
    const workerClient = new HttpWorkerClient({ baseUrl: server.url, workerId: 'error-semantics-worker', pollMs: 1 })
    const worker = await startHttpWorker(workerClient, async () => { throw Object.assign(new Error('permanent worker failure'), { code: 'PERMANENT_WORKER_FAILURE', retryable: false, details: { source: 'worker' } }) })
    const runtimeClient = new HttpWorkerClient({ baseUrl: server.url, workerId: 'error-semantics-host', pollMs: 1 })
    const runtime = new PulseRuntime({ effectExecutor: createHttpWorkerEffectExecutor(runtimeClient) })
    const program: LaneProgram = { id: 'http-worker-error', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'remote', kind: 'tool', concurrencyClass: 'tool', input: { request: 'run' }, retryPolicy: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('http-worker-error', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('http-worker-error', 'finish') } }
    try {
      const { agentId } = runtime.createAgent('HTTP worker error semantics', program)
      expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
      expect(runtime.state.effects.get('effect-1')?.attempts).toHaveLength(1)
      expect(runtime.state.effects.get('effect-1')?.outcome).toMatchObject({ error: { code: 'PERMANENT_WORKER_FAILURE', retryable: false, details: { source: 'worker' } } })
    } finally {
      await worker.stop()
      await server.close()
    }
  })

  it('reclaims an expired remote lease without an explicit host-side recovery call', async () => {
    const coordinator = new Coordinator()
    const server = await startWorkerCoordinatorServer(coordinator, { recoveryIntervalMs: 2 })
    const stale = new HttpWorkerClient({ baseUrl: server.url, workerId: 'stale', pollMs: 1 })
    const fresh = new HttpWorkerClient({ baseUrl: server.url, workerId: 'fresh', pollMs: 1 })
    try {
      await stale.register()
      await fresh.register()
      const result = coordinator.submit({ job: 'reclaim' }, { taskId: 'reclaim-task', leaseMs: 100 })
      const lease = await stale.claim()
      expect(lease?.task.id).toBe('reclaim-task')
      await new Promise((resolve) => setTimeout(resolve, 150))
      const recovered = await fresh.claim()
      expect(recovered).toMatchObject({ task: { id: 'reclaim-task', attempt: 2 }, workerId: 'fresh' })
      await fresh.complete(recovered!.leaseId, { reclaimed: true })
      await expect(result).resolves.toEqual({ reclaimed: true })
    } finally {
      await stale.unregister().catch(() => undefined)
      await fresh.unregister().catch(() => undefined)
      await server.close()
    }
  })
})
