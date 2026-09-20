import { describe, expect, it } from 'vitest'
import { PulseRuntime, SessionStoragePolicy } from '@pulse/runtime'
import type { LaneProgram } from '@pulse/runtime'

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

  it('keeps runtime-owned pin sources idempotent across reconciliation', () => {
    const policy = new SessionStoragePolicy({ maxResultBytes: 100 })
    policy.replacePinSource('lane-1', ['r1'])
    policy.put('result', 'r1', { ok: true })
    policy.replacePinSource('lane-1', ['r1'])
    expect(policy.inspect().find((record) => record.key === 'r1')?.pinCount).toBe(1)
    policy.replacePinSource('lane-1', [])
    expect(policy.inspect().find((record) => record.key === 'r1')?.pinCount).toBe(0)
  })

  it('automatically pins active lane snapshots and LLM requests', async () => {
    let release!: () => void
    const program: LaneProgram = { id: 'storage-pins', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'request', kind: 'llm', concurrencyClass: 'llm', input: { request: {} } }] }], next: { programId: 'storage-pins', programVersion: '1', step: 'done', locals: {} } }) }
    const runtime = new PulseRuntime({ maxLaneStepsPerTick: 1, effectExecutor: async (_effect, signal) => await new Promise((resolve) => { release = () => resolve({ value: { ok: true } }); signal.addEventListener('abort', () => resolve({ value: null }), { once: true }) }) })
    runtime.createAgent('pin active work', program)
    runtime.tick()
    await Promise.resolve()
    const records = runtime.storagePolicy.inspect()
    expect(records.find((record) => record.key.startsWith('snapshot:lane:'))?.pinCount).toBeGreaterThan(0)
    expect(records.find((record) => record.key.startsWith('snapshot:request:'))?.pinCount).toBeGreaterThan(0)
    release()
  })

  it('persists residency and pin sources for restart reconstruction', () => {
    const policy = new SessionStoragePolicy({ maxResultBytes: 100 })
    policy.replacePinSource('lane-1', ['result:r1'])
    policy.put('result', 'result:r1', { answer: 1 })
    const restored = SessionStoragePolicy.fromSnapshot(JSON.parse(JSON.stringify(policy.snapshot())))
    expect(restored.get('result:r1')).toEqual({ answer: 1 })
    expect(restored.inspect().find((record) => record.key === 'result:r1')).toMatchObject({ pinCount: 1, storageState: 'memory' })
  })
})
