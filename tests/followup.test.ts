import { describe, expect, it, vi } from 'vitest'
import { PulseRuntime, type HumanArbitrationRequest, type LaneProgram } from '../packages/runtime/src/index.js'
import { createFollowupModel } from '../packages/server/src/followup.js'

const point = (step: string) => ({ programId: 'followup-test', programVersion: '1', step, locals: {} })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await turn(); expect(check()).toBe(true) }

describe('primary model follow-ups', () => {
  it.each(['respond', 'steer', 'cancel'] as const)('lets the model choose %s while a tool is still running', async action => {
    let release!: () => void, aborted = false
    const run = vi.fn(async () => ({ text: JSON.stringify({ action, response: `model chose ${action}` }) }))
    const model = createFollowupModel({ assistant: false, context: async () => ({ originalGoal: 'keep working', evidence: 'tool running' }), run })
    const runtime = new PulseRuntime({ humanArbitration: { model, timeoutMs: 2000 }, effectExecutor: async (_effect, signal) => {
      signal.addEventListener('abort', () => { aborted = true; release?.() })
      await new Promise<void>(resolve => { release = resolve }); return { value: { done: true } }
    } })
    const program: LaneProgram = { id: 'followup-test', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'tool', kind: 'tool', concurrencyClass: 'tool', input: { task: 'existing' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('finish') }
      : { actions: [{ type: 'complete', result: { done: true } }], next: point('done') } }
    const { agentId, laneId } = runtime.createAgent({ goal: 'keep working', program })
    const session = runtime.start(agentId); runtime.tick(); await until(() => Boolean(release))
    await session.submitHumanInput('latest-input', { text: '你还活着吗', modelFirst: true }); runtime.tick()
    await until(() => runtime.state.humanInputs.get('latest-input')?.status !== 'pending')
    expect(runtime.state.humanInputs.get('latest-input')).toMatchObject({ decision: action })
    expect(run).toHaveBeenCalledTimes(1)
    expect(runtime.state.events.some(event => (event.data as any)?.response === `model chose ${action}`)).toBe(true)
    if (action === 'respond') { expect(aborted).toBe(false); expect(runtime.state.lanes.get(laneId)?.pendingHumanInputs).toBeUndefined() }
    if (action === 'steer') { expect(aborted).toBe(false); expect(runtime.state.lanes.get(laneId)?.pendingHumanInputs?.[0]?.id).toBe('latest-input') }
    if (action === 'cancel') { runtime.tick(); await until(() => aborted) }
    release(); await runtime.waitForIdle()
  })
  it('responds to ordinary input without completing a pending ask', async () => {
    const model = createFollowupModel({ assistant: false, context: async () => ({}), run: async () => ({ text: '{"action":"respond","response":"The task is waiting for your answer."}' }) })
    const runtime = new PulseRuntime({ builtinHumanEffects: true, humanArbitration: { model } })
    const program: LaneProgram = { id: 'followup-test', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects', effects: [{ key: 'ask', kind: 'human', concurrencyClass: 'none', input: { prompt: 'choose' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: point('finish') }
      : { actions: [{ type: 'complete', result: { done: true } }], next: point('done') } }
    const { agentId } = runtime.createAgent({ goal: 'task', program }), session = runtime.start(agentId)
    runtime.tick(); const effect = [...runtime.state.effects.values()][0]!
    await session.submitHumanInput('ordinary', { text: 'progress?', modelFirst: true }); runtime.tick()
    await until(() => runtime.state.humanInputs.get('ordinary')?.status === 'consumed')
    expect(effect.outcome).toBeUndefined(); expect(runtime.state.effects.get(effect.id)?.state).toBe('running')
    await session.reply(effect.id, { value: 'answer only' }); await runtime.waitForIdle()
    expect(runtime.state.humanInputs.size).toBe(1)
  })
  it('serializes multiple priority inputs without spawning fallback workers', async () => {
    const order: string[] = []; let release!: () => void
    const runtime = new PulseRuntime({ humanArbitration: { model: { id: 'primary', async decide(request) {
      order.push(request.input.id); if (order.length === 1) await new Promise<void>(resolve => { release = resolve })
      return { decisionId: request.decisionId, inputId: request.input.id, agentId: request.agentId, modelId: 'primary', action: 'respond' }
    } } } })
    const program: LaneProgram = { id: 'followup-test', version: '1', step: () => ({ actions: [], next: point('start') }) }
    runtime.setHumanInputProgram(program)
    const { agentId } = runtime.createAgent({ goal: 'task', program }), session = runtime.start(agentId)
    await session.submitHumanInput('first', { text: 'one', modelFirst: true }); await session.submitHumanInput('second', { text: 'two', modelFirst: true }); runtime.tick()
    await until(() => Boolean(release)); expect(order).toEqual(['first']); expect(runtime.state.agents.size).toBe(1)
    release(); await until(() => runtime.state.humanInputs.get('second')?.status === 'consumed')
    expect(order).toEqual(['first', 'second']); expect(runtime.state.agents.size).toBe(1)
    await session.cancel('test finished'); await runtime.waitForIdle()
  })
  it('re-dispatches a restored pending input without requiring a new user send', async () => {
    const run = vi.fn(async () => ({ text: '{"action":"respond","response":"恢复后收到这条输入。"}' }))
    const model = createFollowupModel({ assistant: false, context: async () => ({}), run })
    const runtime = new PulseRuntime({ humanArbitration: { model } })
    const program: LaneProgram = { id: 'followup-test', version: '1', step: () => ({ actions: [], next: point('start') }) }
    const { agentId } = runtime.createAgent({ goal: 'task', program })
    runtime.state.humanInputs.set('saved', { id: 'saved', agentId, status: 'pending', receivedAt: 0, value: { text: 'saved user input', modelFirst: true } })
    runtime.tick(); await until(() => runtime.state.humanInputs.get('saved')?.status === 'consumed')
    expect(run).toHaveBeenCalledTimes(1)
    await runtime.start(agentId).cancel('test finished'); await runtime.waitForIdle()
  })
  it('rejects malformed model decisions rather than inventing cancellation', async () => {
    const model = createFollowupModel({ assistant: false, context: async () => ({}), run: async () => ({ text: 'cancel everything' }) })
    await expect(model.decide({ decisionId: 'd', input: { id: 'i', value: 'status', status: 'pending', receivedAt: 0, agentId: 'a' }, agentId: 'a', lanes: [], effects: [], availableLLMSlots: 0, schemaVersion: 1 }, new AbortController().signal)).rejects.toThrow()
  })
})
