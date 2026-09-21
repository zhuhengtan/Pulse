import { describe, expect, it } from 'vitest'
import { EffectOutbox, FileRuntimeContentStore, FileRuntimeEventArchive, FileRuntimePersistenceBackend, PulseRuntime, createRuntimeState, exportRuntimePersistence, importRuntimePersistence, MutationLog, serializeRuntimePersistence } from '@pulse/runtime'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

  it('rejects outbox snapshots with inconsistent identity or claim metadata', () => {
    const outbox = new EffectOutbox()
    outbox.enqueue({ id: 'effect-1', attemptId: 'attempt-1' }, 10)
    const identity = outbox.snapshot()
    identity.entries[0]!.id = 'wrong-id'
    expect(() => EffectOutbox.fromSnapshot(identity)).toThrow('INVALID_OUTBOX_SNAPSHOT')

    const nonFinite = outbox.snapshot()
    nonFinite.entries[0]!.createdAt = Number.NaN
    expect(() => EffectOutbox.fromSnapshot(nonFinite)).toThrow('INVALID_OUTBOX_SNAPSHOT')

    const claimedWithoutClaim = outbox.snapshot()
    claimedWithoutClaim.entries[0]!.state = 'claimed'
    expect(() => EffectOutbox.fromSnapshot(claimedWithoutClaim)).toThrow('INVALID_OUTBOX_SNAPSHOT')
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

  it('persists queued Host facts and resumes command ids after restore', () => {
    const runtime = new PulseRuntime()
    runtime.enqueueHostCommand({ type: 'cancel', agentId: 'agent-1', reason: 'USER_REQUESTED' })
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence() })
    expect(restored.factInbox.snapshot().queue).toHaveLength(1)
    expect(restored.factInbox.snapshot().queue[0]?.eventId).toBe('host-command-1')
    restored.enqueueHostCommand({ type: 'cancel', agentId: 'agent-2', reason: 'USER_REQUESTED' })
    expect(restored.factInbox.snapshot().queue.map((envelope) => envelope.eventId)).toEqual(['host-command-1', 'host-command-2'])
  })

  it('marks Artifact residency persisted only after the backend acknowledges the save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-artifact-persisted-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const runtime = new PulseRuntime()
      const program = { id: 'artifact-persisted', version: '1', step: () => ({ actions: [], next: { programId: 'artifact-persisted', programVersion: '1', step: 'start', locals: {} } }) }
      const { laneId } = runtime.createAgent('artifact persistence', program)
      const artifact = runtime.publishArtifact({ mediaType: 'text/plain', content: 'durable', laneId })
      expect(runtime.state.artifacts.get(artifact.ref)?.storageState).toBe('memory')
      await expect(runtime.persist({ save: async () => { throw new Error('PERSISTENCE_UNAVAILABLE') } })).rejects.toThrow('PERSISTENCE_UNAVAILABLE')
      expect(runtime.state.artifacts.get(artifact.ref)?.storageState).toBe('memory')
      await runtime.persist(backend)
      expect(runtime.state.artifacts.get(artifact.ref)?.storageState).toBe('persisted')
      const restored = await PulseRuntime.restore(backend)
      expect(restored.state.artifacts.get(artifact.ref)?.storageState).toBe('persisted')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('externalizes Result bodies while preserving a durable ResultRef index', async () => {
    let saved: any
    const values = new Map<string, any>()
    const backend = {
      load: async () => saved,
      save: async (snapshot: any) => { saved = structuredClone(snapshot) },
      resultStore: {
        save: async (ref: string, value: any) => { values.set(ref, structuredClone(value)) },
        load: async (ref: string) => values.has(ref) ? structuredClone(values.get(ref)) : undefined,
      },
    }
    const program = { id: 'external-result', version: '1', step: ({ lane }: any) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects' as const, effects: [{ key: 'work', kind: 'tool' as const, concurrencyClass: 'tool' as const, input: {} }], wait: { onUnsatisfied: 'resume_with_error' as const } }], next: { programId: 'external-result', programVersion: '1', step: 'finish', locals: {} } }
      : { actions: [{ type: 'complete' as const, result: { done: true } }], next: { programId: 'external-result', programVersion: '1', step: 'finish', locals: {} } } }
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { answer: 42 } }) })
    const { agentId } = runtime.createAgent('external result', program)
    await runtime.start(agentId).outcome()
    const resultRef = [...runtime.state.results.values()].find((result) => result.effectId === 'effect-1')?.id
    expect(resultRef).toBeDefined()
    await runtime.persist(backend)
    const persistedResult = saved.state.state.results.find(([ref]: [string, unknown]) => ref === resultRef)?.[1]
    expect(persistedResult.value).toBeUndefined()
    expect(saved.resultBodies).toBe('external')
    expect(values.get(resultRef as string)).toEqual({ answer: 42 })
    const restored = await PulseRuntime.restore(backend, { programs: [program] })
    expect(restored.state.results.get(resultRef as string)?.value).toEqual({ answer: 42 })
    const missingResultIndex = structuredClone(saved)
    missingResultIndex.externalResultRefs = []
    await expect(PulseRuntime.restore({ load: async () => missingResultIndex, save: async () => undefined, resultStore: backend.resultStore })).rejects.toThrow('INVALID_RUNTIME_PERSISTENCE_REFERENCE:result:')
  })

  it('provides an idempotent atomic file body store for Result and Snapshot contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-content-store-'))
    try {
      const store = new FileRuntimeContentStore(directory)
      await store.save('result-1', { answer: 42 })
      await store.save('result-1', { answer: 42 })
      expect(await store.load('result-1')).toEqual({ answer: 42 })
      await expect(store.save('result-1', { answer: 43 })).rejects.toThrow('RUNTIME_CONTENT_CONFLICT')
      expect(await store.load('missing')).toBeUndefined()
      await expect(store.save('', null)).rejects.toThrow('INVALID_RUNTIME_CONTENT_REF')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('persists checkpoint facts through the file-backed EventArchive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-event-archive-'))
    try {
      const archive = new FileRuntimeEventArchive(join(directory, 'archive'))
      const backend = { load: async () => undefined, save: async () => undefined, eventArchive: archive }
      const runtime = new PulseRuntime()
      const program = { id: 'file-event-archive', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'file-event-archive', programVersion: '1', step: 'done', locals: {} } }) }
      const { agentId } = runtime.createAgent('file archive', program)
      await runtime.start(agentId).outcome()
      const checkpoint = await runtime.checkpoint(backend)
      const archived = await archive.read(1, checkpoint.eventArchive?.through)
      expect(archived.length).toBeGreaterThan(0)
      await archive.append(archived)
      expect((await archive.read(archived[0]!.seq, archived.at(-1)!.seq)).length).toBe(archived.length)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('externalizes Context snapshot bodies while preserving stable snapshot indexes', async () => {
    let saved: any
    const values = new Map<string, any>()
    const backend = {
      load: async () => saved,
      save: async (snapshot: any) => { saved = structuredClone(snapshot) },
      snapshotStore: {
        save: async (ref: string, value: any) => { values.set(ref, structuredClone(value)) },
        load: async (ref: string) => values.has(ref) ? structuredClone(values.get(ref)) : undefined,
      },
    }
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('external snapshots', { id: 'external-snapshots', version: '1', step: () => ({ actions: [], next: { programId: 'external-snapshots', programVersion: '1', step: 'done', locals: {} } }) })
    await runtime.persist(backend)
    expect(saved.snapshotBodies).toBe('external')
    expect(saved.externalSnapshotRefs).toEqual(expect.arrayContaining([`global:${agentId}:0`, `lane:${laneId}:0`]))
    expect(saved.state.state.agents.find(([id]: [string, unknown]) => id === agentId)?.[1].globalVersions[0][1]).toBeNull()
    expect(saved.state.state.lanes.find(([id]: [string, unknown]) => id === laneId)?.[1].context.state).toBeNull()
    const restored = await PulseRuntime.restore(backend)
    expect(restored.state.agents.get(agentId)?.globalVersions.get(0)).toEqual({})
    expect(restored.state.lanes.get(laneId)?.context.state).toEqual({})
    const missingSnapshotIndex = structuredClone(saved)
    missingSnapshotIndex.externalSnapshotRefs = missingSnapshotIndex.externalSnapshotRefs.filter((ref: string) => ref !== `lane:${laneId}:0`)
    await expect(PulseRuntime.restore({ load: async () => missingSnapshotIndex, save: async () => undefined, snapshotStore: backend.snapshotStore })).rejects.toThrow('INVALID_RUNTIME_PERSISTENCE_REFERENCE:lane:')
    await expect(PulseRuntime.restore({ load: async () => saved, save: async () => undefined })).rejects.toThrow('RUNTIME_SNAPSHOT_STORE_REQUIRED')
  })

  it('composes external Result and Snapshot bodies through checkpoint persistence', async () => {
    let saved: any
    const values = new Map<string, any>()
    const backend = {
      load: async () => saved,
      save: async (snapshot: any) => { saved = structuredClone(snapshot) },
      resultStore: { save: async (ref: string, value: any) => { values.set(`result:${ref}`, structuredClone(value)) }, load: async (ref: string) => values.get(`result:${ref}`) },
      snapshotStore: { save: async (ref: string, value: any) => { values.set(`snapshot:${ref}`, structuredClone(value)) }, load: async (ref: string) => values.get(`snapshot:${ref}`) },
    }
    const program = { id: 'external-checkpoint', version: '1', step: ({ lane }: any) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects' as const, effects: [{ key: 'work', kind: 'tool' as const, concurrencyClass: 'tool' as const, input: {} }], wait: { onUnsatisfied: 'resume_with_error' as const } }], next: { programId: 'external-checkpoint', programVersion: '1', step: 'finish', locals: {} } }
      : { actions: [{ type: 'complete' as const, result: { done: true } }], next: { programId: 'external-checkpoint', programVersion: '1', step: 'finish', locals: {} } } }
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { answer: 7 } }) })
    const { agentId } = runtime.createAgent('external checkpoint', program)
    await runtime.start(agentId).outcome()
    await runtime.checkpoint(backend)
    expect(saved.resultBodies).toBe('external')
    expect(saved.snapshotBodies).toBe('external')
    expect(saved.externalSnapshotRefs).toEqual(expect.arrayContaining([expect.stringMatching(/^global:/), expect.stringMatching(/^lane:/)]))
    const restored = await PulseRuntime.restore(backend, { programs: [program] })
    expect([...restored.state.results.values()].some((result) => result.value && (result.value as any).answer === 7)).toBe(true)
    expect(restored.state.agents.get(agentId)?.globalVersions.get(0)).toEqual({})
  })

  it('flushes overdue retry timers after restoring the persisted virtual time', async () => {
    let saved: any
    const backend = { load: async () => saved, save: async (snapshot: any) => { saved = structuredClone(snapshot) } }
    const program = { id: 'restore-overdue-retry', version: '1', step: () => ({ actions: [], next: { programId: 'restore-overdue-retry', programVersion: '1', step: 'done', locals: {} } }) }
    const runtime = new PulseRuntime({ maxRunning: { tool: 0 } })
    const { agentId, laneId } = runtime.createAgent('overdue retry', program)
    runtime.state.effects.set('effect-1', { id: 'effect-1', agentId, ownerLaneId: laneId, key: 'retry', kind: 'tool', concurrencyClass: 'tool', input: {}, state: 'retry_wait', retryAt: 0, attemptId: 'effect-1-attempt-2', attemptNo: 2, executionState: 'local', sideEffectState: 'none', retryPolicy: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false } } as any)
    runtime.state.lanes.get(laneId)!.ownedEffectIds.add('effect-1')
    await runtime.persist(backend)
    const restored = await PulseRuntime.restore(backend, { programs: [program], maxLaneStepsPerTick: 0 })
    restored.tick()
    expect(restored.state.effects.get('effect-1')?.state).toBe('queued')
    expect(restored.state.effects.get('effect-1')?.retryAt).toBeUndefined()
    expect(restored.state.events.some((event) => event.type === 'effect.retry_ready')).toBe(true)
  })

  it('flushes overdue wait deadlines after restoring the persisted virtual time', async () => {
    let saved: any
    const backend = { load: async () => saved, save: async (snapshot: any) => { saved = structuredClone(snapshot) } }
    const program = { id: 'restore-overdue-wait', version: '1', step: () => ({ actions: [], next: { programId: 'restore-overdue-wait', programVersion: '1', step: 'done', locals: {} } }) }
    const runtime = new PulseRuntime()
    const { agentId, laneId } = runtime.createAgent('overdue wait', program)
    runtime.state.lanes.get(laneId)!.status = 'waiting'
    runtime.state.lanes.get(laneId)!.activeWaitId = 'wait-1'
    runtime.state.waits.set('wait-1', { id: 'wait-1', laneId, state: 'pending', spec: { dependencies: [], mode: 'all', onUnsatisfied: 'resume_with_error', reason: 'dependency', deadlineAt: 0 } })
    await runtime.persist(backend)
    const restored = await PulseRuntime.restore(backend, { programs: [program], maxLaneStepsPerTick: 0 })
    restored.tick()
    expect(restored.state.waits.get('wait-1')?.state).toBe('unsatisfied')
    expect(restored.state.lanes.get(laneId)?.status).toBe('ready')
    expect(restored.state.lanes.get(laneId)?.pendingResumeInput?.type).toBe('wait')
    expect(restored.state.events.some((event) => event.type === 'wait.deadline_exceeded')).toBe(true)
    expect(restored.state.agents.get(agentId)).toBeDefined()
  })

  it('rejects malformed persistence envelopes before recovery', () => {
    expect(() => importRuntimePersistence({ schemaVersion: 1 } as any)).toThrow('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
    expect(() => importRuntimePersistence({ schemaVersion: 1, state: { state: {} }, mutationLog: {}, outbox: {} } as any)).toThrow('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
  })

  it('rejects a persistence snapshot with dangling runtime references', () => {
    const snapshot = exportRuntimePersistence(createRuntimeState(), new MutationLog(), new EffectOutbox())
    snapshot.state.state.agents.push(['agent-1', { id: 'agent-1', rootLaneId: 'missing', globalVersions: [], latestGlobalVersion: 0, maxActiveLanes: 1 } as any])
    expect(() => importRuntimePersistence(snapshot)).toThrow('INVALID_RUNTIME_PERSISTENCE_REFERENCE:agent.rootLaneId:agent-1')
  })

  it('rejects malformed checkpoint event watermarks before restore', () => {
    const snapshot = exportRuntimePersistence(createRuntimeState(), new MutationLog(), new EffectOutbox())
    snapshot.checkpoint = { schemaVersion: 1, logWatermark: 0, eventWatermark: -1, state: snapshot.state }
    expect(() => importRuntimePersistence(snapshot)).toThrow('INVALID_RUNTIME_PERSISTENCE_SNAPSHOT')
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
      const persisted = await backend.load()
      expect(persisted?.storage?.records.some((record) => record.storageState === 'persisted')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('automatically persists the runtime lifecycle and supports explicit flush', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-auto-persist-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const program = { id: 'auto-persist', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'auto-persist', programVersion: '1', step: 'done', locals: {} } }) }
      const runtime = new PulseRuntime({ persistenceBackend: backend })
      const { agentId } = runtime.createAgent('auto persistence', program)

      await runtime.flushPersistence()
      const pendingSnapshot = await backend.load()
      expect(pendingSnapshot?.state.state.agents.find(([id]) => id === agentId)?.[1].state).toBe('running')

      expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
      const completedSnapshot = await backend.load()
      expect(completedSnapshot?.state.state.agents.find(([id]) => id === agentId)?.[1].state).toBe('succeeded')

      const restored = await PulseRuntime.restore(backend, { persistenceBackend: backend })
      expect(restored.state.agents.get(agentId)?.state).toBe('succeeded')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('durably records a pending outbox entry before dispatching an Effect', async () => {
    let release!: () => void
    let persistedPending: import('@pulse/runtime').RuntimePersistenceSnapshot | undefined
    let started = false
    const backend = {
      load: async () => undefined,
      save: async (snapshot: import('@pulse/runtime').RuntimePersistenceSnapshot) => {
        if (snapshot.outbox.entries.length > 0 && persistedPending === undefined) {
          persistedPending = snapshot
          await new Promise<void>((resolve) => { release = resolve })
        }
      },
    }
    const runtime = new PulseRuntime({ persistenceBackend: backend, effectExecutor: async () => { started = true; return { value: { ok: true } } } })
    await runtime.flushPersistence()
    const program = { id: 'durable-dispatch-gate', version: '1', step: () => ({ actions: [{ type: 'submit_effects' as const, effects: [{ key: 'work', kind: 'tool' as const, concurrencyClass: 'tool' as const, input: {} }], wait: { onUnsatisfied: 'resume_with_error' as const } }], next: { programId: 'durable-dispatch-gate', programVersion: '1', step: 'done', locals: {} } }) }
    runtime.createAgent('durable dispatch gate', program)
    await runtime.flushPersistence()
    runtime.tick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(persistedPending?.outbox.entries).toHaveLength(1)
    expect(persistedPending?.outbox.entries[0]?.state).toBe('pending')
    expect(started).toBe(false)
    release()
    await runtime.flushPersistence()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(started).toBe(true)
  })

  it('queues persistence when an async effect settles outside run()', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-async-auto-persist-'))
    try {
      const fileBackend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      let saves = 0
      const backend = { load: () => fileBackend.load(), save: async (snapshot: Parameters<typeof fileBackend.save>[0]) => { saves++; await fileBackend.save(snapshot) } }
      let settle!: () => void
      let executionDone!: () => void
      const effectExecutionDone = new Promise<void>((resolve) => { executionDone = resolve })
      const runtime = new PulseRuntime({ persistenceBackend: backend, effectExecutor: async () => { const value = await new Promise((resolve) => { settle = () => resolve({ value: { ok: true } }) }); executionDone(); return value as any } })
      const program = { id: 'async-auto-persist', version: '1', step: ({ lane }: any) => lane.resume.step === 'start'
        ? { actions: [{ type: 'submit_effects' as const, effects: [{ key: 'work', kind: 'tool' as const, concurrencyClass: 'tool' as const, input: {} }], wait: { onUnsatisfied: 'resume_with_error' as const } }], next: { programId: 'async-auto-persist', programVersion: '1', step: 'finish', locals: {} } }
        : { actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'async-auto-persist', programVersion: '1', step: 'finish', locals: {} } } }
      runtime.createAgent('async persistence', program)
      runtime.tick()
      await runtime.flushPersistence()
      const savesBeforeSettlement = saves
      settle()
      await effectExecutionDone
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(saves).toBeGreaterThan(savesBeforeSettlement)
      await runtime.flushPersistence()
      expect((await backend.load())?.state.state.effects.find(([id]) => id === 'effect-1')?.[1].state).toBe('succeeded')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('restores through the backend and quarantines an in-flight write effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-restore-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const source = new PulseRuntime()
      const { agentId, laneId } = source.createAgent('restore', { id: 'restore', version: '1', step: () => ({ actions: [], next: { programId: 'restore', programVersion: '1', step: 'start', locals: {} } }) })
      source.state.effects.set('effect-1', { id: 'effect-1', agentId, ownerLaneId: laneId, key: 'write', kind: 'tool', concurrencyClass: 'tool', input: {}, locks: [{ resource: 'workspace', mode: 'exclusive' }], state: 'running', attemptId: 'effect-1-attempt-1', attemptNo: 1, executionState: 'running', sideEffectState: 'applied', sideEffectPolicy: 'write' })
      source.outbox.enqueue({ id: 'effect-1', attemptId: 'effect-1-attempt-1' })
      await source.persist(backend)
      const restored = await PulseRuntime.restore(backend)
      expect(restored.state.effects.get('effect-1')?.state).toBe('reconcile_required')
      expect(restored.quarantine.unresolvedEffectIds).toEqual(['effect-1'])
      expect(restored.resourceLocks.isHeld('workspace', 'exclusive')).toBe(true)
      restored.abandonEffect('effect-1')
      expect(restored.resourceLocks.isHeld('workspace')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('recovers an in-flight write after the owning process is terminated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-process-recovery-'))
    try {
      const filePath = join(directory, 'runtime.json')
      const viteNodePackage = (await readdir(resolve('node_modules/.pnpm'))).find((name) => name.startsWith('vite-node@'))
      if (!viteNodePackage) throw new Error('vite-node is required for process recovery test')
      const child = spawn(process.execPath, [resolve('node_modules/.pnpm', viteNodePackage, 'node_modules/vite-node/vite-node.mjs'), '--script', resolve('tests/process-recovery-child.ts')], {
        cwd: resolve('.'),
        env: { ...process.env, PULSE_PROCESS_RECOVERY_CHILD: '1', PULSE_PROCESS_RECOVERY_PATH: filePath },
        stdio: 'ignore',
      })
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      })
      expect(exit.code).toBeNull()
      expect(exit.signal).toBe('SIGKILL')
      const restored = await PulseRuntime.restore(new FileRuntimePersistenceBackend(filePath))
      expect(restored.state.effects.get('effect-1')?.state).toBe('reconcile_required')
      expect(restored.mutationLog.entries.some((entry) => entry.transactionId.startsWith('recovery:effect-1:'))).toBe(true)
      expect(restored.quarantine.unresolvedEffectIds).toEqual(['effect-1'])
      expect(restored.resourceLocks.isHeld('workspace', 'exclusive')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps online journal events and replayed events under the same transaction id', async () => {
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const program = { id: 'journal-tx', version: '1', step: ({ lane }: any) => lane.resume.step === 'start'
      ? { actions: [{ type: 'submit_effects' as const, effects: [{ key: 'work', kind: 'tool' as const, concurrencyClass: 'tool' as const, input: {} }], wait: { onUnsatisfied: 'resume_with_error' as const } }], next: { programId: 'journal-tx', programVersion: '1', step: 'done', locals: {} } }
      : { actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'journal-tx', programVersion: '1', step: 'done', locals: {} } } }
    const { agentId } = runtime.createAgent('journal', program)
    await runtime.start(agentId).outcome()
    const online = runtime.state.events.find((event) => event.type === 'effect.settled')
    const journal = runtime.mutationLog.entries.flatMap((entry) => entry.mutations).find((mutation) => mutation.op === 'appendEvent' && mutation.event.type === 'effect.settled')
    expect(online?.txId).toBeDefined()
    expect(journal && journal.op === 'appendEvent' ? journal.event.txId : undefined).toBe(online?.txId)
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

  it('archives fact events before checkpoint truncation and records the archive watermark', async () => {
    let saved: any
    const archived: any[] = []
    const program = { id: 'event-archive', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'event-archive', programVersion: '1', step: 'done', locals: {} } }) }
    const backend = {
      load: async () => saved,
      save: async (snapshot: any) => { saved = structuredClone(snapshot) },
      eventArchive: {
        append: async (events: any[]) => { archived.push(...structuredClone(events)) },
        read: async (fromSeq: number, toSeq = Number.POSITIVE_INFINITY) => archived.filter((event) => event.seq >= fromSeq && event.seq <= toSeq).map((event) => structuredClone(event)),
      },
    }
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const { agentId } = runtime.createAgent('archive events', program)
    await runtime.start(agentId).outcome()
    const checkpoint = await runtime.checkpoint(backend)
    expect(archived.length).toBeGreaterThan(0)
    expect(checkpoint.eventArchive?.through).toBe(checkpoint.checkpoint?.eventWatermark)
    expect((await backend.eventArchive.read(archived[0].seq, archived.at(-1).seq)).length).toBe(archived.length)
    expect(runtime.state.events).toHaveLength(0)
  })

  it('keeps the current snapshot and events when the external archive is unavailable', async () => {
    let saves = 0
    const runtime = new PulseRuntime({ effectExecutor: async () => ({ value: { ok: true } }) })
    const program = { id: 'event-archive-failure', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'event-archive-failure', programVersion: '1', step: 'done', locals: {} } }) }
    const { agentId } = runtime.createAgent('archive failure', program)
    await runtime.start(agentId).outcome()
    const eventCount = runtime.state.events.length
    const backend = {
      load: async () => undefined,
      save: async () => { saves++ },
      eventArchive: { append: async () => { throw new Error('ARCHIVE_UNAVAILABLE') }, read: async () => [] },
    }
    await expect(runtime.checkpoint(backend)).rejects.toThrow('ARCHIVE_UNAVAILABLE')
    expect(saves).toBe(0)
    expect(runtime.state.events).toHaveLength(eventCount)
    expect(runtime.state.eventsCompactedThrough).toBeUndefined()
  })

  it('compacts fact events at checkpoint and exposes a stream gap after restore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-event-checkpoint-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const runtime = new PulseRuntime()
      const program = { id: 'event-checkpoint', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'event-checkpoint', programVersion: '1', step: 'done', locals: {} } }) }
      const { agentId } = runtime.createAgent('event checkpoint', program)
      runtime.tick()
      const eventWatermark = runtime.state.events.at(-1)?.seq
      expect(eventWatermark).toBeGreaterThan(0)
      const checkpoint = await runtime.checkpoint(backend)
      expect(checkpoint.checkpoint?.eventWatermark).toBe(eventWatermark)
      expect(checkpoint.checkpoint?.state.state.events).toEqual([])
      expect(runtime.state.events).toEqual([])
      expect(runtime.state.eventsCompactedThrough).toBe(eventWatermark)

      const restored = await PulseRuntime.restore(backend)
      restored.register(program)
      const session = restored.start(agentId)
      const first = await session.stream(0)[Symbol.asyncIterator]().next()
      expect(first.value).toMatchObject({ type: 'gap', fromSeq: 1, toSeq: eventWatermark })
      expect((await session.outcome()).status).toBe('succeeded')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('round-trips Runtime Storage Policy with the persistence envelope', () => {
    const runtime = new PulseRuntime({ storagePolicy: { maxResultBytes: 1024 } })
    const program = { id: 'persist-storage', version: '1', step: () => ({ actions: [{ type: 'complete' as const, result: { ok: true } }], next: { programId: 'persist-storage', programVersion: '1', step: 'done', locals: {} } }) }
    runtime.createAgent('storage persistence', program)
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence() })
    expect(restored.storagePolicy.inspect().some((record) => record.key.startsWith('snapshot:lane:'))).toBe(true)
  })

  it('rejects a tampered persistence envelope before recovery', () => {
    const runtime = new PulseRuntime()
    const snapshot = runtime.exportPersistence()
    expect(snapshot.integrity).toMatchObject({ algorithm: 'sha256', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const tampered = structuredClone(snapshot)
    tampered.state.state.now = 99
    expect(() => importRuntimePersistence(tampered)).toThrow('INVALID_RUNTIME_PERSISTENCE_INTEGRITY')
  })

  it('rejects a stale Runtime persistence writer instead of overwriting a shared snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-runtime-conflict-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const program = { id: 'runtime-conflict', version: '1', step: () => ({ actions: [], next: { programId: 'runtime-conflict', programVersion: '1', step: 'start', locals: {} } }) }
      const first = new PulseRuntime({ persistenceBackend: backend })
      first.createAgent('baseline', program)
      await first.flushPersistence()
      const second = await PulseRuntime.restore(backend, { persistenceBackend: backend })
      first.createAgent('first-writer', program)
      await first.flushPersistence()
      second.createAgent('stale-writer', program)
      await expect(second.flushPersistence()).rejects.toThrow('RUNTIME_PERSISTENCE_CONFLICT')
      const latest = await PulseRuntime.restore(backend)
      expect([...latest.state.agents.values()].some((agent) => agent.goal === 'first-writer')).toBe(true)
      expect([...latest.state.agents.values()].some((agent) => agent.goal === 'stale-writer')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
