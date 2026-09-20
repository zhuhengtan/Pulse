import { describe, expect, it } from 'vitest'
import { defineLaneProgram, PulseRuntime } from '../packages/runtime/src/index.js'

describe('development pure Step guard', () => {
  it.each([
    ['console', () => { globalThis.console.log('forbidden'); return null }],
    ['Date.now', () => globalThis.Date['now']()],
    ['Math.random', () => globalThis.Math['random']()],
    ['fetch', () => globalThis.fetch('http://127.0.0.1:1')],
    ['process', () => globalThis.process.env.NODE_ENV ?? null],
  ])('rejects dynamic %s access as PURE_STEP_VIOLATION', async (_name, access) => {
    const program = defineLaneProgram({ id: `pure-guard-${String(_name).replace(/[^a-z]+/g, '-')}`, version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'complete', result: access() as never }], next: 'start' }))
    })
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('pure guard', program)

    expect((await runtime.run(agentId)).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure?.error).toMatchObject({ code: 'PURE_STEP_VIOLATION' })
    expect(runtime.state.effects.size).toBe(0)
  })
})
