import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PulseRuntime, defineLaneProgram, definePlanAndExecuteLane, defineReActLane, defineScatterGatherLane } from '@pulse/runtime'

describe('DSL Human/Timer host macros', () => {
  it('compiles addTimerStep into a timer wait and resumes on fire', async () => {
    const program = defineLaneProgram({ id: 'timer-macro', version: '1' }, (builder) => {
      builder.addTimerStep('backoff', { delayMs: 4, onFire: () => 'finish' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { fired: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('timer', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  })

  it('compiles addHumanStep and validates the reply schema before onReply', async () => {
    const program = defineLaneProgram({ id: 'human-macro', version: '1' }, (builder) => {
      builder.addHumanStep('approve', { prompt: 'Approve?', schema: z.object({ approved: z.boolean() }), onReply: (reply) => reply.approved ? 'finish' : 'reject', onTimeout: () => 'reject' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { approved: true } }], next: 'finish' }))
      builder.addStep('reject', () => ({ actions: [{ type: 'fail', error: { code: 'REJECTED', message: 'not approved' } }], next: 'reject' }))
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('human', program)
    runtime.tick()
    const session = runtime.start(agentId)
    await session.reply('effect-1', { approved: true })
    expect((await session.outcome()).status).toBe('succeeded')
  })

  it('runs the plan, fork/join, synthesis, and global commit template', async () => {
    const worker = defineLaneProgram({ id: 'plan-worker', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'complete', result: { worker: true } }], next: 'start' }))
    })
    const program = definePlanAndExecuteLane({
      id: 'plan-template',
      version: '1',
      planner: { instruction: 'make a plan' },
      workers: { first: { goal: 'first', programId: worker.id, programVersion: worker.version } },
      synthesizer: { instruction: 'synthesize' },
    })
    const calls: string[] = []
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { calls.push(effect.key); return { value: effect.key === 'synthesize-llm' ? { report: 'done' } : { plan: ['first'] } } } })
    runtime.register(worker)
    const { agentId } = runtime.createAgent('template', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toEqual(['plan-llm', 'synthesize-llm'])
    expect(runtime.state.agents.get(agentId)?.globalVersions.get(1)).toEqual({ synthesis: { report: 'done' } })
  })

  it('runs a bounded ReAct tool round before accepting the final model result', async () => {
    const program = defineLaneProgram({ id: 'react-tools', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'inspect', toolAllow: ['read'], maxTurns: 3, onFinish: (result, ctx) => { ctx.mutateLane((draft) => { if (draft && typeof draft === 'object' && !Array.isArray(draft)) (draft as Record<string, unknown>).answer = result }); return 'finish' } })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const calls: string[] = []
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      calls.push(effect.key)
      if (effect.kind === 'llm' && effect.key === 'reason-turn-1') return { value: { text: '', finishReason: 'tool_calls', toolCalls: [{ toolCallId: 'provider-call-1', name: 'read', input: { path: 'a' } }] } }
      if (effect.kind === 'llm') return { value: { text: 'done', finishReason: 'stop', toolCalls: [] } }
      return { value: { content: 'file' } }
    } })
    const { agentId } = runtime.createAgent('react tools', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toEqual(['reason-turn-1', 'reason-tool-1-1', 'reason-turn-2'])
    expect(runtime.state.toolCallCorrelations.get('reason:1:provider-call-1')).toMatchObject({ llmEffectId: 'effect-1', toolEffectId: 'effect-2', resultRef: expect.any(String) })
  })

  it('keeps the ReAct template result and applies program-level model context', async () => {
    const program = defineReActLane({ id: 'react-template', version: '1', system: 'You are a verifier.', toolSet: 'readonly', instruction: ({ goal }) => `Verify ${goal}`, outputSchema: z.object({ answer: z.string() }) })
    const requests: any[] = []
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { requests.push(effect.input); return { value: { answer: 'verified', finishReason: 'stop', toolCalls: [] } } } })
    const { agentId, laneId } = runtime.createAgent('the login flow', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const request = requests[0]?.request
    expect(request.contextSpec.toolSetId).toBe('readonly')
    expect(request.blocks.find((block: any) => block.kind === 'system')?.content).toBe('You are a verifier.')
    const lane = runtime.state.lanes.get(laneId)!
    expect(lane.resultRef).toBeDefined()
    expect(runtime.state.results.get(lane.resultRef as string)?.value).toEqual({ answer: 'verified' })
  })

  it('returns a textRef for unstructured template output', async () => {
    const program = defineReActLane({ id: 'react-text-template', instruction: 'answer plainly' })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { text: 'plain answer', finishReason: 'stop', toolCalls: [] } }) })
    const { agentId, laneId } = runtime.createAgent('text answer', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const lane = runtime.state.lanes.get(laneId)!
    expect(runtime.state.results.get(lane.resultRef as string)?.value).toEqual({ textRef: expect.any(String) })
  })

  it('does not silently succeed when a template reaches maxTurns', async () => {
    const program = defineReActLane({ id: 'react-max-template', instruction: 'inspect', maxTurns: 1 })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'inspect', input: {} }] } }) })
    const { agentId, laneId } = runtime.createAgent('bounded template', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure).toMatchObject({ error: { code: 'MAX_TURNS_REACHED' } })
  })

  it('allows scatter-gather reducers to return a terminal target', async () => {
    const worker = defineLaneProgram({ id: 'scatter-worker', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => ({ actions: [{ type: 'complete', result: { item: ctx.goal } }], next: 'start' }))
    })
    const program = defineScatterGatherLane({
      id: 'scatter-terminal',
      items: () => ['a', 'b'],
      worker: { programId: worker.id, programVersion: worker.version },
      reducer: (outcomes) => ({ complete: { value: { count: outcomes.filter((outcome) => outcome.status === 'succeeded').length } } }),
    })
    const runtime = new PulseRuntime()
    runtime.register(worker)
    const { agentId, laneId } = runtime.createAgent('scatter terminal', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.results.get(runtime.state.lanes.get(laneId)?.resultRef as string)?.value).toEqual({ count: 2 })
  })
})
