import { describe, expect, it } from 'vitest'
import { apply } from '@pulse/runtime'
import { createAgent, createRuntimeState, validateStep } from '@pulse/runtime'

const point = (step: string) => ({ programId: 'privacy-downgrade', programVersion: '1', step, locals: {} })

describe('explicit privacy downgrade', () => {
  it('creates a new cloud_allowed derived result with an auditable proof', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'privacy', point('start'))
    state.results.set('secret', { id: 'secret', value: { token: 'redacted-source' }, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('secret')
    const result = validateStep(state, root.id, {
      actions: [{ type: 'downgrade_privacy', sourceRefs: ['secret'], outputRef: 'sanitized', value: { token: '[removed]' }, targetPrivacy: 'cloud_allowed', method: 'sanitizer', sanitizerId: 'scrubber@1' }],
      next: point('done'),
    })
    expect('rejection' in result).toBe(false)
    if (!('rejection' in result)) apply(state, result.mutations)
    expect(state.results.get('sanitized')).toMatchObject({ privacy: 'cloud_allowed', derivedFrom: ['secret'], downgrade: { method: 'sanitizer', sanitizerId: 'scrubber@1' } })
    expect(state.events.some((event) => event.type === 'privacy.downgraded')).toBe(true)
  })

  it('requires a proof and never overwrites the source', () => {
    const state = createRuntimeState()
    const { root } = createAgent(state, 'privacy', point('start'))
    state.results.set('secret', { id: 'secret', value: {}, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('secret')
    const result = validateStep(state, root.id, { actions: [{ type: 'downgrade_privacy', sourceRefs: ['secret'], outputRef: 'out', value: {}, targetPrivacy: 'cloud_allowed', method: 'human_approval' }], next: point('done') })
    expect('rejection' in result && result.rejection.code).toBe('MISSING_PRIVACY_APPROVAL')
    expect(state.results.get('secret')?.privacy).toBe('local_only')
  })
})
