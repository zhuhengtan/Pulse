import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

describe('Result summary budget', () => {
  it('drops oversized summaries while retaining the immutable result', async () => {
    const program: LaneProgram = {
      id: 'summary-budget',
      version: '1',
      step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'summary-budget', programVersion: '1', step: 'finish', locals: {} } }
        : { actions: [{ type: 'complete', result: { done: true } }], next: { programId: 'summary-budget', programVersion: '1', step: 'finish', locals: {} } },
    }
    const runtime = new PulseRuntime({ maxResultSummaryBytes: 8, effectExecutor: async () => ({ value: { payload: 'kept' }, summary: { too: 'large' } }) })
    const { agentId } = runtime.createAgent('summary budget', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const result = [...runtime.state.results.values()].find((record) => record.effectId === 'effect-1')
    expect(result?.value).toEqual({ payload: 'kept' })
    expect(result?.summary).toBeUndefined()
    expect(runtime.state.events.some((event) => event.type === 'result.summary_rejected')).toBe(true)
  })
})
