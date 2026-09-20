import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PulseRuntime, defineLaneProgram, definePlanAndExecuteLane } from '@pulse/runtime'

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
})
