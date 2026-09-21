import { describe, expect, it } from 'vitest'
import { ContextMerger, apply, createAgent, createRuntimeState, validateStep } from '@hunterzhu/pulse-runtime'

const point = (step: string) => ({ programId: 'merge', programVersion: '1', step, locals: {} })

describe('ContextMerger', () => {
  it('rebases and atomically consumes compatible proposals', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'merge', point('start'))
    const proposed = validateStep(state, root.id, { contextDelta: { target: 'global', baseVersion: 0, proposal: true, ops: [{ op: 'set', path: ['answer'], value: 42 }] }, actions: [], next: point('next') })
    expect('rejection' in proposed).toBe(false)
    if (!('rejection' in proposed)) apply(state, proposed.mutations)
    expect(state.agents.get(root.agentId)?.latestGlobalVersion).toBe(0)
    expect(state.mergeProposals.size).toBe(1)
    const merged = new ContextMerger(state).commit(root.agentId)
    expect(merged.conflicts).toEqual([])
    expect(merged.appliedProposalIds).toEqual(['proposal-1'])
    expect(state.agents.get(root.agentId)?.latestGlobalVersion).toBe(1)
    expect(state.agents.get(root.agentId)?.globalVersions.get(1)).toEqual({ answer: 42 })
    expect(state.mergeProposals.size).toBe(0)
  })

  it('reports path conflicts instead of last-write-wins', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'merge', point('start'))
    state.agents.get(root.agentId)!.globalVersions.set(1, { answer: 1 })
    state.agents.get(root.agentId)!.latestGlobalVersion = 1
    state.mergeProposals.set('a', { id: 'a', agentId: root.agentId, sourceLaneId: root.id, baseGlobalVersion: 0, delta: { target: 'global', baseVersion: 0, proposal: true, ops: [{ op: 'set', path: ['answer'], value: 2 }] }, createdAt: 1 })
    const merged = new ContextMerger(state).plan(root.agentId)
    expect(merged.appliedProposalIds).toEqual([])
    expect(merged.conflicts[0]?.proposalId).toBe('a')
    expect(state.agents.get(root.agentId)?.globalVersions.get(1)).toEqual({ answer: 1 })
  })
})
