import { describe, expect, it } from 'vitest'
import { PulseRuntime, createDraftProxy, defineLaneProgram } from '@pulse/runtime'
import { z } from 'zod'

describe('DSL StepContext', () => {
  it('captures nested object and array mutations as path operations', () => {
    const { draft, changes } = createDraftProxy({ nested: { enabled: false }, items: ['a'] })
    draft.nested.enabled = true
    draft.items.push('b')
    delete draft.nested.enabled
    expect(changes().ops).toEqual([
      { op: 'set', path: ['nested', 'enabled'], value: true },
      { op: 'append', path: ['items'], value: 'b' },
      { op: 'remove', path: ['nested', 'enabled'] },
    ])
    const array = createDraftProxy({ items: ['a', 'b', 'c'] })
    array.draft.items[1] = 'B'
    array.draft.items.splice(0, 1, 'A')
    array.draft.items.sort()
    expect(array.changes().ops).toEqual([
      { op: 'set', path: ['items'], value: ['a', 'B', 'c'] },
      { op: 'set', path: ['items'], value: ['A', 'B', 'c'] },
      { op: 'set', path: ['items'], value: ['A', 'B', 'c'] },
    ])
  })

  it('exposes fixed global/history metadata and compiles lane/global writes atomically', async () => {
    const program = defineLaneProgram({ id: 'dsl-context', version: '1', state: z.object({ touched: z.boolean().optional() }) }, (builder) => {
      builder.addStep('start', (ctx) => {
        expect((ctx as any).getResult).toBeUndefined()
        expect((ctx as any).state).toBeUndefined()
        expect(ctx.globalVersion).toBe(0)
        expect(ctx.global).toEqual({})
        expect(ctx.history).toEqual([])
        expect(ctx.now).toBe(0)
        ctx.commitGlobal({ ops: (draft) => { draft.ready = true }, adoptImmediately: true })
        return { next: 'finish' }
      })
      builder.addStep('finish', (ctx) => {
        expect((ctx.global as Record<string, unknown>).ready).toBe(true)
        ctx.mutateLane((draft) => { draft.touched = true })
        return { next: 'done' }
      })
      builder.addStep('done', (ctx) => ({ actions: [{ type: 'complete', result: { touched: ctx.laneState.touched, globalReady: (ctx.global as Record<string, unknown>).ready } }], next: 'done' }))
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('context', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const result = [...runtime.state.results.values()].at(-1)?.value
    expect(result).toEqual({ touched: true, globalReady: true })
  })

  it('exposes bounded result metadata without exposing the result body through meta()', async () => {
    const program = defineLaneProgram({ id: 'dsl-result-meta', version: '1' }, (builder) => {
      builder.addStep('start', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'read', kind: 'tool', concurrencyClass: 'tool', input: { name: 'read' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'done' }))
      builder.addStep('done', (ctx) => {
        const dependency = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies)[0] : undefined
        const ref = dependency?.state === 'settled' ? dependency.outcome.resultRef : undefined
        const meta = ref === undefined ? undefined : ctx.results.meta(ref)
        return { actions: [{ type: 'complete', result: meta as never }], next: 'done' }
      })
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { secret: 'body' } }) })
    const { agentId, laneId } = runtime.createAgent('result metadata', program)

    expect((await runtime.run(agentId)).status).toBe('succeeded')
    const value = runtime.state.results.get(runtime.state.lanes.get(laneId)!.resultRef!)?.value as Record<string, unknown>
    expect(value).toMatchObject({ privacy: 'public', producer: { kind: 'effect' }, sizeBytes: expect.any(Number), hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(value).not.toHaveProperty('secret')
  })
})
