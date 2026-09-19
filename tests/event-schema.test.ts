import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('Runtime event envelope', () => {
  it('emits normalized events with stable identity, session and transaction metadata', async () => {
    const runtime = new PulseRuntime({ sessionId: 'session-test', effectExecutor: async () => ({ value: { ok: true } }) })
    const program: LaneProgram = { id: 'events', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('events', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('events', 'finish') } }
    const { agentId } = runtime.createAgent('events', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.events.length).toBeGreaterThan(0)
    expect(runtime.state.events.every((event) => event.id && event.schemaVersion === 1 && event.sessionId === 'session-test' && typeof event.timestamp === 'number' && event.payload !== undefined)).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'step.committed' && event.txId?.startsWith('step:'))).toBe(true)
  })
})
