import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('Effect resource lock admission', () => {
  it('serializes exclusive Effects sharing a resource even when class capacity allows both', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, maxRunning: { tool: 2 }, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'locks', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [
        { key: 'first', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'db:account', mode: 'exclusive' }] },
        { key: 'second', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'db:account', mode: 'exclusive' }] },
      ], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('locks', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('locks', 'finish') } }
    runtime.createAgent('lock admission', program)
    runtime.tick()
    expect(runtime.state.effects.get('effect-1')?.state).toBe('running')
    expect(runtime.state.effects.get('effect-2')?.state).toBe('queued')
    expect(runtime.state.events.some((event) => event.type === 'effect.lock_blocked' && event.effectId === 'effect-2')).toBe(true)

    runtime.completeEffect('effect-1', { value: { done: 1 } })
    expect(runtime.state.effects.get('effect-2')?.state).toBe('running')
    expect(runtime.resourceLocks.isHeld('db:account', 'exclusive')).toBe(true)
  })

  it('rejects duplicate resource declarations inside one Effect transaction', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'duplicate-locks', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'bad', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'same', mode: 'shared' }, { resource: 'same', mode: 'exclusive' }] }] }], next: point('duplicate-locks', 'done') }) }
    const { laneId } = runtime.createAgent('invalid locks', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.pendingResumeInput).toMatchObject({ type: 'control_error', error: { code: 'DUPLICATE_EFFECT_LOCK' } })
  })
})
