import { describe, expect, it } from 'vitest'
import { rebaseContextDelta } from '@pulse/runtime'

describe('explicit ContextDelta rebase', () => {
  it('rebases disjoint writes onto the latest version', () => {
    const result = rebaseContextDelta({ target: 'lane', baseVersion: 1, ops: [{ op: 'set', path: ['answer'], value: 'ok' }] }, { answer: '', count: 1 }, { answer: '', count: 2 }, 2)
    expect(result.conflicts).toEqual([])
    expect(result.delta?.baseVersion).toBe(2)
  })

  it('reports same-path and append-target conflicts without producing a delta', () => {
    const samePath = rebaseContextDelta({ target: 'lane', baseVersion: 1, ops: [{ op: 'set', path: ['answer'], value: 'ours' }] }, { answer: 'base' }, { answer: 'theirs' }, 2)
    expect(samePath.delta).toBeUndefined()
    expect(samePath.conflicts).toEqual([{ path: ['answer'], reason: 'changed_since_base' }])
    const append = rebaseContextDelta({ target: 'lane', baseVersion: 1, ops: [{ op: 'append', path: ['items'], value: 3 }] }, { items: [1] }, { items: [9] }, 2)
    expect(append.conflicts[0]?.reason).toBe('append_target_changed')
  })
})
