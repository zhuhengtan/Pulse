import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@pulse/runtime'
import { z } from 'zod'

describe('DSL ReAct contract', () => {
  it('supports separate text and structured finish callbacks', async () => {
    const program = defineLaneProgram({ id: 'react-structured-finish', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', {
        instruction: 'verify',
        requirements: { reasoning: 'high' },
        onFinish: {
          text: () => ({ fail: { code: 'UNEXPECTED_TEXT', message: 'structured output was required' } }),
          structured: { schema: z.object({ passed: z.boolean() }), onParsed: (value) => ({ complete: { value } }) },
        },
      })
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { text: '', structured: { passed: true }, finishReason: 'stop', toolCalls: [] } }) })
    const { agentId, laneId } = runtime.createAgent('structured react', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const resultRef = runtime.state.lanes.get(laneId)?.resultRef
    expect(runtime.state.results.get(resultRef!)?.value).toEqual({ passed: true })
  })

  it('routes an exhausted loop to a structured MAX_TURNS_REACHED error', async () => {
    const program = defineLaneProgram({ id: 'react-max-turns', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', {
        instruction: 'inspect',
        maxTurns: 1,
        onFinish: { text: () => 'done' },
        onError: (error) => ({ fail: { code: error.code, message: error.message, retryable: false } }),
      })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'call-1', name: 'read', input: {} }] } }) })
    const { agentId, laneId } = runtime.createAgent('bounded react', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure).toMatchObject({ error: { code: 'MAX_TURNS_REACHED' } })
  })
})
