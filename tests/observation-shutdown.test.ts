import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@pulse/runtime'

describe('observation inbox and shutdown', () => {
  it('keeps trace outside the fact log and exposes it to inspection', async () => {
    const program = defineLaneProgram({ id: 'observe', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => { ctx.trace({ kind: 'diagnostic', data: { phase: 'start' } }); return { actions: [{ type: 'complete', result: { ok: true } }], next: 'start' } })
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('observe', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.observationInbox.size).toBe(1)
    expect(runtime.state.events.some((event) => event.type === 'trace')).toBe(false)
    expect(runtime.inspect()).toMatchObject({ observationsPending: 1 })
  })

  it('returns an explicit shutdown status and unresolved list', async () => {
    const runtime = new PulseRuntime()
    const program = defineLaneProgram({ id: 'shutdown', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'start' }))
    })
    runtime.createAgent('shutdown', program)
    const result = await runtime.shutdown()
    expect(result.status).toBe('stopped')
    expect(result.unresolvedEffectIds).toEqual([])
    expect(() => runtime.createAgent('after shutdown', program)).toThrow('RUNTIME_SHUTTING_DOWN')
  })
})
