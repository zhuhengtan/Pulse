import { describe, expect, it } from 'vitest'
import { PulseRuntime, defineLaneProgram } from '@pulse/runtime'

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
})
