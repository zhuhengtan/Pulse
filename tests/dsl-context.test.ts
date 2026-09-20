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
      { op: 'set', path: ['items', '1'], value: 'b' },
      { op: 'set', path: ['items', 'length'], value: 2 },
      { op: 'remove', path: ['nested', 'enabled'] },
    ])
  })

  it('exposes fixed global/history metadata and compiles lane/global writes atomically', async () => {
    const program = defineLaneProgram({ id: 'dsl-context', version: '1', state: z.object({ touched: z.boolean().optional() }) }, (builder) => {
      builder.addStep('start', (ctx) => {
        expect(ctx.globalVersion).toBe(0)
        expect(ctx.global).toEqual({})
        expect(ctx.history).toEqual([])
        expect(ctx.now).toBe(0)
        ctx.commitGlobal({ ops: [{ op: 'set', path: ['ready'], value: true }], adoptImmediately: true })
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
})
