import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

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

  it('wakes the scheduler when a lock grant happens during async completion', async () => {
    let releaseFirst!: () => void
    const runtime = new PulseRuntime({
      maxTickMs: 1000,
      maxRunning: { tool: 2 },
      effectExecutor: async (effect) => effect.id === 'effect-1'
        ? await new Promise((resolve) => { releaseFirst = () => resolve({ value: { done: 1 } }) })
        : { value: { done: 2 } },
    })
    const program: LaneProgram = { id: 'async-locks', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [
        { key: 'first', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'shell', mode: 'exclusive' }] },
        { key: 'second', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'shell', mode: 'exclusive' }] },
      ], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('async-locks', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('async-locks', 'finish') } }
    runtime.createAgent('async lock admission', program)
    runtime.tick()
    expect(runtime.state.effects.get('effect-1')?.state).toBe('running')
    expect(runtime.state.effects.get('effect-2')?.state).toBe('queued')

    releaseFirst()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(runtime.state.effects.get('effect-2')?.state).not.toBe('queued')
  })

  it('keeps a later shared Effect behind a queued writer', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, maxRunning: { tool: 3 }, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'lock-fairness', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [
      { key: 'reader-1', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'workspace', mode: 'shared' }] },
      { key: 'writer', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'workspace', mode: 'exclusive' }] },
      { key: 'reader-2', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'workspace', mode: 'shared' }] },
    ] }], next: point('lock-fairness', 'done') }) }
    runtime.createAgent('lock fairness', program)
    runtime.tick()
    expect(runtime.state.effects.get('effect-1')?.state).toBe('running')
    expect(runtime.state.effects.get('effect-2')?.state).toBe('queued')
    expect(runtime.state.effects.get('effect-3')?.state).toBe('queued')
    runtime.completeEffect('effect-1', { value: { done: 1 } })
    expect(runtime.state.effects.get('effect-2')?.state).toBe('running')
    expect(runtime.state.effects.get('effect-3')?.state).toBe('queued')
    runtime.completeEffect('effect-2', { value: { done: 2 } })
    expect(runtime.state.effects.get('effect-3')?.state).toBe('running')
  })

  it('rejects duplicate resource declarations inside one Effect transaction', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'duplicate-locks', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'bad', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'same', mode: 'shared' }, { resource: 'same', mode: 'exclusive' }] }] }], next: point('duplicate-locks', 'done') }) }
    const { laneId } = runtime.createAgent('invalid locks', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.pendingResumeInput).toMatchObject({ type: 'control_error', error: { code: 'DUPLICATE_EFFECT_LOCK' } })
  })
})
