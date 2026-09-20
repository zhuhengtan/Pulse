import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram, defineSeriesLane } from '@pulse/runtime'

describe('series lane template', () => {
  it('runs all members sequentially on one Lane and aggregates outcomes', async () => {
    const member = defineLaneProgram({ id: 'series-member', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => ({ actions: [{ type: 'complete', result: { goal: ctx.goal } }], next: 'start' }))
    })
    const series = defineSeriesLane({ id: 'series', version: '1', member, keys: ['a', 'b'] })
    const runtime = new PulseRuntime()
    runtime.register(series)
    const { agentId, laneId } = runtime.createAgent('batch', series)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const lane = runtime.state.lanes.get(laneId)
    const result = lane?.resultRef ? runtime.state.results.get(lane.resultRef) : undefined
    expect(result?.value).toEqual({ results: { a: { status: 'succeeded', result: { goal: 'batch [series:a]' } }, b: { status: 'succeeded', result: { goal: 'batch [series:b]' } } } })
    expect(runtime.state.lanes.size).toBe(1)
  })
})
