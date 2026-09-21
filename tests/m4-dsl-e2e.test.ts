import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PulseRuntime, assertProgramPure, defineLaneProgram } from '@hunterzhu/pulse-runtime'
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
    const rejected = [...runtime.state.results.values()].find((result) => result.kind === 'rejected_output')
    expect(rejected).toMatchObject({ kind: 'rejected_output', value: { invalid: true } })
    expect(runtime.state.effects.get('effect-1')?.outcome).toMatchObject({ status: 'failed', rejectedOutputRefs: [rejected?.id] })
    expect(runtime.state.lanes.get(runtime.state.agents.get(agentId)!.rootLaneId)?.context.history).toHaveLength(1)
  })

  it('keeps ReAct bookkeeping per Lane when one Program is reused by multiple Agents', async () => {
    const calls: string[] = []
    const resultRefs: string[] = []
    const program = defineLaneProgram({ id: 'react-isolated', version: '1' }, (builder) => {
      builder.addReActLoopStep('reason', { instruction: 'reason', onFinish: (resultRef) => { resultRefs.push(resultRef); return 'finish' } })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { calls.push(effect.key); return { value: { ok: true } } } })
    const first = runtime.createAgent('first', program)
    const second = runtime.createAgent('second', program)
    expect((await runtime.start(first.agentId).outcome()).status).toBe('succeeded')
    expect((await runtime.start(second.agentId).outcome()).status).toBe('succeeded')
    expect(calls.filter((key) => key === 'reason-turn-1')).toHaveLength(2)
    expect(resultRefs).toHaveLength(2)
    expect(resultRefs.every((ref) => runtime.state.results.has(ref))).toBe(true)
  })

  it('resolves a Session against its own Agent when multiple Agents share a Runtime', async () => {
    const runtime = new PulseRuntime()
    const failing = { id: 'session-failing', version: '1', step: () => ({ actions: [{ type: 'fail' as const, error: { code: 'EXPECTED', message: 'expected' } }], next: { programId: 'session-failing', programVersion: '1', step: 'done', locals: {} } }) }
    const succeeding = { id: 'session-succeeding', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'session-succeeding', programVersion: '1', step: 'done', locals: {} } }) }
    const first = runtime.createAgent('first', failing)
    const second = runtime.createAgent('second', succeeding)

    await expect(runtime.start(second.agentId).outcome()).resolves.toMatchObject({ status: 'succeeded' })
    await expect(runtime.start(first.agentId).outcome()).resolves.toMatchObject({ status: 'failed', error: { code: 'EXPECTED' } })
    expect(runtime.state.lanes.get(runtime.state.agents.get(first.agentId)!.rootLaneId)?.status).toBe('failed')
  })

  it('filters Session facts to the selected Agent while advancing the shared event cursor', async () => {
    const runtime = new PulseRuntime()
    const program = { id: 'session-filter', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'session-filter', programVersion: '1', step: 'done', locals: {} } }) }
    const first = runtime.createAgent('first', program)
    const second = runtime.createAgent('second', program)
    const session = runtime.start(second.agentId)
    const events: Array<{ laneId?: string }> = []
    for await (const event of session.stream()) if (event.type === 'fact' && event.event) events.push(event.event)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.laneId === undefined || runtime.state.lanes.get(event.laneId)?.agentId === second.agentId)).toBe(true)
    expect(events.some((event) => event.laneId === runtime.state.agents.get(first.agentId)?.rootLaneId)).toBe(false)
  })

  it('streams a read-only event mirror and exposes a final outcome', async () => {
    const runtime = new PulseRuntime()
    const program = { id: 'session-test', version: '1', step: () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'session-test', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('session', program)
    const session = runtime.start(agentId)
    await expect(session.snapshot()).resolves.toMatchObject({ schemaVersion: 1, agentId, eventSeq: expect.any(Number), lanes: expect.any(Array), effects: expect.any(Array), waits: expect.any(Array), results: expect.any(Array), mergeProposals: expect.any(Array), quarantine: expect.any(Array), observationsPending: expect.any(Number) })
    const events: string[] = []
    for await (const event of session.stream()) {
      expect(event.kind).toBe(event.type)
      events.push(event.kind)
    }
    expect(events).toContain('fact')
    expect((await session.outcome()).status).toBe('succeeded')
    await expect(session.snapshot()).resolves.toMatchObject({ agentId })
  })

  it('deep-clones snapshots so host inspection cannot mutate runtime state', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { answer: 42 } }) })
    const program = { id: 'snapshot-isolation', version: '1', step: ({ lane }: any) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: { nested: { value: 1 } } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'snapshot-isolation', programVersion: '1', step: 'finish', locals: {} } }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'snapshot-isolation', programVersion: '1', step: 'finish', locals: {} } } }
    const { agentId } = runtime.createAgent('snapshot isolation', program)
    runtime.tick()
    const session = runtime.start(agentId)
    const snapshot = await session.snapshot()
    const lane = snapshot.lanes[0] as any
    const effect = snapshot.effects[0] as any
    lane.context.state.mutated = true
    effect.input.nested.value = 99
    expect((runtime.state.lanes.get(lane.id)!.context.state as any).mutated).toBeUndefined()
    expect((runtime.state.effects.get(effect.id)!.input as any).nested.value).toBe(1)
    await session.cancel('test')
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

  it('rejects invalid Session host commands through the Promise API', async () => {
    const runtime = new PulseRuntime()
    const program = { id: 'session-command-validation', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'session-command-validation', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('command validation', program)
    const session = runtime.start(agentId)
    await expect(session.cancel('')).rejects.toThrow('INVALID_CANCEL_REASON')
    await expect(session.reply('missing-effect', { ok: true })).rejects.toThrow('EFFECT_NOT_OWNED')
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
    expect(first.value?.kind).toBe('gap')
    expect(first.value?.type).toBe('gap')
    await session.cancel('test')
    expect(runtime.factInbox.size).toBe(1)
    runtime.tick()
    expect(runtime.state.events.some((event) => event.type === 'command.enqueued' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && event.data.type === 'cancel')).toBe(true)
    expect(runtime.factInbox.size).toBe(0)
  })

  it('runs the login troubleshooting Planner/Fork/Join/Verify flow with Mock semantics', async () => {
    const { runtime, agentId } = createLoginTroubleshootingRuntime()
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect([...runtime.state.lanes.values()].filter((lane) => ['analyze', 'tests', 'fix'].includes(lane.goal))).toHaveLength(3)
    expect([...runtime.state.results.values()].some((result) => result.value && typeof result.value === 'object' && !Array.isArray(result.value) && 'summary' in result.value)).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'lane.succeeded')).toBe(true)
  })
})
