import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('Tick cascade budget', () => {
  it.each([{ maxTickMs: 0 }, { maxTickMs: 1000, maxLaneStepsPerTick: 1 }])('drains ready continuations after a budget yield while an unrelated effect stays pending: %j', async budget => {
    const runtime = new PulseRuntime({ ...budget, effectExecutor: async (effect, signal) => {
      if (effect.key !== 'held') return { value: { done: true } }
      return await new Promise<{ value: null }>(resolve => signal.addEventListener('abort', () => resolve({ value: null }), { once: true }))
    } })
    const held: LaneProgram = { id: 'held-neighbor', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'held', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('held-neighbor', 'done') }
      : { actions: [{ type: 'complete', result: null }], next: point('held-neighbor', 'done') } }
    const ready: LaneProgram = { id: 'ready-neighbor', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'quick', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('ready-neighbor', 'verify') }
      : lane.resume.step === 'verify' ? { actions: [], next: point('ready-neighbor', 'done') }
        : { actions: [{ type: 'complete', result: { verified: true } }], next: point('ready-neighbor', 'done') } }
    try {
      runtime.createAgent('held neighbor', held)
      for (let index = 0; index < 4 && ![...runtime.state.effects.values()].some(effect => effect.key === 'held' && effect.state === 'running'); index++) runtime.tick()
      expect([...runtime.state.effects.values()].find(effect => effect.key === 'held')?.state).toBe('running')
      const { laneId } = runtime.createAgent('ready neighbor', ready)
      runtime.tick()
      runtime.tick()
      // No manual ticks or release of the neighboring request during this wait.
      await expect.poll(() => runtime.state.lanes.get(laneId)?.status, { timeout: 2_000, interval: 10 }).toBe('succeeded')
      expect([...runtime.state.effects.values()].find(effect => effect.key === 'held')?.state).toBe('running')
      expect(runtime.state.results.get(runtime.state.lanes.get(laneId)!.resultRef!)?.value).toEqual({ verified: true })
    } finally { await runtime.shutdown() }
  })

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
