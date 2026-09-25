import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { z } from 'zod'

describe('DSL ReAct contract', () => {
  it('submits independent tool calls together by default', async () => {
    const started: string[] = []
    let calls = 0
    const program = defineLaneProgram({ id: 'default-parallel-effects', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 4, maxToolsPerTurn: 4, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { started.push(String((effect.input as { name?: string }).name)); return { value: 'done' } }
      if (++calls === 1) return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'read-a', input: {} }, { name: 'read-b', input: {} }] } }
      expect(started).toEqual(['read-a', 'read-b'])
      return { value: { text: 'done', finishReason: 'stop', toolCalls: [] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(started).toHaveLength(2)
  })

  it('prefers an exact underscore tool name over a dotted-name alias', async () => {
    const executed: string[] = []
    let models = 0
    const program = defineLaneProgram({ id: 'exact-tool-name', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', toolAllow: ['foo.bar', 'foo_bar'], onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { executed.push(String((effect.input as { name?: string }).name)); return { value: 'done' } }
      if (++models === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'foo_bar', input: {} }] } }
      return { value: { text: 'done', finishReason: 'stop' } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(executed).toEqual(['foo_bar'])
  })

  it('rejects an ambiguous underscore alias instead of dispatching either tool', async () => {
    let tools = 0
    const program = defineLaneProgram({ id: 'ambiguous-tool-alias', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', toolAllow: ['foo.bar_baz', 'foo_bar.baz'], onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { tools++; return { value: 'unexpected' } }
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'foo_bar_baz', input: {} }] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'ACTION_TOOL_NOT_ALLOWED' } })
    expect(tools).toBe(0)
  })

  it('never accepts or executes a token-truncated response', async () => {
    let finished = false
    let toolRuns = 0
    const program = defineLaneProgram({ id: 'truncated-react', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', onFinish: () => { finished = true; return { complete: {} } } })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') toolRuns++
      return { value: { text: 'partial', finishReason: 'length', toolCalls: [{ name: 'write', input: {} }] } }
    } })
    const { agentId, laneId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('OUTPUT_TRUNCATED')
    expect(finished).toBe(false)
    expect(toolRuns).toBe(0)
  })

  it.each([false, true])('bounds truncation recovery without executing partial calls (repeat=%s)', async (repeat) => {
    let calls = 0
    let tools = 0
    let finished = false
    const program = defineLaneProgram({ id: 'recover-truncation', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 4, maxTruncationRetries: 1, onFinish: () => { finished = true; return { complete: {} } } })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') tools++
      calls++
      if (calls === 1 || repeat) return { value: { text: 'partial', finishReason: 'length', toolCalls: [{ name: 'write', input: {} }] } }
      expect(JSON.stringify(effect.input)).toContain('Runtime recovery notice')
      return { value: { text: 'Concise final answer', finishReason: 'stop', toolCalls: [] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe(repeat ? 'failed' : 'succeeded')
    expect(calls).toBe(2)
    expect(tools).toBe(0)
    expect(finished).toBe(!repeat)
  })

  it('does not let truncation recovery exceed maxTurns', async () => {
    let calls = 0
    const program = defineLaneProgram({ id: 'truncation-budget', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 1, maxTruncationRetries: 1, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => { calls++; return { value: { text: '', finishReason: 'length', toolCalls: [] } } } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(calls).toBe(1)
  })

  it('serializes mutation batches in the runtime before requesting the next model turn', async () => {
    let modelCalls = 0
    let toolCalls = 0
    const program = defineLaneProgram({ id: 'small-batches', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 10, maxToolsPerTurn: 4, serialTools: ['write'], onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { toolCalls++; return { value: 'done' } }
      modelCalls++
      if (modelCalls === 1) return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'write', input: {} }, { name: 'write', input: {} }] } }
      expect(toolCalls).toBe(2)
      return { value: { text: 'done', finishReason: 'stop', toolCalls: [] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(toolCalls).toBe(2)
  })

  it('re-evaluates a proposed write batch after one operation instead of draining the queue', async () => {
    let models = 0
    let tools = 0
    const program = defineLaneProgram({ id: 'one-write-per-turn', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 5, serialTools: ['write'], stopAfterFirstSerialTool: true, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { tools++; return { value: 'applied' } }
      models++
      if (models === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'write', input: { step: 1 } }, { name: 'write', input: { step: 2 } }] } }
      expect(JSON.stringify(effect.input)).toContain('remaining 1 proposed tool calls were NOT executed')
      return { value: { text: 'done', finishReason: 'stop' } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(tools).toBe(1)
    expect(models).toBe(2)
  })

  it.each([false, true])('stops queued mutations after a failure rather than executing dependent writes (nonzero exit=%s)', async (nonzeroExit) => {
    let models = 0
    let calls = 0
    const program = defineLaneProgram({ id: 'queue-failure', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 5, serialTools: ['write'], onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { calls++; return nonzeroExit ? { value: { code: 1, stderr: 'failed' } } : { status: 'failed', executionState: 'failed', error: { code: 'CONFLICT', message: 'changed' } } }
      if (++models === 1) return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'write', input: { step: 1 } }, { name: 'write', input: { step: 2 } }] } }
      expect(JSON.stringify(effect.input)).toContain('1 queued tool calls were NOT executed')
      return { value: { text: 'blocked', finishReason: 'stop', toolCalls: [] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    await runtime.start(agentId).outcome()
    expect(calls).toBe(1)
  })

  it('returns failed tool outcomes to the model and stops repeated failures', async () => {
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'failed-tools', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 20, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { status: 'failed', executionState: 'failed', error: { code: 'APPROVAL_DENIED', message: 'Permission denied for web.fetch', retryable: false } }
      requests.push(effect.input)
      return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'web.fetch', input: { url: 'https://example.com' } }] } }
    } })
    const { agentId, laneId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1].inputs.conversation)).toContain('APPROVAL_DENIED')
    expect(JSON.stringify(requests[1].inputs.conversation)).toContain('Permission denied for web.fetch')
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('REPEATED_TOOL_FAILURE')
  })

  it('resets consecutive failure detection after successful independent work', async () => {
    let models = 0
    let tools = 0
    const program = defineLaneProgram({ id: 'independent-progress', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 10, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        if (++tools % 2) return { status: 'failed', executionState: 'failed', error: { code: 'ENOENT', message: 'missing' } }
        return { value: { progress: tools } }
      }
      if (++models > 6) return { value: { text: 'Independent work done; missing item blocked', finishReason: 'stop', toolCalls: [] } }
      return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(tools).toBe(6)
  })

  it('stops immediately when the sandbox cannot initialize', async () => {
    let calls = 0
    const program = defineLaneProgram({ id: 'sandbox-blocker', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      calls++
      if (effect.kind === 'tool') return { status: 'failed', executionState: 'failed', error: { code: 'SANDBOX_SETUP_FAILED', message: 'SANDBOX_SETUP_FAILED', retryable: false } }
      return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: {} }] } }
    } })
    const { agentId } = runtime.createAgent('work', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'SANDBOX_SETUP_FAILED' } })
    expect(calls).toBe(2)
  })

  it('nudges completion and bounds repeated unchanged successful reads', async () => {
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'unchanged-tools', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'work', maxTurns: 20, onFinish: () => ({ complete: {} }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { path: 'a', content: 'unchanged' } }
      requests.push(effect.input)
      return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } }
    } })
    const { agentId, laneId } = runtime.createAgent('work', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(requests).toHaveLength(5)
    expect(JSON.stringify(requests[2].inputs.conversation)).toContain('same evidence')
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('NO_PROGRESS')
  })

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

  it('forwards tool discovery from ReAct inputs so providers receive tool definitions', async () => {
    const requests: any[] = []
    const program = defineLaneProgram({ id: 'react-tool-discovery', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', {
        instruction: 'inspect the workspace',
        toolAllow: ['fs.list'],
        inputs: () => ({ toolDiscovery: { limit: 1 } }),
        onFinish: { text: () => 'done' },
      })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { requests.push(structuredClone(effect.input)); return { value: { text: 'done', finishReason: 'stop', toolCalls: [] } } } })
    const { agentId } = runtime.createAgent('discover tools', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(requests[0]?.toolDiscovery).toEqual({ limit: 1 })
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

  it('resets a ReAct turn budget when the durable attempt token changes', async () => {
    const turns: number[] = []
    const program = defineLaneProgram({ id: 'react-reset-turns', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', {
        instruction: 'continue',
        maxTurns: 4,
        toolAllow: ['read'],
        resetTurnsOnEntry: (ctx) => {
          const global = ctx.global as Record<string, unknown> | undefined
          return typeof global?.attempt === 'number' && global.attempt > 0 ? global.attempt : undefined
        },
        onFinish: (_ref, ctx) => {
          const global = ctx.global as Record<string, unknown> | undefined
          return global?.attempt === 1 ? { complete: { value: { ok: true } } } : 'replan'
        },
      })
      builder.addStep('replan', (ctx) => {
        ctx.commitGlobal({ ops: [{ op: 'set', path: ['attempt'], value: 1 }], adoptImmediately: true })
        return { actions: [], next: 'reason' }
      })
    })
    let llm = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'llm') {
        llm++
        const turn = (effect.input as { turn: number }).turn
        turns.push(turn)
        return { value: llm <= 2 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: `call-${llm}`, name: 'read', input: {} }] } : { text: 'candidate', finishReason: 'stop', toolCalls: [] } }
      }
      return { value: { content: 'read' } }
    } })
    const { agentId } = runtime.createAgent({ goal: 'retry', program, initialGlobal: { attempt: 0 } })
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(llm).toBe(4)
    expect(turns).toEqual([1, 2, 3, 1])
  })

})
