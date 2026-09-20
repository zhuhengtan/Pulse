import { describe, expect, it } from 'vitest'
import { createWorkerEffectExecutor, PulseRuntime, WorkerCoordinator } from '@pulse/runtime'
import type { JsonValue, LaneProgram } from '@pulse/runtime'

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
})
