import { describe, expect, it } from 'vitest'
import { SessionStoragePolicy } from '@pulse/runtime'

describe('session storage policy', () => {
  it('pins active records and compacts unpinned result data under pressure', () => {
    const policy = new SessionStoragePolicy({ maxResultBytes: 64, maxTotalMemoryBytes: 30 })
    policy.put('result', 'old', { text: '1234567890' })
    const current = policy.put('result', 'current', { text: 'abcdefghij' }, true)
    expect(current.pinCount).toBe(1)
    expect(policy.get('old')).toBeUndefined()
    expect(policy.get('current')).toEqual({ text: 'abcdefghij' })
    expect(policy.inspect().find((record) => record.key === 'old')?.storageState).toBe('compacted')
  })

  it('rejects pinned records that exceed hard limits and never compacts fact events', () => {
    const policy = new SessionStoragePolicy({ maxEventLogBytes: 12, maxTotalMemoryBytes: 12 })
    policy.put('event', 'event-1', { ok: true }, true)
    expect(() => policy.put('event', 'event-2', { too: 'large' })).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(() => policy.compact('event-1')).toThrow('FACT_EVENT_REQUIRES_PERSISTENCE')
  })

  it('tracks pin lifecycle without exposing mutable values', () => {
    const policy = new SessionStoragePolicy({ maxResultBytes: 100 })
    const value = { list: [1] }
    policy.put('result', 'r1', value)
    value.list.push(2)
    policy.pin('r1')
    policy.unpin('r1')
    expect(policy.get('r1')).toEqual({ list: [1] })
    expect(policy.inspect()[0]?.pinCount).toBe(0)
  })
})
