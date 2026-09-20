import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('Effect retry policy', () => {
  it('retries a failed Attempt with exponential backoff and keeps one logical Effect', async () => {
    let calls = 0
    const runtime = new PulseRuntime({ effectExecutor: async () => {
      calls += 1
      if (calls === 1) throw new Error('transient')
      return { value: { ok: true } }
    } })
    const program: LaneProgram = { id: 'retry', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'unstable', kind: 'tool', concurrencyClass: 'tool', input: {}, retryPolicy: { maxAttempts: 2, initialBackoffMs: 5, maxBackoffMs: 20, jitter: false } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('retry', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('retry', 'finish') } }
    const { agentId } = runtime.createAgent('retry', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toBe(2)
    expect(runtime.state.effects.get('effect-1')?.attempts).toHaveLength(2)
    expect(runtime.state.effects.get('effect-1')?.attemptId).toBe('effect-1-attempt-2')
    expect(runtime.state.events.some((event) => event.type === 'effect.retry_scheduled')).toBe(true)
    expect(runtime.mutationLog.entries.some((entry) => entry.mutations.some((mutation) => mutation.op === 'setEffect' && mutation.effectId === 'effect-1' && mutation.record.state === 'retry_wait'))).toBe(true)
  })

  it('does not retry a failed write when duplicate execution is forbidden', async () => {
    let calls = 0
    const runtime = new PulseRuntime({ effectExecutor: async () => { calls += 1; return { value: null, sideEffectState: 'applied', executionState: 'failed', status: 'failed' } } })
    const program: LaneProgram = { id: 'no-duplicate', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write', duplicateExecutionPolicy: 'forbid', retryPolicy: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('no-duplicate', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('no-duplicate', 'finish') } }
    const { agentId } = runtime.createAgent('no duplicate', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toBe(1)
    expect(runtime.state.effects.get('effect-1')?.attempts).toHaveLength(1)
  })

  it('rejects retry admission before changing the logical Effect when storage is full', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 100_000 }, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'retry-admission', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'unstable', kind: 'tool', concurrencyClass: 'tool', input: {}, retryPolicy: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('retry-admission', 'finish') }) }
    runtime.createAgent('retry admission', program)
    runtime.tick()
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = 1
    expect(() => runtime.completeEffect('effect-1', { value: null, executionState: 'failed', status: 'failed' }, 'failed', { code: 'TRANSIENT', message: 'retry me' })).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.effects.get('effect-1')).toMatchObject({ state: 'running', attemptNo: 1, attemptId: 'effect-1-attempt-1' })
  })
})
