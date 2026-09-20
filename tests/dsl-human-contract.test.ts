import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@pulse/runtime'
import { z } from 'zod'

describe('DSL Human and instruction contracts', () => {
  it('passes only scalar state fields to prompts and carries input references', async () => {
    const program = defineLaneProgram({ id: 'human-contract', version: '1', state: z.object({ safe: z.string().optional(), nested: z.object({ secret: z.string() }).optional() }) }, (builder) => {
      builder.addStep('start', (ctx) => { ctx.mutateLane((draft) => { draft.safe = 'hello'; draft.nested = { secret: 'hidden' } }); return { next: 'approve' } })
      builder.addHumanStep('approve', { prompt: ({ state }) => `${state.safe}:${String((state as Record<string, unknown>).nested)}`, inputs: () => ({ events: ['event-1'] }), schema: z.object({ approved: z.boolean() }), onReply: (reply) => reply.approved ? { complete: { value: { approved: true } } } : { fail: { code: 'REJECTED', message: 'rejected' } } })
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('human contract', program)
    runtime.tick()
    runtime.tick()
    const effect = runtime.state.effects.get('effect-1')!
    expect(effect.input).toMatchObject({ prompt: 'hello:undefined', inputs: { events: ['event-1'] } })
    const session = runtime.start(agentId)
    await session.reply(effect.id, { approved: true })
    expect((await session.outcome()).status).toBe('succeeded')
  })

  it('fails closed when a human prompt exceeds the DSL instruction limit', () => {
    const program = defineLaneProgram({ id: 'human-limit', version: '1' }, (builder) => {
      builder.addHumanStep('approve', { prompt: 'x'.repeat(2049), schema: z.object({ approved: z.boolean() }), onReply: () => 'done' })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const runtime = new PulseRuntime()
    const { laneId } = runtime.createAgent('human limit', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('INSTRUCTION_TOO_LARGE')
  })
})
