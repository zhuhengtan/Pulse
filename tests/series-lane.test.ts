import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram, defineSeriesLane } from '@hunterzhu/pulse-runtime'

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

  it('preserves a ProgramRef custom entry and locals', async () => {
    const member = defineLaneProgram({ id: 'series-ref-member', version: '1' }, (builder) => {
      builder.addStep('custom', (ctx) => ({ actions: [{ type: 'complete', result: { marker: ctx.lane.resume.locals } }], next: 'custom' }))
    })
    const series = defineSeriesLane({ id: 'series-ref', version: '1', member: { programId: member.id, programVersion: member.version, step: 'custom', locals: { seed: 'preserved' } }, keys: ['one'] })
    const runtime = new PulseRuntime()
    runtime.register(member)
    runtime.register(series)
    const { agentId, laneId } = runtime.createAgent('series ref', series)

    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const resultRef = runtime.state.lanes.get(laneId)?.resultRef
    expect(runtime.state.results.get(resultRef!)?.value).toEqual({ results: { one: { status: 'succeeded', result: { marker: { seed: 'preserved' } } } } })
  })
})
