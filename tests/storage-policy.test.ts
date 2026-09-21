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

  it('pins queued Host facts until the Scheduler drains them', () => {
    const runtime = new PulseRuntime()
    runtime.enqueueHostCommand({ type: 'cancel', agentId: 'missing-agent', reason: 'USER_REQUESTED' })
    expect(runtime.storagePolicy.inspect().find((record) => record.key === 'snapshot:fact:host-command-1')).toMatchObject({ pinCount: 1 })
    runtime.tick()
    expect(runtime.storagePolicy.inspect().some((record) => record.key === 'snapshot:fact:host-command-1')).toBe(false)
  })

  it('rejects a Host fact before enqueue when storage admission fails', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxSnapshotBytes: 1 } })
    expect(() => runtime.enqueueHostCommand({ type: 'cancel', agentId: 'agent-1', reason: 'USER_REQUESTED' })).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    expect(runtime.factInbox.snapshot().queue).toHaveLength(0)
    expect(runtime.storagePolicy.inspect().some((record) => record.key.startsWith('snapshot:fact:'))).toBe(false)
  })

  it('keeps the live policy unchanged when a transactional rebuild cannot fit', () => {
    const program: LaneProgram = { id: 'transactional-storage-rebuild', version: '1', step: () => ({ actions: [{ type: 'complete', result: { ok: true } }], next: { programId: 'transactional-storage-rebuild', programVersion: '1', step: 'done', locals: {} } }) }
    const runtime = new PulseRuntime()
    runtime.createAgent('transactional rebuild', program)
    runtime.tick()
    const before = runtime.storagePolicy.snapshot()
    const eventBytes = before.records.filter((record) => record.kind === 'event').reduce((total, record) => total + record.bytes, 0)
    expect(eventBytes).toBeGreaterThan(0)
    ;(runtime.storagePolicy as any).limits.maxEventLogBytes = eventBytes - 1
    expect(() => runtime.tick()).toThrow('SESSION_STORAGE_LIMIT_EXCEEDED')
    const after = runtime.storagePolicy.snapshot()
    expect(after.records).toEqual(before.records)
    expect(after.pinSources).toEqual(before.pinSources)
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

  it('rejects malformed storage policy snapshots before replacing live state', () => {
    const policy = new SessionStoragePolicy({ maxResultBytes: 100 })
    policy.put('result', 'result:r1', { answer: 1 })
    const before = policy.snapshot()
    const malformed = structuredClone(before)
    malformed.limits.maxResultBytes = -1
    expect(() => SessionStoragePolicy.fromSnapshot(malformed)).toThrow('INVALID_STORAGE_POLICY_SNAPSHOT')
    const invalidRecord = structuredClone(before)
    invalidRecord.records[0]!.storageState = 'compacted'
    expect(() => policy.replaceSnapshot(invalidRecord)).toThrow('INVALID_STORAGE_POLICY_SNAPSHOT')
    expect(policy.snapshot()).toEqual(before)
    const invalidHash = structuredClone(before)
    invalidHash.records[0]!.hash = '0'.repeat(64)
    expect(() => SessionStoragePolicy.fromSnapshot(invalidHash)).toThrow('INVALID_STORAGE_POLICY_SNAPSHOT')
  })

  it('marks records persisted only after the backend acknowledges the snapshot', () => {
    const policy = new SessionStoragePolicy({ maxResultBytes: 100 })
    policy.put('result', 'result:r1', { answer: 1 })
    expect(policy.inspect()[0]?.storageState).toBe('memory')
    policy.markPersisted()
    expect(policy.inspect()[0]).toMatchObject({ storageState: 'persisted', bytes: expect.any(Number) })
    expect(policy.get('result:r1')).toBeUndefined()
    expect(policy.put('result', 'result:r1', { answer: 1 })).toMatchObject({ storageState: 'persisted' })
    expect(policy.get('result:r1')).toBeUndefined()
  })

  it('refreshes runtime storage admission after direct Effect settlement', () => {
    const program: LaneProgram = { id: 'direct-settlement-storage', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'direct-settlement-storage', programVersion: '1', step: 'done', locals: {} } }) }
    const runtime = new PulseRuntime()
    runtime.createAgent('direct settlement', program)
    runtime.tick()
    const effect = runtime.state.effects.get('effect-1')!
    runtime.completeEffect(effect.id, { value: { ok: true } })
    expect(runtime.storagePolicy.inspect().some((record) => record.key === 'result:result-1')).toBe(true)
    expect(runtime.state.results.get('result-1')).toMatchObject({ storageState: 'memory', pinCount: expect.any(Number) })
  })

  it('keeps Result residency and pin count aligned with backend acknowledgement', async () => {
    const program: LaneProgram = { id: 'result-residency', version: '1', step: () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {} }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'result-residency', programVersion: '1', step: 'done', locals: {} } }) }
    const runtime = new PulseRuntime()
    runtime.createAgent('result residency', program)
    runtime.tick()
    runtime.completeEffect('effect-1', { value: { ok: true } })
    expect(runtime.state.results.get('result-1')).toMatchObject({ storageState: 'memory', pinCount: expect.any(Number) })
    await runtime.persist({ save: async () => undefined })
    expect(runtime.state.results.get('result-1')).toMatchObject({ storageState: 'persisted', pinCount: expect.any(Number) })
  })
})
