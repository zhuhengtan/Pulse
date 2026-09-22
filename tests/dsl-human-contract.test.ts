import { describe, expect, it } from 'vitest'
import { PulseRuntime, VirtualClock, defineLaneProgram } from '@hunterzhu/pulse-runtime'
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

  it('uses UTF-8 bytes consistently for non-ASCII instruction limits', () => {
    const program = defineLaneProgram({ id: 'human-byte-limit', version: '1' }, (builder) => {
      builder.addHumanStep('approve', { prompt: '你'.repeat(700), schema: z.object({ approved: z.boolean() }), onReply: () => 'done' })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const runtime = new PulseRuntime()
    const { laneId } = runtime.createAgent('human byte limit', program)
    runtime.tick()
    expect(runtime.state.lanes.get(laneId)?.failure?.error.code).toBe('INSTRUCTION_TOO_LARGE')
  })

  it('does not treat a malformed human reply as a timeout', async () => {
    let timedOut = false
    const program = defineLaneProgram({ id: 'human-reply-schema', version: '1' }, (builder) => {
      builder.addHumanStep('approve', { prompt: 'approve', schema: z.object({ approved: z.boolean() }), onReply: () => 'done', onTimeout: () => { timedOut = true; return 'done' } })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('human schema', program)
    runtime.tick()
    const effect = runtime.state.effects.get('effect-1')!
    const session = runtime.start(agentId)
    await session.reply(effect.id, { approved: 'yes' })
    expect((await session.outcome()).status).toBe('failed')
    expect(timedOut).toBe(false)
    expect([...runtime.state.lanes.values()].find((lane) => lane.status === 'failed')?.failure).toMatchObject({ error: { code: 'HUMAN_RESPONSE_SCHEMA_VIOLATION' } })
  })

  it('routes an actual human timeout to onTimeout', async () => {
    let timedOut = false
    const runtime = new PulseRuntime({ clock: new VirtualClock() })
    const program = defineLaneProgram({ id: 'human-timeout', version: '1' }, (builder) => {
      builder.addHumanStep('approve', { prompt: 'approve', schema: z.object({ approved: z.boolean() }), timeoutMs: 5, onReply: () => 'done', onTimeout: () => { timedOut = true; return 'done' } })
      builder.addStep('done', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'done' }))
    })
    const { agentId } = runtime.createAgent('human timeout', program)
    runtime.tick()
    runtime.clock.advance(5)
    runtime.tick()
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(timedOut).toBe(true)
  })
})
