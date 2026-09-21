import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

describe('DSL dynamic wait contract', () => {
  it('resolves callback-based targets and exposes the WaitResolution', async () => {
    const program = defineLaneProgram({ id: 'dynamic-wait', version: '1' }, (builder) => {
      builder.addStep('submit', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'probe', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: 'wait' }))
      builder.addWaitStep('wait', {
        targets: () => [{ key: 'probe', target: { kind: 'effect', id: 'effect-1' }, condition: 'settled' }],
        onResolved: (resolution) => ({ complete: { value: { status: resolution.status, dependency: resolution.dependencies.probe.state } } }),
        onUnsatisfied: () => ({ fail: { code: 'WAIT_FAILED', message: 'wait was not satisfied' } }),
      })
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const { agentId, laneId } = runtime.createAgent('dynamic wait', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const resultRef = runtime.state.lanes.get(laneId)?.resultRef
    expect(runtime.state.results.get(resultRef!)?.value).toEqual({ status: 'satisfied', dependency: 'settled' })
  })
})
