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

  it('validates strict outputSchema against the structured payload', async () => {
    const program = defineLaneProgram({ id: 'react-output-schema', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', {
        instruction: 'verify',
        outputSchema: z.object({ passed: z.literal(true) }),
        onFinish: { text: () => ({ fail: { code: 'UNEXPECTED_TEXT', message: 'text finish is not allowed' } }), structured: { schema: z.object({ passed: z.literal(true) }), onParsed: (value) => ({ complete: { value } }) } },
      })
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { passed: true } }) })
    const { agentId, laneId } = runtime.createAgent('strict react schema', program)

    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.results.get(runtime.state.lanes.get(laneId)?.resultRef as string)?.value).toEqual({ passed: true })
  })

  it('preserves results, findings, artifacts, and events across ReAct tool turns', async () => {
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'react-input-contract', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', {
        instruction: 'inspect all inputs',
        toolAllow: ['read'],
        maxTurns: 3,
        inputs: () => ({ results: ['result-1'], findings: ['finding-1'], artifacts: ['artifact-1'], events: ['event-1'] }),
        onFinish: { text: () => 'done' },
      })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      requests.push(structuredClone(effect.input))
      return effect.key === 'reason-turn-1' ? { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'a' } }] } } : { value: { text: 'done', finishReason: 'stop', toolCalls: [] } }
    } })
    const created = runtime.createAgent('input contract', program)
    const lane = runtime.state.lanes.get(created.laneId)!
    runtime.state.results.set('result-1', { id: 'result-1', producer: { kind: 'lane', id: lane.id }, value: { source: true }, privacy: 'public', derivedFrom: [], storageState: 'memory', pinCount: 0 })
    runtime.state.results.set('finding-1', { id: 'finding-1', kind: 'finding', producer: { kind: 'lane', id: lane.id }, value: { source: true }, statement: 'source', evidenceRefs: [], agentId: created.agentId, laneId: lane.id, privacy: 'public', derivedFrom: [], storageState: 'memory', pinCount: 0 } as any)
    runtime.state.artifacts.set('artifact-1', { ref: 'artifact-1', agentId: created.agentId, mediaType: 'text/plain', sizeBytes: 1, contentHash: 'hash', contentBase64: 'YQ==', privacy: 'public', storageState: 'memory', pinCount: 0 })
    lane.visibleResultRefs = new Set(['result-1', 'finding-1'])
    expect((await runtime.start(created.agentId).outcome()).status).toBe('succeeded')
    const llmRequests = requests.filter((request) => request.request?.contextSpec !== undefined)
    expect(llmRequests).toHaveLength(2)
    expect(llmRequests[0]?.inputs).toEqual({ results: ['result-1'], findings: ['finding-1'], artifacts: ['artifact-1'], events: ['event-1'] })
    expect(llmRequests[1]?.inputs).toMatchObject({ findings: ['finding-1'], artifacts: ['artifact-1'], events: ['event-1'] })
    expect(llmRequests[1]?.inputs.results).toEqual(expect.arrayContaining(['result-1']))
  })

  it('does not expose the internal raw Result reader on StepContext', async () => {
    let symbols: symbol[] = []
    const program = defineLaneProgram({ id: 'react-context-surface', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => { symbols = Object.getOwnPropertySymbols(ctx); return { actions: [{ type: 'complete', result: { symbolCount: symbols.length } }], next: 'start' } })
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('context surface', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(symbols).toEqual([])
  })
})
