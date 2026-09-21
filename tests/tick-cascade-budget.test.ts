import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('Tick cascade budget', () => {
  it('spreads a large cancellation tree across bounded ticks', () => {
    const worker: LaneProgram = { id: 'cascade-worker', version: '1', step: () => ({ actions: [], next: point('cascade-worker', 'hold') }) }
    const parent: LaneProgram = {
      id: 'cascade-parent',
      version: '1',
      step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'fork', affinityAck: true, lanes: Array.from({ length: 16 }, (_, index) => ({ key: `child-${index}`, goal: `child-${index}`, program: point('cascade-worker', 'hold') })) }], next: point('cascade-parent', 'hold') }
        : { actions: [], next: point('cascade-parent', 'hold') },
    }
    const runtime = new PulseRuntime({ maxTickMs: 0, maxTotalLanes: 256 })
    runtime.register(worker)
    const { agentId } = runtime.createAgent({ goal: 'large cancellation tree', program: parent, maxActiveLanes: 256 })
    runtime.tick()
    expect(runtime.state.lanes.size).toBe(17)

    runtime.requestCancel(agentId)
    runtime.tick()
    expect(runtime.state.agents.get(agentId)?.state).toBe('cancelling')
    expect([...runtime.state.lanes.values()].every((lane) => ['cancelled', 'succeeded', 'failed'].includes(lane.status))).toBe(true)

    let ticks = 0
    while (runtime.state.agents.get(agentId)?.state === 'cancelling' && ticks < 64) {
      runtime.tick()
      ticks++
    }
    expect(ticks).toBeGreaterThan(0)
    expect(runtime.state.agents.get(agentId)?.state).toBe('cancelled')
    expect([...runtime.state.lanes].every(([, lane]) => ['cancelled', 'succeeded', 'failed'].includes(lane.status))).toBe(true)
  })
})
