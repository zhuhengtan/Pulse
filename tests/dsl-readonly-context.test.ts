import { describe, expect, it } from 'vitest'
import { defineLaneProgram, PulseRuntime } from '../packages/runtime/src/index.js'

describe('DSL readonly context views', () => {
  it.each(['laneState', 'global'] as const)('rejects direct writes to %s', async (view) => {
    const program = defineLaneProgram({ id: `readonly-${view}`, version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => {
        if (view === 'laneState') (ctx.laneState as { touched?: boolean }).touched = true
        else (ctx.global as { touched?: boolean }).touched = true
        return { actions: [{ type: 'complete', result: { unreachable: true } }], next: 'start' }
      })
    })
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('readonly context', program)

    expect((await runtime.run(agentId)).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('STEP_FAILED')
    expect(runtime.state.effects.size).toBe(0)
    expect(runtime.state.lanes.get(laneId)?.context.state).toEqual({})
  })
})
