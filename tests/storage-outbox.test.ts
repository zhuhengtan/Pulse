import { describe, expect, it } from 'vitest'
import { EffectOutbox, FileRuntimePersistenceBackend, PulseRuntime, createRuntimeState, exportRuntimePersistence, importRuntimePersistence, MutationLog, serializeRuntimePersistence } from '@pulse/runtime'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('writes a complete snapshot through an atomic temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-persistence-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      await new PulseRuntime().persist(backend)
      const restored = await backend.load()
      expect(restored?.schemaVersion).toBe(1)
      expect(restored?.state.schemaVersion).toBe(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('marks the runtime storage records persisted only after a successful save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-persisted-state-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const runtime = new PulseRuntime()
      runtime.createAgent('persisted state', { id: 'persisted-state', version: '1', step: () => ({ actions: [], next: { programId: 'persisted-state', programVersion: '1', step: 'start', locals: {} } }) })
      expect(runtime.storagePolicy.inspect().some((record) => record.storageState === 'memory')).toBe(true)
      await runtime.persist(backend)
      expect(runtime.storagePolicy.inspect().some((record) => record.storageState === 'persisted')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('serializes concurrent saves and leaves no temporary snapshot behind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-persistence-queue-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const first = new PulseRuntime(); first.state.now = 1
      const second = new PulseRuntime(); second.state.now = 2
      await Promise.all([backend.save(first.exportPersistence()), backend.save(second.exportPersistence())])
      const loaded = await backend.load()
      expect(loaded?.state.state.now).toBe(2)
      expect((await readdir(directory)).filter((name) => name.includes('.tmp-'))).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('writes a checkpoint snapshot and resumes mutation sequence after truncation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-checkpoint-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const runtime = new PulseRuntime()
      runtime.state.now = 7
      runtime.mutationLog.append('manual', [{ op: 'setNow', now: 7 }], 7)
      const checkpoint = await runtime.checkpoint(backend)
      expect(checkpoint.checkpoint?.logWatermark).toBe(1)
      expect(runtime.mutationLog.watermark).toBe(1)
      const restored = importRuntimePersistence(JSON.parse(JSON.stringify(await backend.load())))
      expect(restored.state.now).toBe(7)
      expect(restored.mutationLog.watermark).toBe(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('round-trips Runtime Storage Policy with the persistence envelope', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxResultBytes: 1024 } })
    const program = { id: 'persist-storage', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'persist-storage', programVersion: '1', step: 'done', locals: {} } }) }
    runtime.createAgent('storage persistence', program)
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence() })
    expect(restored.storagePolicy.inspect().some((record) => record.key.startsWith('snapshot:lane:'))).toBe(true)
  })
})
