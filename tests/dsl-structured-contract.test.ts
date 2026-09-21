import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

describe('structured LLM DSL contract', () => {
  it('keeps the original inputs and execution policies during bounded self-correction', async () => {
    const effects: Array<Record<string, any>> = []
    const program = defineLaneProgram({ id: 'structured-contract', version: '1' }, (builder) => {
      builder.addStructuredLLMStep('plan', {
        task: 'plan',
        instruction: 'return a plan',
        inputs: () => ({ events: ['event-1'] }),
        schema: z.object({ ok: z.boolean() }),
        requirements: { reasoning: 'high' },
        executionPolicy: { duplicateExecutionPolicy: 'forbid', maxUnknownAttempts: 1 },
        retryPolicy: { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0, jitter: false },
        onSuccess: () => 'finish',
      })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      effects.push(structuredClone(effect) as Record<string, any>)
      return { value: effects.length === 1 ? { invalid: true } : { ok: true } }
    } })

    const { agentId } = runtime.createAgent('structured contract', program)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect(effects.map((effect) => effect.key)).toEqual(['plan-llm', 'plan-correct-1'])
    expect(effects[0]?.retryPolicy).toEqual({ maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0, jitter: false })
    expect(effects[0]?.input.requirements).toMatchObject({ reasoning: 'high', structuredOutput: { schema: expect.any(Object) } })
    expect(effects[0]?.input.executionPolicy).toEqual({ duplicateExecutionPolicy: 'forbid', maxUnknownAttempts: 1 })
    expect(effects[1]?.input.inputs).toMatchObject({ events: ['event-1'], rejectedOutputRefs: [expect.any(String)] })
    expect(effects[1]?.input.requirements).toMatchObject({ reasoning: 'high', structuredOutput: { schema: expect.any(Object) } })
  })

  it('fails closed after the configured correction round instead of looping', async () => {
    const keys: string[] = []
    const program = defineLaneProgram({ id: 'structured-fail-closed', version: '1' }, (builder) => {
      builder.addStructuredLLMStep('plan', {
        task: 'plan',
        instruction: 'return a plan',
        schema: z.object({ ok: z.boolean() }),
        selfCorrect: { maxRounds: 1 },
        onSuccess: () => 'finish',
        onError: (error) => ({ fail: { code: error.code, message: error.message, retryable: error.retryable } }),
      })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { keys.push(effect.key); return { value: { invalid: true } } } })
    const { agentId } = runtime.createAgent('structured fail closed', program)
    const outcome = await runtime.start(agentId).outcome()

    expect(outcome.status).toBe('failed')
    expect(keys).toEqual(['plan-llm', 'plan-correct-1'])
    expect(runtime.state.lanes.get(runtime.state.agents.get(agentId)!.rootLaneId)?.failure).toMatchObject({ error: { code: 'OUTPUT_SCHEMA_VIOLATION', retryable: false } })
  })

  it('passes the original Effect RuntimeError to onError instead of schema correction', async () => {
    const program = defineLaneProgram({ id: 'structured-error-propagation', version: '1' }, (builder) => {
      builder.addStructuredLLMStep('plan', { task: 'plan', instruction: 'plan', schema: z.object({ ok: z.boolean() }), onSuccess: () => 'finish', onError: (error) => ({ fail: { code: error.code, message: error.message } }) })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => { throw Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM_UNAVAILABLE', retryable: false }) } })
    const { agentId, laneId } = runtime.createAgent('structured error', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'upstream unavailable' } })
    expect([...runtime.state.effects.values()].map((effect) => effect.key)).toEqual(['plan-llm'])
  })
})
