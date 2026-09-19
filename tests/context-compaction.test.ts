import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, validateStep } from '@pulse/runtime'

describe('atomic context history compaction', () => {
  it('replaces an old history prefix with one auditable summary record', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'compact', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    root.context.history = [
      { seq: 1, instruction: 'one', resultRefs: [], output: { value: 1 }, privacy: 'public' },
      { seq: 2, instruction: 'two', resultRefs: [], output: { value: 2 }, privacy: 'cloud_allowed' },
      { seq: 3, instruction: 'three', resultRefs: [], output: { value: 3 }, privacy: 'public' },
    ]
    const result = validateStep(state, root.id, { contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'compact_history', upToSeq: 2, summary: { compacted: 2 } }], privacy: 'cloud_allowed' }, actions: [], next: { programId: 'p', programVersion: '1', step: 'next', locals: {} } })
    expect('mutations' in result).toBe(true)
    if ('mutations' in result) apply(state, result.mutations)
    expect(state.lanes.get(root.id)?.context.history).toEqual([
      { seq: 2, instruction: '[history compacted]', resultRefs: [], output: { compacted: 2 }, privacy: 'cloud_allowed' },
      { seq: 3, instruction: 'three', resultRefs: [], output: { value: 3 }, privacy: 'public' },
    ])
    expect(state.lanes.get(root.id)?.context.version).toBe(1)
  })

  it('rejects malformed or global history compaction atomically', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'compact', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    const before = structuredClone(root.context)
    const result = validateStep(state, root.id, { contextDelta: { target: 'global', baseVersion: 0, ops: [{ op: 'compact_history', upToSeq: 1, summary: {} }] }, actions: [], next: { programId: 'p', programVersion: '1', step: 'next', locals: {} } })
    expect('rejection' in result && result.rejection.code).toBe('INVALID_HISTORY_COMPACTION')
    expect(state.lanes.get(root.id)?.context).toEqual(before)
  })
})
