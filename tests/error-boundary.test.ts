import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

describe('DSL error boundary', () => {
  it('turns a synchronous Step failure into an explicit boundary transition', async () => {
    let attempts = 0
    const program = defineLaneProgram({ id: 'boundary', version: '1' }, (builder) => {
      builder.onErrorBoundary((error) => { expect(error.code).toBe('STEP_FAILED'); return 'recover' })
      builder.addStep('start', () => { attempts += 1; if (attempts === 1) throw new Error('transient step'); return { next: 'recover' } })
      builder.addStep('recover', () => ({ actions: [{ type: 'complete', result: { recovered: true } }], next: 'recover' }))
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('boundary', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.events.some((event) => event.type === 'step.committed')).toBe(true)
  })
})
