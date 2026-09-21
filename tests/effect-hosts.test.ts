import { describe, expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('built-in Timer and Human Effect hosts', () => {
  it('runs TimerEffect on the RuntimeClock and resumes the Lane', async () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'timer-host', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'delay', kind: 'timer', concurrencyClass: 'none', input: { delayMs: 25 } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('timer-host', 'finish') }
      : { actions: [{ type: 'complete', result: { resumed: resumeInput?.type } }], next: point('timer-host', 'finish') } }
    const { agentId } = runtime.createAgent('timer', program)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect([...runtime.state.results.values()].some((result) => JSON.stringify(result.value) === JSON.stringify({ resumed: 'wait' }))).toBe(true)
    expect(runtime.state.events.some((event) => event.type === 'effect.settled')).toBe(true)
  })

  it('keeps HumanEffect pending until Session.reply arrives through FactInbox', async () => {
    const runtime = new PulseRuntime({ maxTickMs: 1000 })
    const program: LaneProgram = { id: 'human-host', version: '1', step: ({ lane, resumeInput }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'approval', kind: 'human', concurrencyClass: 'none', input: { question: 'Approve?' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('human-host', 'finish') }
      : { actions: [{ type: 'complete', result: { reply: resumeInput?.type === 'wait' ? resumeInput.resolution.dependencies.approval : null } }], next: point('human-host', 'finish') } }
    const { agentId } = runtime.createAgent('human', program)
    runtime.tick()
    expect(runtime.state.effects.get('effect-1')?.state).toBe('running')
    const session = runtime.start(agentId)
    await session.reply('effect-1', { approved: true })
    const outcome = await session.outcome()
    expect(outcome.status).toBe('succeeded')
    expect(runtime.state.events.some((event) => event.type === 'human.requested')).toBe(true)
    const settlement = runtime.mutationLog.entries.find((entry) => entry.mutations.some((mutation) => mutation.op === 'appendEvent' && mutation.event.type === 'effect.settled'))
    expect(settlement?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'appendEvent', event: expect.objectContaining({ type: 'command.applied', data: { eventId: 'host-command-1' } }) }),
    ]))
  })

  it('rejects a Human reply submitted by a different Agent Session', async () => {
    const program: LaneProgram = { id: 'human-ownership', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'approval', kind: 'human', concurrencyClass: 'none', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('human-ownership', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('human-ownership', 'finish') } }
    const runtime = new PulseRuntime()
    const first = runtime.createAgent('first', program)
    const second = runtime.createAgent('second', program)
    runtime.tick()
    runtime.enqueueHostCommand({ type: 'reply', agentId: second.agentId, effectId: 'effect-1', value: { approved: true } })
    runtime.tick()
    const firstSession = runtime.start(first.agentId)
    const secondSession = runtime.start(second.agentId)
    await expect(secondSession.reply('effect-1', { approved: true })).rejects.toThrow('EFFECT_NOT_OWNED')
    await firstSession.reply('effect-1', { approved: true })
    await secondSession.reply('effect-2', { approved: true })
    await expect(firstSession.outcome()).resolves.toMatchObject({ status: 'succeeded' })
    await expect(secondSession.outcome()).resolves.toMatchObject({ status: 'succeeded' })
    expect(runtime.state.events.some((event) => event.type === 'command.rejected')).toBe(true)
  })

  it('does not let Reply bypass a non-human Effect executor', async () => {
    const program: LaneProgram = { id: 'reply-kind', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'tool', kind: 'tool', concurrencyClass: 'tool', input: {} }] }], next: point('reply-kind', 'finish') }
      : { actions: [{ type: 'complete', result: { ok: true } }], next: point('reply-kind', 'finish') } }
    let release!: () => void
    const runtime = new PulseRuntime({ effectExecutor: async (_effect, signal) => await new Promise((resolve) => { release = () => resolve({ value: { ok: true } }); signal.addEventListener('abort', () => resolve({ value: null }), { once: true }) }) })
    const { agentId } = runtime.createAgent('reply kind', program)
    runtime.tick()
    const session = runtime.start(agentId)
    await expect(session.reply('effect-1', { forged: true })).rejects.toThrow('EFFECT_NOT_REPLYABLE')
    expect(runtime.state.effects.get('effect-1')?.outcome).toBeUndefined()
    release()
    await expect(session.outcome()).resolves.toMatchObject({ status: 'succeeded' })
  })
})
