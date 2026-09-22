import { describe, expect, it } from 'vitest'
import { PulseRuntime, importRuntimeState, exportRuntimeState } from '@hunterzhu/pulse-runtime'
import type { LaneProgram } from '@hunterzhu/pulse-runtime'
import type { HumanArbitrationModel } from '@hunterzhu/pulse-runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('external Human input', () => {
  it('accepts input while a Human Effect is waiting and routes targeted input as a reply', async () => {
    const runtime = new PulseRuntime({ builtinHumanEffects: true })
    const program: LaneProgram = {
      id: 'human-input',
      version: '1',
      step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'ask', kind: 'human', concurrencyClass: 'none', input: { prompt: 'continue?' }, wait: true }] }], next: point('human-input', 'done') }
        : { actions: [{ type: 'complete', result: lane.pendingResumeInput?.type === 'wait' ? { answered: true } : { answered: false } }], next: point('human-input', 'done') },
    }
    const { agentId } = runtime.createAgent('wait for human', program)
    const session = runtime.start(agentId)
    runtime.tick()
    const effect = [...runtime.state.effects.values()][0]
    expect(effect?.kind).toBe('human')
    expect(effect?.state).toBe('running')

    await session.submitHumanInput('input-1', { text: 'yes' }, effect!.id)
    runtime.tick()
    expect(runtime.state.humanInputs.get('input-1')).toMatchObject({ status: 'consumed', targetEffectId: effect!.id })
    expect(runtime.state.effects.get(effect!.id)?.state).toBe('succeeded')
    expect(runtime.state.events.some((event) => event.type === 'human.input.received')).toBe(true)
  })

  it('deduplicates input ids and persists pending input across a snapshot', async () => {
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('idle', { id: 'idle', version: '1', step: () => ({ actions: [], next: point('idle', 'start') }) })
    const session = runtime.start(agentId)
    await session.submitHumanInput('same-id', { text: 'first' })
    await session.submitHumanInput('same-id', { text: 'second' })
    runtime.tick()
    expect(runtime.state.humanInputs.get('same-id')?.value).toEqual({ text: 'first' })
    const restored = importRuntimeState(exportRuntimeState(runtime.state))
    expect(restored.humanInputs.get('same-id')).toMatchObject({ value: { text: 'first' }, status: 'pending' })
  })

  it('keeps multiple urgent inputs FIFO ahead of background facts', async () => {
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('idle', { id: 'idle-fifo', version: '1', step: () => ({ actions: [], next: point('idle-fifo', 'start') }) })
    const session = runtime.start(agentId)
    await session.submitHumanInput('first', { text: 'one' })
    await session.submitHumanInput('second', { text: 'two' })
    const snapshot = runtime.factInbox.snapshot()
    expect(snapshot.urgentCount).toBe(2)
    expect(snapshot.queue.map((entry) => entry.fact.type)).toEqual(['human_input', 'human_input'])
    runtime.tick()
    expect(runtime.state.humanInputs.get('first')?.value).toEqual({ text: 'one' })
    expect(runtime.state.humanInputs.get('second')?.value).toEqual({ text: 'two' })
  })

  it('dispatches free-form input to an urgent child Agent when an interaction program is configured', async () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'interaction', version: '1', step: () => ({ actions: [{ type: 'complete', result: { handled: true } }], next: point('interaction', 'done') }) }
    runtime.setHumanInputProgram(program)
    const { agentId } = runtime.createAgent('main', program)
    const session = runtime.start(agentId)
    await session.submitHumanInput('free-form', { text: 'interrupt the current plan' })
    runtime.tick()
    const input = runtime.state.humanInputs.get('free-form')
    expect(input).toMatchObject({ status: 'consumed', decision: 'spawn' })
    expect(runtime.state.agents.size).toBe(2)
    const child = [...runtime.state.agents.values()].find((agent) => agent.id !== agentId)
    expect(child?.parentAgentId).toBe(agentId)
    expect(runtime.state.lanes.get(child!.rootLaneId)?.priority).toBe(2)
  })

  it('carries the parent visible results into a spawned human interaction', async () => {
    const runtime = new PulseRuntime()
    const program: LaneProgram = { id: 'interaction-context', version: '1', step: () => ({ actions: [], next: point('interaction-context', 'start') }) }
    runtime.setHumanInputProgram(program)
    const parent = runtime.createAgent('main', program)
    const parentLane = runtime.state.lanes.get(parent.laneId)!
    runtime.state.results.set('parent-result', { id: 'parent-result', value: { files: ['README.md'] }, privacy: 'public', derivedFrom: [] })
    parentLane.visibleResultRefs!.add('parent-result')
    const session = runtime.start(parent.agentId)
    await session.submitHumanInput('context-input', { text: 'continue from there' })
    runtime.tick()
    const child = [...runtime.state.agents.values()].find((agent) => agent.id !== parent.agentId)
    expect(child).toBeDefined()
    expect(runtime.state.lanes.get(child!.rootLaneId)?.visibleResultRefs).toEqual(new Set(['parent-result']))
  })

  it('sends ordinary input through a model decision fact and supports steer', async () => {
    let requestSeen = false
    const model: HumanArbitrationModel = {
      id: 'test-human-model',
      decide: async (request) => {
        requestSeen = true
        return { schemaVersion: 1, decisionId: request.decisionId, inputId: request.input.id, agentId: request.agentId, action: 'steer', targetLaneId: request.lanes[0]!.laneId, modelId: 'test-human-model' }
      },
    }
    const program: LaneProgram = { id: 'steer-program', version: '1', step: () => ({ actions: [], next: point('steer-program', 'start') }) }
    const runtime = new PulseRuntime({ humanArbitration: { model }, maxLaneStepsPerTick: 1 })
    const { agentId } = runtime.createAgent('main', program)
    const session = runtime.start(agentId)
    runtime.tick()
    await session.submitHumanInput('steer-1', { text: 'change direction' })
    runtime.tick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.tick()
    const input = runtime.state.humanInputs.get('steer-1')
    const lane = runtime.state.lanes.get(runtime.state.agents.get(agentId)!.rootLaneId)
    expect(requestSeen).toBe(true)
    expect(input).toMatchObject({ status: 'consumed', decision: 'steer', handledByLaneId: lane!.id })
    expect(lane?.priority).toBe(2)
    expect(runtime.state.events.some((event) => event.type === 'human.input.steered')).toBe(true)
  })

  it('keeps explicit defer and cancels external work into reconciliation', async () => {
    const runtime = new PulseRuntime({
      builtinHumanEffects: true,
      effectExecutor: async () => await new Promise(() => undefined),
    })
    const program: LaneProgram = {
      id: 'cancel-program', version: '1',
      step: ({ lane }) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects', effects: [{ key: 'write', kind: 'tool', concurrencyClass: 'tool', sideEffectPolicy: 'external', input: { name: 'write' } }] }], next: point('cancel-program', 'wait') }
        : { actions: [], next: point('cancel-program', 'wait') },
    }
    const { agentId } = runtime.createAgent('main', program)
    const session = runtime.start(agentId)
    runtime.tick()
    const effect = [...runtime.state.effects.values()][0]!
    await session.submitHumanInput('defer-1', { command: 'defer' })
    await session.submitHumanInput('cancel-1', { command: 'cancel', effectId: effect.id })
    runtime.tick()
    expect(runtime.state.humanInputs.get('defer-1')).toMatchObject({ status: 'deferred', decision: 'defer' })
    expect(runtime.state.effects.get(effect.id)?.state).toBe('reconcile_required')
    expect(runtime.state.humanInputs.get('cancel-1')).toMatchObject({ status: 'consumed', decision: 'cancel' })
    expect(runtime.state.events.some((event) => event.type === 'effect.quarantined')).toBe(true)
  })
})
