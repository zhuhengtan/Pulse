import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, defineLaneProgram, validateStep, PulseRuntime } from '@pulse/runtime'

const point = (step: string) => ({ programId: 'affinity', programVersion: '1', step, locals: {} })

describe('fork affinity admission', () => {
  it('returns a collapsible-group advice without creating partial lanes', () => {
    const state = createRuntimeState(8, { forkAffinity: 'advise' })
    const { root } = createAgent(state, 'root', point('start'))
    const result = validateStep(state, root.id, {
      actions: [{ type: 'fork', lanes: [
        { key: 'read', goal: 'read', program: point('worker'), resources: [{ resource: 'src/auth', mode: 'exclusive' }] },
        { key: 'fix', goal: 'fix', program: point('worker'), resources: [{ resource: 'src/auth', mode: 'exclusive' }] },
      ], join: { condition: 'settled', onUnsatisfied: 'resume_with_error' } }],
      next: point('next'),
    })
    expect('rejection' in result && result.rejection.code).toBe('FORK_AFFINITY_COLLAPSIBLE')
    expect(state.lanes.size).toBe(1)
    const groups = (result as { rejection: { details?: { groups?: Array<{ keys: string[]; signals: string[] }> } } }).rejection.details?.groups ?? []
    expect(groups[0]?.keys).toEqual(['fix', 'read'])
    expect(groups[0]?.signals).toContain('exclusive_resource_overlap')
  })

  it('accepts the same proposal once the caller acknowledges the advice', () => {
    const state = createRuntimeState(8, { forkAffinity: 'advise' })
    const { root } = createAgent(state, 'root', point('start'))
    const result = validateStep(state, root.id, {
      actions: [{ type: 'fork', affinityAck: true, lanes: [
        { key: 'a', goal: 'a', program: point('worker'), affinityKey: 'same' },
        { key: 'b', goal: 'b', program: point('worker'), affinityKey: 'same' },
      ] }],
      next: point('next'),
    })
    expect('rejection' in result).toBe(false)
    if (!('rejection' in result)) expect(result.mutations.filter((mutation) => mutation.op === 'insertLane')).toHaveLength(2)
  })

  it('rejects a fork that names an unknown input ResultRef before creating lanes', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'root', point('start'))
    const result = validateStep(state, root.id, { actions: [{ type: 'fork', lanes: [{ key: 'worker', goal: 'worker', program: point('worker'), inputResultRefs: ['missing'] }] }], next: point('next') })
    expect('rejection' in result && result.rejection.code).toBe('UNKNOWN_RESULT_REF')
    expect(state.lanes.size).toBe(1)
  })

  it('retries the DSL proposal as one series lane and restores original join keys', async () => {
    const worker = defineLaneProgram({ id: 'affinity-worker', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => ({ actions: [{ type: 'complete', result: { goal: ctx.goal } }], next: 'start' }))
    })
    const parent = defineLaneProgram({ id: 'affinity-parent', version: '1' }, (builder) => {
      builder.addParallelStep('dispatch', {
        lanes: {
          first: { goal: 'first goal', program: { programId: worker.id, programVersion: worker.version }, resources: [{ resource: 'src/auth', mode: 'exclusive' }] },
          second: { goal: 'second goal', program: { programId: worker.id, programVersion: worker.version }, resources: [{ resource: 'src/auth', mode: 'exclusive' }] },
        },
        onJoin: (outcomes, ctx) => { ctx.mutateLane((state) => { (state as Record<string, unknown>).outcomes = outcomes as unknown as Record<string, unknown> }); return 'finish' },
      })
      builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: ctx.lane.context.state }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ forkAffinity: 'advise' })
    runtime.register(worker)
    const { agentId } = runtime.createAgent('affinity parent', parent)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect([...runtime.state.lanes.values()]).toHaveLength(2)
    const root = [...runtime.state.lanes.values()].find((lane) => lane.ownerLaneId === undefined)!
    const result = root.resultRef ? runtime.state.results.get(root.resultRef)?.value : undefined
    expect(result).toMatchObject({ outcomes: { first: { status: 'succeeded', result: { goal: 'first goal' } }, second: { status: 'succeeded', result: { goal: 'second goal' } } } })
    expect(runtime.state.events.some((event) => event.type === 'fork.affinity_advice')).toBe(true)
  })

  it('preserves group-internal dependency order and delivers the prior member outcome', async () => {
    const worker = defineLaneProgram({ id: 'dependent-worker', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => ({ actions: [{ type: 'complete', result: ctx.resumeInput?.type === 'wait' ? { dependency: ctx.resumeInput.resolution.dependencies.first?.outcome.result } : { goal: ctx.goal } }], next: 'start' }))
    })
    const parent = defineLaneProgram({ id: 'dependent-parent', version: '1' }, (builder) => {
      builder.addParallelStep('dispatch', {
        lanes: {
          first: { goal: 'first', program: { programId: worker.id, programVersion: worker.version }, resources: [{ resource: 'module', mode: 'exclusive' }] },
          second: { goal: 'second', program: { programId: worker.id, programVersion: worker.version }, resources: [{ resource: 'module', mode: 'exclusive' }], dependsOn: [{ key: 'first', target: { local: 'first' }, condition: 'success' }] },
        },
        onJoin: (outcomes, ctx) => { ctx.mutateLane((state) => { (state as Record<string, unknown>).outcomes = outcomes }); return 'finish' },
      })
      builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: ctx.lane.context.state }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ forkAffinity: 'advise' })
    runtime.register(worker)
    const { agentId } = runtime.createAgent('dependent parent', parent)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const root = [...runtime.state.lanes.values()].find((lane) => lane.ownerLaneId === undefined)!
    const result = root.resultRef ? runtime.state.results.get(root.resultRef)?.value : undefined
    expect(result).toMatchObject({ outcomes: { first: { status: 'succeeded' }, second: { status: 'succeeded', result: { dependency: { goal: 'first' } } } } })
  })
})
