import { describe, expect, it } from 'vitest'
import { createHttpWorkerEffectExecutor, HttpWorkerClient, startHttpWorker, startWorkerCoordinatorServer } from '@pulse/adapters'
import { PulseRuntime } from '@pulse/runtime'
import type { JsonValue, LaneProgram, WorkerCoordinator } from '@pulse/runtime'
import { WorkerCoordinator as Coordinator } from '@pulse/runtime'

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
})
