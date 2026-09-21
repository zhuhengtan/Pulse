import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

describe('DSL Fork contract', () => {
  it('accepts the specification join object and sibling dependencies', async () => {
    const worker = defineLaneProgram({ id: 'fork-contract-worker', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => ({ actions: [{ type: 'complete', result: { goal: ctx.goal } }], next: 'start' }))
    })
    const parent = defineLaneProgram({ id: 'fork-contract-parent', version: '1' }, (builder) => {
      builder.addParallelStep('dispatch', {
        lanes: {
          first: { goal: 'first', program: { programId: worker.id, programVersion: worker.version } },
          second: { goal: 'second', program: { programId: worker.id, programVersion: worker.version }, dependsOn: [{ sibling: 'first', condition: 'success' }] },
        },
        join: { condition: 'settled', onUnsatisfied: 'fail_lane', onCancelled: 'ignore' },
        onJoin: (outcomes, ctx) => { ctx.mutateLane((state) => { (state as Record<string, unknown>).outcomes = outcomes as unknown as Record<string, unknown> }); return 'finish' },
      })
      builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: ctx.laneState }], next: 'finish' }))
    })
    const runtime = new PulseRuntime()
    runtime.register(worker)
    const { agentId } = runtime.createAgent('fork contract', parent)

    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const root = [...runtime.state.lanes.values()].find((lane) => lane.ownerLaneId === undefined)!
    expect(runtime.state.results.get(root.resultRef!)?.value).toMatchObject({ outcomes: { first: { status: 'succeeded' }, second: { status: 'succeeded' } } })
  })

  it('accepts proposal(ctx) for dynamic forks and preserves ProgramRef entry data', async () => {
    const worker = defineLaneProgram({ id: 'dynamic-fork-worker', version: '1' }, (builder) => {
      builder.addStep('custom', (ctx) => ({ actions: [{ type: 'complete', result: { goal: ctx.goal, marker: ctx.lane.resume.locals } }], next: 'custom' }))
    })
    const parent = defineLaneProgram({ id: 'dynamic-fork-parent', version: '1' }, (builder) => {
      builder.addDynamicForkStep('dispatch', {
        proposal: (ctx) => ({ lanes: { generated: { goal: `${ctx.goal} child`, program: { programId: worker.id, programVersion: worker.version, step: 'custom', locals: { marker: 'preserved' } } } } }),
        join: { condition: 'settled', onCancelled: 'ignore' },
        onJoin: (outcomes) => outcomes.get('generated')?.status === 'succeeded' ? 'finish' : { fail: { code: 'CHILD_FAILED', message: 'child failed' } },
      })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime()
    runtime.register(worker)
    const { agentId } = runtime.createAgent('dynamic fork', parent)

    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const child = [...runtime.state.lanes.values()].find((lane) => lane.ownerLaneId !== undefined)!
    expect(child.resume.step).toBe('custom')
    expect(child.resume.locals).toMatchObject({ marker: 'preserved' })
  })
})
