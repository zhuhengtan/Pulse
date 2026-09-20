import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, validateStep } from '@pulse/runtime'

const next = { programId: 'summary', programVersion: '1', step: 'next', locals: {} }

describe('history compaction summaryRef', () => {
  it('accepts a published summary ResultRef and preserves it in compacted history', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'summary', next)
    root.context.history = [{ seq: 1, instruction: 'old', resultRefs: [], output: { old: true }, privacy: 'local_only' }]
    state.results.set('result-summary', { id: 'result-summary', value: { text: 'summary' }, summary: { text: 'summary' }, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('result-summary')
    const result = validateStep(state, root.id, { contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'compact_history', upToSeq: 1, summaryRef: 'result-summary' }] }, actions: [], next })
    expect('rejection' in result).toBe(false)
    if (!('rejection' in result)) expect(result.mutations.find((mutation) => mutation.op === 'setLaneContext')?.history?.[0]).toMatchObject({ resultRefs: ['result-summary'], privacy: 'local_only' })
  })

  it('rejects an unknown summary reference', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'summary', next)
    root.context.history = [{ seq: 1, instruction: 'old', resultRefs: [], output: {}, privacy: 'public' }]
    const result = validateStep(state, root.id, { contextDelta: { target: 'lane', baseVersion: 0, ops: [{ op: 'compact_history', upToSeq: 1, summaryRef: 'missing' }] }, actions: [], next })
    expect(result).toMatchObject({ rejection: { code: 'UNKNOWN_SUMMARY_REF' } })
  })
})
