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
})
