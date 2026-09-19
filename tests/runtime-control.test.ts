import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('runtime control boundaries', () => {
  it('fails a Lane after the configured consecutive control-error limit', () => {
    const runtime = new PulseRuntime({ maxConsecutiveControlErrors: 2 })
    const program: LaneProgram = { id: 'control-loop', version: '1', step: () => ({ actions: [], next: point('control-loop', '') }) }
    const { laneId } = runtime.createAgent('invalid program output', program)
    runtime.tick()
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'lane.failed' && (event.data as any)?.code === 'CONTROL_ERROR_LOOP')).toBe(true)
  })

  it('turns a stuck attempt timeout into a terminal outcome without waiting forever', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'attempt-timeout', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'slow', kind: 'tool', concurrencyClass: 'tool', input: {}, attemptTimeoutMs: 5, cancelGraceMs: 0 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('attempt-timeout', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('attempt-timeout', 'finish') } }
    const { agentId, laneId } = runtime.createAgent('timeout', program)
    runtime.tick()
    runtime.clock.advance(5)
    expect(runtime.state.effects.get('effect-1')?.outcome?.status).toBe('cancelled')
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.lanes.get(laneId)?.status).toBe('succeeded')
  })

  it('lets an Agent reach cancelled while an uncooperative Executor remains quarantined', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'cancel-quarantine', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'write', cancelGraceMs: 10 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('cancel-quarantine', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('cancel-quarantine', 'finish') } }
    const { agentId, laneId } = runtime.createAgent('cancel', program)
    runtime.tick()
    runtime.cancelAgent(agentId)
    runtime.clock.advance(10)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('cancelled')
    expect(outcome.unresolvedEffectIds).toEqual(['effect-1'])
    expect(runtime.state.lanes.get(laneId)?.unresolvedEffectIds).toEqual(['effect-1'])
    expect(runtime.state.effects.get('effect-1')?.state).toBe('reconcile_required')
  })

  it('does not report success when a root Lane is blocked without runnable work', async () => {
    const runtime = new PulseRuntime({ maxRunning: { tool: 0 } })
    const program: LaneProgram = { id: 'blocked', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'blocked', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('blocked', 'done') }) }
    const { agentId } = runtime.createAgent('blocked', program)
    runtime.tick()
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.events.some((event) => event.type === 'runtime.idle_blocked')).toBe(true)
  })

  it('exposes lane, effect, and quarantine reasons through explain', () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'explain', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('explain', 'done') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('explain', 'done') } }
    const { laneId } = runtime.createAgent('diagnose', program)
    runtime.tick()
    expect(runtime.explain(laneId)).toMatchObject({ lanes: [{ id: laneId, status: 'succeeded', consecutiveControlErrors: 0 }], effects: [{ id: 'effect-1', state: 'running' }] })
  })
})
