import { describe, expect, it } from 'vitest'
import { apply, createAgent, createRuntimeState, validateStep } from '@pulse/runtime'

describe('result privacy provenance', () => {
  it('recomputes the strictest source label and preserves derivedFrom', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'privacy', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    state.results.set('local-result', { id: 'local-result', value: { secret: true }, privacy: 'local_only', derivedFrom: [] })
    const result = validateStep(state, root.id, { actions: [{ type: 'complete', result: { summary: true }, derivedFrom: ['local-result'] }], next: { programId: 'p', programVersion: '1', step: 'done', locals: {} } })
    expect('mutations' in result).toBe(true)
    if ('mutations' in result) { apply(state, result.mutations); expect([...state.results.values()].find((item) => item.derivedFrom.includes('local-result'))).toMatchObject({ privacy: 'local_only', derivedFrom: ['local-result'] }) }
  })

  it('rejects explicit privacy downgrades and unknown provenance references', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'privacy', { programId: 'p', programVersion: '1', step: 'start', locals: {} })
    state.results.set('local-result', { id: 'local-result', value: {}, privacy: 'local_only', derivedFrom: [] })
    expect('rejection' in validateStep(state, root.id, { actions: [{ type: 'complete', result: {}, privacy: 'public', derivedFrom: ['local-result'] }], next: { programId: 'p', programVersion: '1', step: 'done', locals: {} } })).toBe(true)
    expect('rejection' in validateStep(state, root.id, { actions: [{ type: 'complete', result: {}, derivedFrom: ['missing'] }], next: { programId: 'p', programVersion: '1', step: 'done', locals: {} } })).toBe(true)
  })
})
