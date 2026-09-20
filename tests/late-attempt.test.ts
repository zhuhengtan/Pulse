import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { EffectObservationEmitter, LaneProgram } from '@pulse/runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('late Attempt and remote-unknown boundaries', () => {
  it('records a late completion without changing the published outcome', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const program: LaneProgram = { id: 'late', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('late', 'done') }
      : { actions: [{ type: 'complete', result: { done: true } }], next: point('late', 'done') } }
    const { agentId } = runtime.createAgent('late', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const before = runtime.state.effects.get('effect-1')?.outcome
    runtime.completeEffect('effect-1', { value: { late: true } })
    expect(runtime.state.effects.get('effect-1')?.outcome).toEqual(before)
    expect(runtime.state.events.some((event) => event.type === 'attempt.late_emit')).toBe(true)
    expect(runtime.mutationLog.entries.some((entry) => entry.transactionId === 'effect:effect-1:effect-1-attempt-1:settled')).toBe(true)
  })

  it('audits a late observation without re-entering the ObservationInbox', async () => {
    let emitLate: EffectObservationEmitter | undefined
    const runtime = new PulseRuntime({ effectExecutor: async (_effect, _signal, emitObservation) => {
      emitLate = emitObservation
      return { value: { ok: true } }
    } })
    const program: LaneProgram = { id: 'late-observation', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('late-observation', 'done') }
      : { actions: [{ type: 'complete', result: { done: true } }], next: point('late-observation', 'done') } }
    const { agentId } = runtime.createAgent('late observation', program)
    await expect(runtime.start(agentId).outcome()).resolves.toMatchObject({ status: 'succeeded' })
    expect(emitLate).toBeDefined()
    emitLate!({ type: 'progress', data: { phase: 'after-settlement' } })
    expect(runtime.observationInbox.snapshot()).toHaveLength(0)
    expect(runtime.state.events.some((event) => event.type === 'attempt.late_emit' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && event.data.kind === 'observation')).toBe(true)
  })

  it('bounds remote-unknown retries for pure computation', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'unknown-retry', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'llm', concurrencyClass: 'llm', input: {}, duplicateExecutionPolicy: 'allow', maxUnknownAttempts: 1, retryPolicy: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } }] }], next: point('unknown-retry', 'done') }) }
    runtime.createAgent('unknown', program)
    runtime.tick()
    runtime.markRemoteUnknown('effect-1', 'none')
    expect(runtime.state.effects.get('effect-1')?.state).toBe('retry_wait')
    expect(runtime.state.effects.get('effect-1')?.outcome).toBeUndefined()
  })
})
