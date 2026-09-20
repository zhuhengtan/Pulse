import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@pulse/runtime'
import { z } from 'zod'

describe('MergeProposal isolation', () => {
  it('stores proposeGlobal without changing the committed Global version', async () => {
    const program = defineLaneProgram({ id: 'proposal', version: '1' }, (builder) => {
      builder.addStep('start', (ctx) => { ctx.proposeGlobal({ ops: [{ op: 'set', path: ['candidate'], value: true }] }); return { next: 'finish' } })
      builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: { global: ctx.global, proposals: ctx.mergeProposals.length } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('proposal', program)
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(runtime.state.agents.get(agentId)?.latestGlobalVersion).toBe(0)
    expect(runtime.state.mergeProposals.size).toBe(1)
    expect(runtime.state.mergeProposals.get('proposal-1')?.delta.ops[0]?.path).toEqual(['candidate'])
    expect([...runtime.state.results.values()].at(-1)?.value).toEqual({ global: {}, proposals: 1 })
  })

  it('filters merge proposals by the explicitly declared source lanes', async () => {
    let mergeInput: any
    const program = defineLaneProgram({ id: 'merge-sources', version: '1' }, (builder) => {
      builder.addMergeStep('merge', { task: 'synthesize', sources: { proposals: ['lane-allowed'] }, next: 'finish' })
      builder.addStep('finish', () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: 'finish' }))
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { mergeInput = effect.input; return { value: { ok: true } } } })
    const { agentId } = runtime.createAgent('merge sources', program)
    runtime.state.mergeProposals.set('allowed', { id: 'allowed', agentId, sourceLaneId: 'lane-allowed', baseGlobalVersion: 0, delta: { target: 'global', baseVersion: 0, proposal: true, ops: [{ op: 'set', path: ['allowed'], value: true }] }, createdAt: 1 })
    runtime.state.mergeProposals.set('hidden', { id: 'hidden', agentId, sourceLaneId: 'lane-hidden', baseGlobalVersion: 0, delta: { target: 'global', baseVersion: 0, proposal: true, ops: [{ op: 'set', path: ['hidden'], value: true }] }, createdAt: 2 })
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(mergeInput.proposals.map((proposal: any) => proposal.id)).toEqual(['allowed'])
  })

  it('uses the specification default task and onSynthesized as the terminal DSL出口', async () => {
    let mergeInput: any
    const program = defineLaneProgram({ id: 'merge-defaults', version: '1' }, (builder) => {
      builder.addMergeStep('merge', {
        schema: z.object({ ok: z.boolean() }),
        onSynthesized: (value) => ({ complete: { value } }),
      })
    })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => { mergeInput = effect.input; return { value: { ok: true } } } })
    const { agentId } = runtime.createAgent('merge defaults', program)

    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(mergeInput.task).toBe('reason')
    expect([...runtime.state.results.values()].at(-1)?.value).toEqual({ ok: true })
  })

  it('fails closed when the synthesized result violates its schema', async () => {
    const program = defineLaneProgram({ id: 'merge-invalid', version: '1' }, (builder) => {
      builder.addMergeStep('merge', { schema: z.object({ ok: z.boolean() }), onSynthesized: (value) => ({ complete: { value } }) })
    })
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { invalid: true } }) })
    const { agentId, laneId } = runtime.createAgent('merge invalid', program)

    expect((await runtime.start(agentId).outcome()).status).toBe('failed')
    expect(runtime.state.lanes.get(laneId)?.failure).toMatchObject({ error: { code: 'OUTPUT_SCHEMA_VIOLATION', retryable: false } })
  })
})
