import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PulseRuntime, createAgent, createRuntimeState, defineLaneProgram } from '@pulse/runtime'

const point = (programId: string, step: string) => ({ programId, programVersion: '1', step, locals: {} })

describe('DSL history compaction and Session contracts', () => {
  it('waits for a macro decoder to consume its result before compacting', () => {
    const program = defineLaneProgram({
      id: 'compaction-boundary',
      version: '1',
      historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 },
    }, (builder) => {
      builder.addStructuredLLMStep('plan', {
        task: 'plan',
        instruction: 'plan',
        schema: z.object({ ok: z.boolean() }),
        onSuccess: () => 'finish',
      })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
    })
    const state = createRuntimeState()
    const { root } = createAgent(state, 'boundary', point(program.id, 'plan'))
    root.historyPressure = { historyTokens: 100, softTokens: 10, hardTokens: 200 }
    root.context.history = [
      { seq: 1, instruction: 'old', resultRefs: [], output: { old: true }, privacy: 'public' },
      { seq: 2, instruction: 'recent', resultRefs: [], output: { recent: true }, privacy: 'public' },
    ]
    state.results.set('result-1', { id: 'result-1', value: { ok: true }, privacy: 'public', derivedFrom: [] })
    root.visibleResultRefs = new Set(['result-1'])

    const output = program.step({
      lane: { ...root, resume: point(program.id, 'plan:decode') },
      state,
      now: 0,
      resumeInput: {
        type: 'wait',
        resolution: {
          waitId: 'wait-1',
          status: 'satisfied',
          dependencies: {
            plan: {
              state: 'settled',
              target: { kind: 'effect', id: 'effect-1' },
              outcome: { status: 'succeeded', resultRef: 'result-1' },
            },
          },
        },
      },
    })

    expect(output.next.step).toBe('finish')
    expect(output.actions).toEqual([])
  })

  it('does not expose mutable RuntimeEvent objects through the Session stream', async () => {
    const runtime = new PulseRuntime()
    const program = { id: 'session-readonly', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: point('session-readonly', 'done') }) }
    const { agentId } = runtime.createAgent('session', program)
    const session = runtime.start(agentId)
    const iterator = session.stream()[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.kind).toBe('fact')
    const event = first.value?.event
    expect(event).toBeDefined()
    const original = runtime.state.events.find((candidate) => candidate.seq === event?.seq)
    expect(original).toBeDefined()

    event!.type = 'tampered'
    expect(runtime.state.events.find((candidate) => candidate.seq === event!.seq)?.type).toBe(original!.type)

    await expect(session.outcome()).resolves.toMatchObject({ status: 'succeeded' })
    await iterator.return?.()
  })
})
