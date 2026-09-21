import { describe, expect, it } from 'vitest'
import { PulseRuntime, createAgent, createRuntimeState, validateStep } from '@pulse/runtime'
import type { EffectRecord, LaneProgram } from '@pulse/runtime'

const point = (step: string, programId = 'join') => ({ programId, programVersion: '1', step, locals: {} })

describe('advanced any/quorum waits', () => {
  it('accepts any and quorum modes and rejects invalid quorum values atomically', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'join', point('start'))
    for (const id of ['effect-1', 'effect-2']) state.effects.set(id, { id, agentId: root.agentId, ownerLaneId: root.id, key: id, kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'queued', attemptId: `${id}-attempt-1`, attemptNo: 1, executionState: 'local', sideEffectState: 'none' } satisfies EffectRecord)
    const anyResult = validateStep(state, root.id, { actions: [{ type: 'wait', spec: { dependencies: [{ key: 'first', target: { kind: 'effect', id: 'effect-1' }, condition: 'settled' }, { key: 'second', target: { kind: 'effect', id: 'effect-2' }, condition: 'settled' }], mode: 'any', onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: point('next') })
    expect('rejection' in anyResult).toBe(false)
    const badQuorum = validateStep(state, root.id, { actions: [{ type: 'wait', spec: { dependencies: [{ key: 'first', target: { kind: 'effect', id: 'effect-1' }, condition: 'settled' }, { key: 'second', target: { kind: 'effect', id: 'effect-2' }, condition: 'settled' }], mode: 'quorum', quorum: 3, onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: point('next') })
    expect('rejection' in badQuorum && badQuorum.rejection.code).toBe('INVALID_WAIT_QUORUM')
    expect(state.lanes.size).toBe(1)
  })

  it('resumes an any wait after the first acceptable dependency settles', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'join', version: '1', step: ({ lane }) => {
      if (lane.resume.step === 'start') return { actions: [{ type: 'submit_effects', effects: [{ key: 'first', kind: 'tool', concurrencyClass: 'tool', input: {} }, { key: 'second', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('wait') }
      if (lane.resume.step === 'wait') return { actions: [{ type: 'wait', spec: { dependencies: [{ key: 'first', target: { kind: 'effect', id: 'effect-1' }, condition: 'settled' }, { key: 'second', target: { kind: 'effect', id: 'effect-2' }, condition: 'settled' }], mode: 'any', onUnsatisfied: 'resume_with_error', reason: 'join' } }], next: point('finish') }
      return { actions: [{ type: 'complete', result: { ok: true } }], next: point('finish') }
    } }
    const { agentId, laneId } = runtime.createAgent('join', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('waiting')
    runtime.completeEffect('effect-1', { value: { winner: true } })
    expect(runtime.state.lanes.get(laneId)?.status).toBe('ready')
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('succeeded')
    expect(runtime.state.agents.get(agentId)?.state).toBe('running')
  })

  it('wakes a waiting lane through the TimerWheel when its deadline expires', () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000, effectExecutor: async () => await new Promise(() => undefined) })
    const program: LaneProgram = { id: 'deadline', version: '1', step: ({ lane }) => {
      if (lane.resume.step === 'start') return { actions: [{ type: 'submit_effects', effects: [{ key: 'slow', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('wait', 'deadline') }
      if (lane.resume.step === 'wait') return { actions: [{ type: 'wait', spec: { dependencies: [{ key: 'slow', target: { kind: 'effect', id: 'effect-1' }, condition: 'settled' }], mode: 'all', deadlineAt: 5, onUnsatisfied: 'resume_with_error', reason: 'dependency' } }], next: point('finish', 'deadline') }
      return { actions: [{ type: 'complete', result: { timedOut: lane.pendingResumeInput?.type === 'wait' && lane.pendingResumeInput.resolution.error?.code === 'WAIT_DEADLINE_EXCEEDED' } }], next: point('finish', 'deadline') }
    } }
    const { laneId } = runtime.createAgent('deadline', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('waiting')
    runtime.clock.advance(5)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('succeeded')
    expect([...runtime.state.results.values()].some((result) => JSON.stringify(result.value).includes('timedOut'))).toBe(true)
  })
})
