import { describe, expect, it } from 'vitest'
import { createAgent, createRuntimeState, validateStep } from '@pulse/runtime'

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
})
