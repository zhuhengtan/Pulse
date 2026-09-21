import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

describe('DSL terminal NextStepTarget', () => {
  it('compiles a complete target into the same StepTransaction', async () => {
    const program = defineLaneProgram({ id: 'dsl-complete-target', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ next: { complete: { value: { done: true }, children: 'reject_if_active' } } }))
    })
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('complete target', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const lane = runtime.state.lanes.get(laneId)!
    expect(runtime.state.results.get(lane.resultRef!)?.value).toEqual({ done: true })
  })

  it('compiles a fail target into a structured terminal action', async () => {
    const program = defineLaneProgram({ id: 'dsl-fail-target', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ next: { fail: { code: 'DSL_REJECTED', message: 'rejected by policy', retryable: false } } }))
    })
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('fail target', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure).toMatchObject({ error: { code: 'DSL_REJECTED', retryable: false } })
  })
})
