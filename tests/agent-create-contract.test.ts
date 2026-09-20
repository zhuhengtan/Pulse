import { describe, expect, it } from 'vitest'
import { PulseRuntime, type LaneProgram } from '@pulse/runtime'

const program: LaneProgram = { id: 'agent-contract', version: '1', step: () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'agent-contract', programVersion: '1', step: 'start', locals: {} } }) }

describe('createAgent DSL contract', () => {
  it('stores policy and limits references and applies priority and lane limits', () => {
    const runtime = new PulseRuntime()
    const created = runtime.createAgent({ goal: 'configured agent', program, priority: 'high', policy: { id: 'workspace-policy@1' }, limits: { id: 'interactive@1', maxActiveLanes: 3 } })
    expect(runtime.state.agents.get(created.agentId)).toMatchObject({ policyId: 'workspace-policy@1', limitsId: 'interactive@1', maxActiveLanes: 3 })
    expect(runtime.state.lanes.get(created.laneId)?.priority).toBe(1)
  })

  it('enforces an agent timeout using the injected runtime clock', async () => {
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1 })
    const waiting: LaneProgram = { id: 'agent-timeout', version: '1', step: () => ({ actions: [{ type: 'wait', spec: { dependencies: [], mode: 'all', onUnsatisfied: 'resume_with_error' } }], next: { programId: 'agent-timeout', programVersion: '1', step: 'start', locals: {} } }) }
    const created = runtime.createAgent({ goal: 'timed agent', program: waiting, limits: { timeoutMs: 10 } })
    runtime.tick()
    runtime.clock.set(10)
    const outcome = await runtime.runAgent(created.agentId, 2)
    expect(outcome).toMatchObject({ status: 'cancelled', reason: 'TIMEOUT' })
  })

  it('rejects malformed agent limits before creating state', () => {
    const runtime = new PulseRuntime()
    expect(() => runtime.createAgent({ goal: 'invalid', program, limits: { timeoutMs: -1 } })).toThrow('INVALID_AGENT_TIMEOUT')
    expect(runtime.state.agents.size).toBe(0)
  })
})
