import { describe, expect, it } from 'vitest'
import { EffectOutbox, createRuntimeState, exportRuntimePersistence, importRuntimePersistence, MutationLog, serializeRuntimePersistence } from '@pulse/runtime'

describe('effect outbox and runtime persistence envelope', () => {
  it('deduplicates logical attempts and recovers claimed work for redispatch', () => {
    const outbox = new EffectOutbox()
    const first = outbox.enqueue({ id: 'effect-1', attemptId: 'effect-1-attempt-1' }, 10)
    expect(outbox.enqueue({ id: 'effect-1', attemptId: 'effect-1-attempt-1' }, 20)).toEqual(first)
    const claimed = outbox.claim(first.id)
    expect(claimed?.state).toBe('claimed')
    const recovered = EffectOutbox.fromSnapshot(JSON.parse(JSON.stringify(outbox.snapshot())))
    const state = createRuntimeState()
    state.effects.set('effect-1', { id: 'effect-1', agentId: 'agent-1', ownerLaneId: 'lane-1', key: 'work', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'queued', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'local', sideEffectState: 'none' })
    expect(recovered.recover(state).requeued).toEqual([first.id])
    expect(recovered.pending()).toHaveLength(1)
  })

  it('round-trips state, mutation log, and outbox as one persistence envelope', () => {
    const state = createRuntimeState()
    const log = new MutationLog()
    log.append('tx-1', [{ op: 'setNow', now: 12 }], 12)
    const outbox = new EffectOutbox()
    outbox.enqueue({ id: 'effect-1', attemptId: 'attempt-1' }, 12)
    const restored = importRuntimePersistence(JSON.parse(JSON.stringify(serializeRuntimePersistence(state, log, outbox))))
    expect(restored.state.now).toBe(0)
    expect(restored.mutationLog.size).toBe(1)
    expect(restored.outbox.size).toBe(1)
    expect(exportRuntimePersistence(state, log, outbox).schemaVersion).toBe(1)
  })

  it('rejects malformed persistence envelopes before recovery', () => {
    expect(() => importRuntimePersistence({ schemaVersion: 1 } as any)).toThrow('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  })
})
