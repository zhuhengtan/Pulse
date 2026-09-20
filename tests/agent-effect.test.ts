import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('built-in Child Agent Effect host', () => {
  it('starts a registered child Program and resumes the parent on child success', async () => {
    const runtime = new PulseRuntime()
    const child: LaneProgram = { id: 'child-program', version: '1', step: () => ({ actions: [{ type: 'complete', result: { child: true } }], next: point('child-program', 'done') }) }
    const parent: LaneProgram = { id: 'parent-program', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'child', kind: 'agent', concurrencyClass: 'agent', input: { goal: 'child goal', programId: child.id, programVersion: child.version } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('parent-program', 'finish') }
      : { actions: [{ type: 'complete', result: { childOutcome: resumeInput?.type === 'wait' } }], next: point('parent-program', 'finish') } }
    runtime.register(child)
    const { agentId } = runtime.createAgent('parent', parent)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect([...runtime.state.agents.values()].some((agent) => agent.goal === 'child goal')).toBe(true)
    expect(runtime.state.effects.get('effect-1')?.childAgentId).toBeDefined()
    expect(runtime.state.events.some((event) => event.type === 'agent.effect_started')).toBe(true)
  })

  it('fails invalid Agent Effect input without invoking the generic executor', async () => {
    const runtime = new PulseRuntime()
    const parent: LaneProgram = { id: 'bad-agent', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child', kind: 'agent', concurrencyClass: 'agent', input: {} }], wait: { onUnsatisfied: 'fail_lane' } }], next: point('bad-agent', 'done') }) }
    const { agentId } = runtime.createAgent('parent', parent)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.effects.get('effect-1')?.outcome?.error?.code).toBe('INVALID_AGENT_EFFECT_INPUT')
  })

  it('limits Child Agent recursion and records parent/depth metadata', async () => {
    const runtime = new PulseRuntime({ maxAgentDepth: 1 })
    const recursive: LaneProgram = { id: 'recursive', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'nested', kind: 'agent', concurrencyClass: 'agent', input: { goal: 'nested', programId: 'recursive', programVersion: '1' } }], wait: { onUnsatisfied: 'fail_lane' } }], next: point('recursive', 'done') }
      : { actions: [{ type: 'complete', result: { done: true } }], next: point('recursive', 'done') } }
    runtime.register(recursive)
    const parent: LaneProgram = { id: 'recursive-parent', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child', kind: 'agent', concurrencyClass: 'agent', input: { goal: 'child', programId: recursive.id, programVersion: recursive.version } }], wait: { onUnsatisfied: 'fail_lane' } }], next: point('recursive-parent', 'done') }) }
    const { agentId } = runtime.createAgent('parent', parent)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    const child = [...runtime.state.agents.values()].find((agent) => agent.parentAgentId === agentId)
    expect(child?.depth).toBe(1)
    expect([...runtime.state.effects.values()].some((effect) => effect.outcome?.error?.code === 'MAX_AGENT_DEPTH')).toBe(true)
  })

  it('propagates the waiting parent score to the child root', async () => {
    const runtime = new PulseRuntime()
    let observedFloor: number | undefined
    const child: LaneProgram = { id: 'priority-child', version: '1', step: ({ lane }) => { observedFloor = lane.inheritedFloor; return { actions: [{ type: 'complete', result: { ok: true } }], next: point('priority-child', 'done') } } }
    const parent: LaneProgram = { id: 'priority-parent', version: '1', step: ({ lane }) => lane.resume.step === 'start' ? ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child', kind: 'agent', concurrencyClass: 'agent', input: { goal: 'child', programId: child.id, programVersion: child.version } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('priority-parent', 'done') }) : ({ actions: [{ type: 'complete', result: { ok: true } }], next: point('priority-parent', 'done') }) }
    runtime.register(child)
    const { agentId, laneId } = runtime.createAgent('parent', parent)
    runtime.state.lanes.get(laneId)!.priority = 9
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const childAgent = [...runtime.state.agents.values()].find((agent) => agent.parentAgentId === agentId)
    const childRoot = childAgent ? runtime.state.lanes.get(childAgent.rootLaneId) : undefined
    expect(observedFloor).toBe(9)
    expect(childRoot?.inheritedFloor).toBeUndefined()
    expect(runtime.state.events.some((event) => event.type === 'agent.effect_started')).toBe(true)
  })

  it('keeps a detached child running after its parent is cancelled and exposes background scope state', () => {
    const runtime = new PulseRuntime()
    const child: LaneProgram = { id: 'detached-child', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'timer', kind: 'timer', concurrencyClass: 'none', input: { delayMs: 5 } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('detached-child', 'finish') }
      : { actions: [{ type: 'complete', result: { child: true } }], next: point('detached-child', 'finish') } }
    const parent: LaneProgram = { id: 'detached-parent', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child', kind: 'agent', concurrencyClass: 'agent', input: { goal: 'detached child', programId: child.id, programVersion: child.version } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('detached-parent', 'finish') }) }
    runtime.register(child)
    const { agentId: parentAgentId } = runtime.createAgent('parent', parent)
    runtime.tick()
    const childAgent = [...runtime.state.agents.values()].find((agent) => agent.parentAgentId === parentAgentId)
    expect(childAgent).toBeDefined()
    const childAgentId = childAgent!.id
    expect(runtime.detachAgent(childAgentId)).toMatchObject({ agentId: childAgentId, detached: true })
    runtime.cancelAgent(parentAgentId)
    expect(runtime.state.agents.get(childAgentId)?.state).toBe('running')
    expect(runtime.backgroundAgents()).toEqual([expect.objectContaining({ agentId: childAgentId, detached: true })])

    runtime.clock.advance(5)
    runtime.tick()
    runtime.tick()
    expect(runtime.state.agents.get(childAgentId)?.state).toBe('succeeded')
    expect(runtime.state.effects.get('effect-1')?.outcome?.status).toBe('succeeded')
    expect(runtime.mutationLog.entries.some((entry) =>
      entry.mutations.some((mutation) => mutation.op === 'setAgent' && mutation.agentId === childAgentId && mutation.record.state === 'succeeded')
    )).toBe(true)
    runtime.attachAgent(childAgentId)
    expect(runtime.backgroundAgents()).toEqual([])
  })

  it('does not partially detach an Agent when the audit event exceeds storage limits', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxEventLogBytes: 1 } })
    const program: LaneProgram = { id: 'detach-storage-limit', version: '1', step: () => ({ actions: [], next: point('detach-storage-limit', 'done') }) }
    const { agentId } = runtime.createAgent('detach storage limit', program)
    expect(() => runtime.detachAgent(agentId)).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.state.agents.get(agentId)?.detached).toBeUndefined()
    expect(runtime.state.events).toHaveLength(0)
  })
})
