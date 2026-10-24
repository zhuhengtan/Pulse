import { describe, expect, it } from 'vitest'
import { PulseRuntime, VirtualClock, type LaneProgram } from '@hunterzhu/pulse-runtime'

describe('Runtime idle boundaries', () => {
  it('retains a human checkpoint after completed tool timeouts become due', async () => {
    const clock = new VirtualClock()
    let writes = 0
    const runtime = new PulseRuntime({ clock, builtinHumanEffects: true, effectExecutor: async () => { writes++; return { value: 'written once' } } })
    const point = (step: string) => ({ programId: 'checkpoint-timers', programVersion: '1', step, locals: {} })
    const program: LaneProgram = { id: 'checkpoint-timers', version: '1', step: ({ lane }) => {
      if (lane.resume.step === 'start') {
        return { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, attemptTimeoutMs: 30, deadlineAt: 50 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('ask') }
      }
      return { actions: [{ type: 'submit_effects', effects: [{ key: 'confirm', kind: 'human', concurrencyClass: 'none', input: { prompt: 'Continue?' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('finish') }
    } }
    runtime.createAgent('retain one write', program)
    await runtime.waitForIdle()
    expect(runtime.state.effects.get('effect-1')?.outcome?.status).toBe('succeeded')
    expect(runtime.state.effects.get('effect-2')?.state).toBe('running')
    clock.advance(100)
    await expect(runtime.checkpointHumanWait()).resolves.toBe(true)
    expect(writes).toBe(1)
    expect(runtime.state.effects.get('effect-2')?.outcome).toBeUndefined()
  })

  it('rejects a checkpoint while an active human deadline is due', async () => {
    const clock = new VirtualClock()
    const runtime = new PulseRuntime({ clock })
    const program: LaneProgram = { id: 'due-human-deadline', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'confirm', kind: 'human', concurrencyClass: 'none', input: {}, deadlineAt: 30 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'due-human-deadline', programVersion: '1', step: 'finish', locals: {} } }) }
    runtime.createAgent('respect human timeout', program)
    await runtime.waitForIdle()
    clock.advance(31)
    await expect(runtime.checkpointHumanWait()).resolves.toBe(false)
    runtime.tick()
    expect(runtime.state.effects.get('effect-1')?.outcome?.error?.code).toBe('TIMEOUT')
  })

  it('waitForIdle drains timers that are already due', async () => {
    const runtime = new PulseRuntime({ clock: new VirtualClock() })
    let fired = false
    runtime.clock.schedule(0, () => { fired = true })

    await runtime.waitForIdle()

    expect(fired).toBe(true)
  })

  it('shutdown drains timers that are already due before stopping', async () => {
    const runtime = new PulseRuntime({ clock: new VirtualClock() })
    let fired = false
    runtime.clock.schedule(0, () => { fired = true })

    await expect(runtime.shutdown()).resolves.toMatchObject({ status: 'stopped' })
    expect(fired).toBe(true)
  })
})
