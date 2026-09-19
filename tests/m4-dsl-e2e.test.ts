import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PulseRuntime, assertProgramPure, defineLaneProgram } from '@pulse/runtime'
import { createLoginTroubleshootingRuntime } from '../examples/login-troubleshooting/index.js'

describe('M1-4 DSL and end-to-end workflow', () => {
  it('compiles a structured macro step into synchronous submit/decode steps', async () => {
    const program = defineLaneProgram({ id: 'dsl-test', version: '1', state: z.object({ answer: z.string().optional() }) }, (builder) => {
      builder.addStructuredLLMStep('plan', { task: 'plan', instruction: (view) => `Goal: ${view.goal}`, schema: z.object({ answer: z.string() }), onSuccess: (data, ctx) => { ctx.mutateLane((draft) => { draft.answer = data.answer }); return 'finish' } })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    assertProgramPure(program)
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => ({ value: effect.key === 'plan-llm' ? { answer: 'deterministic' } : {} }) })
    const { agentId, laneId } = runtime.createAgent('plan login fix', program)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect(runtime.state.lanes.get(laneId)?.context.state).toEqual({ answer: 'deterministic' })
  })

  it('self-corrects one invalid structured output without mutating rejected history', async () => {
    let calls = 0
    const program = defineLaneProgram({ id: 'self-correct', version: '1' }, (builder) => {
      builder.addStructuredLLMStep('plan', { task: 'plan', instruction: 'return JSON', schema: z.object({ ok: z.boolean() }), selfCorrect: { maxRounds: 1 }, onSuccess: () => 'finish' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => { calls++; return { value: calls === 1 ? { invalid: true } : { ok: true } } } })
    const { agentId } = runtime.createAgent('correct', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(calls).toBe(2)
  })

  it('keeps ReAct bookkeeping per Lane when one Program is reused by multiple Agents', async () => {
    const calls: string[] = []
    const program = defineLaneProgram({ id: 'react-isolated', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'reason', onFinish: () => 'finish' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { calls.push(effect.key); return { value: { ok: true } } } })
    const first = runtime.createAgent('first', program)
    const second = runtime.createAgent('second', program)
    expect((await runtime.start(first.agentId).outcome()).status).toBe('succeeded')
    expect((await runtime.start(second.agentId).outcome()).status).toBe('succeeded')
    expect(calls.filter((key) => key === 'reason-turn-1')).toHaveLength(2)
  })

  it('streams a read-only event mirror and exposes a final outcome', async () => {
    const runtime = new PulseRuntime()
    const program = { id: 'session-test', version: '1', step: () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'session-test', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('session', program)
    const session = runtime.start(agentId)
    const events: string[] = []
    for await (const event of session.stream()) events.push(event.type)
    expect(events).toContain('fact')
    expect((await session.outcome()).status).toBe('succeeded')
    expect(session.snapshot()).toMatchObject({ agentId })
  })

  it('keeps runtime progress independent from a slow stream consumer', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const program = {
      id: 'slow-consumer', version: '1',
      step: ({ lane, resumeInput }: { lane: any; resumeInput?: any }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'slow-consumer', programVersion: '1', step: 'finish', locals: {} } }
        : { actions: [{ type: 'complete', result: { resumed: resumeInput?.type } }], next: { programId: 'slow-consumer', programVersion: '1', step: 'finish', locals: {} } },
    }
    const { agentId } = runtime.createAgent('slow consumer', program)
    const session = runtime.start(agentId)
    const stream = session.stream()[Symbol.asyncIterator]()
    await stream.next()
    await new Promise((resolve) => setTimeout(resolve, 40))
    await expect(Promise.race([session.outcome(), new Promise((_, reject) => setTimeout(() => reject(new Error('runtime blocked by consumer')), 200))])).resolves.toMatchObject({ status: 'succeeded' })
    await stream.return?.()
  })

  it('reports a stream gap after fact history is compacted and routes host cancel through the inbox', async () => {
    const runtime = new PulseRuntime()
    const program = { id: 'gap-test', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'gap-test', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('gap', program)
    runtime.tick()
    const session = runtime.start(agentId)
    runtime.state.events.push({ seq: 2, type: 'synthetic-2' }, { seq: 3, type: 'synthetic-3' })
    runtime.state.events.splice(0, runtime.state.events.length - 1)
    const first = await session.stream()[Symbol.asyncIterator]().next()
    expect(first.value?.type).toBe('gap')
    await session.cancel('test')
    expect(runtime.factInbox.size).toBe(1)
    runtime.tick()
    expect(runtime.factInbox.size).toBe(0)
  })

  it('runs the login troubleshooting Main/Fork/Join/Synthesize flow with Mock semantics', async () => {
    const { runtime, agentId } = createLoginTroubleshootingRuntime()
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect([...runtime.state.lanes.values()].filter((lane) => lane.goal === 'analyze' || lane.goal === 'tests')).toHaveLength(2)
    expect(runtime.state.events.some((event) => event.type === 'lane.succeeded')).toBe(true)
  })
})
