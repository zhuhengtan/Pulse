import { describe, expect, it } from 'vitest'
import { createWorkerEffectExecutor, FileWorkerPersistenceBackend, PulseRuntime, WorkerCoordinator } from '@hunterzhu/pulse-runtime'
import type { JsonValue, LaneProgram } from '@hunterzhu/pulse-runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('lease-based WorkerCoordinator', () => {
  it('recovers an expired lease and completes the task on a retry', async () => {
    const coordinator = new WorkerCoordinator()
    let calls = 0
    let firstLeaseAborted = false
    coordinator.register('worker-1', async (_payload, signal) => {
      calls += 1
      if (calls === 1) return await new Promise<JsonValue>((resolve, reject) => {
        signal.addEventListener('abort', () => { firstLeaseAborted = true; reject(new Error('lease lost')) }, { once: true })
      })
      return { worker: 'worker-1', retry: true }
    })

    const result = coordinator.submit({ job: 'recover' }, { taskId: 'task-recover', leaseMs: 1 })
    const leased = coordinator.inspect()[0]
    expect(leased).toMatchObject({ id: 'task-recover', state: 'leased', attempt: 1, workerId: 'worker-1' })
    expect(coordinator.recoverExpired(leased.leaseExpiresAt! + 1)).toEqual(['task-recover'])
    await expect(result).resolves.toEqual({ worker: 'worker-1', retry: true })
    expect(firstLeaseAborted).toBe(true)
    expect(coordinator.inspect()[0]).toMatchObject({ state: 'succeeded', attempt: 2 })
  })

  it('dispatches concurrently registered workers and preserves idempotency', async () => {
    const coordinator = new WorkerCoordinator()
    let release!: () => void
    const held = new Promise<JsonValue>((resolve) => { release = () => resolve({ worker: 'worker-a' }) })
    let calls = 0
    coordinator.register('worker-a', async (payload) => {
      calls += 1
      return (payload as { [key: string]: JsonValue }).job === 'hold' ? held : { worker: 'worker-a' }
    })
    coordinator.register('worker-b', async () => ({ worker: 'worker-b' }))

    const first = coordinator.submit({ job: 'hold' }, { taskId: 'task-hold', idempotencyKey: 'same-job' })
    const duplicate = coordinator.submit({ job: 'duplicate' }, { taskId: 'ignored', idempotencyKey: 'same-job' })
    const second = coordinator.submit({ job: 'fast' }, { taskId: 'task-fast' })
    expect(duplicate).toBe(first)
    expect(coordinator.inspect()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-hold', state: 'leased', workerId: 'worker-a' }),
      expect.objectContaining({ id: 'task-fast', state: 'leased', workerId: 'worker-b' }),
    ]))
    release()
    await expect(first).resolves.toEqual({ worker: 'worker-a' })
    await expect(second).resolves.toEqual({ worker: 'worker-b' })
    expect(calls).toBe(1)
  })

  it('adapts Runtime Effects to worker tasks', async () => {
    const coordinator = new WorkerCoordinator()
    coordinator.register('runtime-worker', async (payload) => {
      const task = payload as { [key: string]: JsonValue }
      return { worker: 'runtime-worker', effectId: task.effectId ?? null, kind: task.kind ?? null }
    })
    const runtime = new PulseRuntime({ effectExecutor: createWorkerEffectExecutor(coordinator) })
    const program: LaneProgram = {
      id: 'worker-runtime',
      version: '1',
      step: ({ lane, resumeInput }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'worker', kind: 'tool', concurrencyClass: 'tool', input: { request: 'run' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('worker-runtime', 'finish') }
        : { actions: [{ type: 'complete', result: { worker: resumeInput?.type === 'wait' } }], next: point('worker-runtime', 'finish') },
    }
    const { agentId } = runtime.createAgent('worker adapter', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const effect = runtime.state.effects.get('effect-1')
    expect(effect?.outcome?.status).toBe('succeeded')
    expect(effect?.outcome?.resultRef).toBeDefined()
    expect(runtime.state.results.get(effect!.outcome!.resultRef!)?.value).toEqual({ worker: 'runtime-worker', effectId: 'effect-1', kind: 'tool' })
    expect(coordinator.inspect()).toMatchObject([{ id: 'effect-1:effect-1-attempt-1', state: 'succeeded', attempt: 1 }])
  })

  it('preserves non-retryable local Worker errors through the Runtime adapter', async () => {
    const coordinator = new WorkerCoordinator()
    coordinator.register('permanent-worker', async () => { throw Object.assign(new Error('permanent worker failure'), { code: 'PERMANENT_WORKER_FAILURE', retryable: false, details: { source: 'worker' } }) })
    const runtime = new PulseRuntime({ effectExecutor: createWorkerEffectExecutor(coordinator) })
    const program: LaneProgram = { id: 'worker-error', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'worker', kind: 'tool', concurrencyClass: 'tool', input: { request: 'run' }, retryPolicy: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('worker-error', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('worker-error', 'finish') } }
    const { agentId } = runtime.createAgent('worker error semantics', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.effects.get('effect-1')?.attempts).toHaveLength(1)
    expect(runtime.state.effects.get('effect-1')?.outcome).toMatchObject({ error: { code: 'PERMANENT_WORKER_FAILURE', retryable: false, details: { source: 'worker' } } })
  })

  it('cancels an active task and does not let the aborted handler settle it', async () => {
    const coordinator = new WorkerCoordinator()
    coordinator.register('worker-cancel', async (_payload, signal) => await new Promise<JsonValue>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      void resolve
    }))
    const result = coordinator.submit({ job: 'cancel' }, { taskId: 'task-cancel' })
    expect(coordinator.cancel('task-cancel')).toBe(true)
    await expect(result).rejects.toThrow('WORKER_CANCELLED')
    expect(coordinator.inspect()).toMatchObject([{ id: 'task-cancel', state: 'cancelled', attempt: 1 }])
    expect(coordinator.cancel('task-cancel')).toBe(false)
  })

  it('restores in-flight leases as queued work and preserves idempotency across restart', async () => {
    const coordinator = new WorkerCoordinator()
    coordinator.registerRemote('before-restart')
    const original = coordinator.submit({ job: 'durable' }, { taskId: 'task-durable', idempotencyKey: 'durable-key', leaseMs: 50 })
    const firstLease = coordinator.claim('before-restart')
    expect(firstLease?.task.attempt).toBe(1)

    const restored = WorkerCoordinator.restore(coordinator.snapshot())
    restored.registerRemote('after-restart')
    const recoveredLease = restored.claim('after-restart')
    expect(recoveredLease).toMatchObject({ task: { id: 'task-durable', state: 'leased', attempt: 2 }, workerId: 'after-restart' })
    expect(restored.completeRemote('after-restart', recoveredLease!.leaseId, { recovered: true })).toBe(true)
    await expect(restored.submit({ job: 'duplicate-payload' }, { taskId: 'ignored', idempotencyKey: 'durable-key' })).resolves.toEqual({ recovered: true })
    expect(restored.get('task-durable')).toMatchObject({ state: 'succeeded', attempt: 2 })
    expect(original).toBeInstanceOf(Promise)
  })

  it('persists and restores coordinator state through an atomic file backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-worker-persistence-'))
    try {
      const backend = new FileWorkerPersistenceBackend(join(directory, 'worker.json'))
      const coordinator = await WorkerCoordinator.fromPersistence(backend)
      coordinator.registerRemote('before-restart')
      coordinator.submit({ job: 'durable-file' }, { taskId: 'durable-file-task', idempotencyKey: 'durable-file-key', leaseMs: 50 })
      const firstLease = coordinator.claim('before-restart')
      expect(firstLease?.task.state).toBe('leased')
      await coordinator.flushPersistence()

      const restored = await WorkerCoordinator.fromPersistence(backend)
      restored.registerRemote('after-restart')
      const recovered = restored.claim('after-restart')
      expect(recovered).toMatchObject({ task: { id: 'durable-file-task', state: 'leased', attempt: 2 } })
      expect(restored.completeRemote('after-restart', recovered!.leaseId, { recovered: 'file' })).toBe(true)
      await restored.flushPersistence()
      await expect(restored.submit({ job: 'duplicate-after-restart' }, { taskId: 'ignored-after-restart', idempotencyKey: 'durable-file-key' })).resolves.toEqual({ recovered: 'file' })
      const final = await WorkerCoordinator.fromPersistence(backend)
      expect(final.get('durable-file-task')).toMatchObject({ state: 'succeeded', result: { recovered: 'file' } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a tampered Worker snapshot before lease recovery', () => {
    const snapshot = new WorkerCoordinator().snapshot()
    expect(snapshot.integrity).toMatchObject({ algorithm: 'sha256', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const tampered = structuredClone(snapshot)
    tampered.sequence = 99
    expect(() => WorkerCoordinator.restore(tampered)).toThrow('INVALID_WORKER_INTEGRITY')
  })

  it('surfaces automatic persistence failures through flushPersistence', async () => {
    const backend = { load: async () => undefined, save: async () => { throw new Error('WORKER_PERSISTENCE_UNAVAILABLE') } }
    const coordinator = new WorkerCoordinator({ persistenceBackend: backend })
    coordinator.registerRemote('durability-check')
    await expect(coordinator.flushPersistence()).rejects.toThrow('WORKER_PERSISTENCE_UNAVAILABLE')
  })

  it('rejects a stale coordinator write instead of overwriting a shared lease store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-worker-conflict-'))
    try {
      const backend = new FileWorkerPersistenceBackend(join(directory, 'worker.json'))
      const first = await WorkerCoordinator.fromPersistence(backend)
      first.registerRemote('first')
      await first.flushPersistence()
      const second = await WorkerCoordinator.fromPersistence(backend)
      first.submit({ owner: 'first' }, { taskId: 'first-task' })
      await first.flushPersistence()
      second.registerRemote('second')
      second.submit({ owner: 'second' }, { taskId: 'second-task' })
      await expect(second.flushPersistence()).rejects.toThrow('WORKER_PERSISTENCE_CONFLICT')
      const latest = await WorkerCoordinator.fromPersistence(backend)
      expect(latest.get('first-task')).toBeDefined()
      expect(latest.get('second-task')).toBeUndefined()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
