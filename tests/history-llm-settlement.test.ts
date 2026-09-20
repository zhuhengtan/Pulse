import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'

describe('LLM Effect history settlement', () => {
  it('archives the fixed request inputs and validated output in the owner Lane', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { text: 'answer', finishReason: 'stop' }, privacy: 'public' }) })
    const program = {
      id: 'history-settlement',
      version: '1',
      step: ({ lane }: { lane: any }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects' as const, effects: [{ key: 'reason', kind: 'llm' as const, concurrencyClass: 'llm' as const, input: { task: 'reason', instruction: 'answer the question' } }], wait: { onUnsatisfied: 'resume_with_error' as const } }], next: { programId: 'history-settlement', programVersion: '1', step: 'finish', locals: {} } }
        : { actions: [{ type: 'complete' as const, result: { done: true } }], next: { programId: 'history-settlement', programVersion: '1', step: 'finish', locals: {} } },
    }
    const { agentId, laneId } = runtime.createAgent('history', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const history = runtime.state.lanes.get(laneId)!.context.history
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ effectId: 'effect-1', instruction: 'answer the question', resultRefs: [], result: 'result-1', resultSelection: [], output: { text: 'answer', finishReason: 'stop' }, privacy: 'public' })
  })
})
