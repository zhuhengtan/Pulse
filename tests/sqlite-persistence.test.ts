import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PulseRuntime, exportWarmStartSession } from '@pulse/runtime'
import { SqliteRuntimePersistenceBackend, withRuntimePersistenceIntegrity } from '@pulse/runtime'
import type { LaneProgram, RuntimePersistenceSnapshot } from '@pulse/runtime'

const point = (id: string, step: string) => ({ programId: id, programVersion: '1', step, locals: {} })

describe('SQLite runtime persistence backend', () => {
  const directories: string[] = []

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('durably saves and restores a Runtime snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-'))
    directories.push(directory)
    const backend = new SqliteRuntimePersistenceBackend(join(directory, 'runtime', 'pulse.db'))
    const program: LaneProgram = { id: 'sqlite-runtime', version: '1', step: () => ({ actions: [{ type: 'complete', result: { restored: true } }], next: point('sqlite-runtime', 'done') }) }
    const runtime = new PulseRuntime({ persistenceBackend: backend, programs: [program] })
    const { agentId } = runtime.createAgent('sqlite persistence', program)
    await runtime.flushPersistence()
    const snapshot = await backend.load()
    expect(snapshot?.integrity?.digest).toMatch(/^[a-f0-9]{64}$/)

    const restored = await PulseRuntime.restore(backend, { persistenceBackend: backend, programs: [program] })
    await expect(restored.start(agentId).outcome()).resolves.toMatchObject({ status: 'succeeded' })
    await backend.close()
  })

  it('uses digest compare-and-swap inside a SQLite transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-cas-'))
    directories.push(directory)
    const backend = new SqliteRuntimePersistenceBackend(join(directory, 'pulse.db'))
    const runtime = new PulseRuntime()
    const first = runtime.exportPersistence()
    await backend.save(first)
    const loaded = await backend.load()
    expect(loaded).toBeDefined()
    const next = withRuntimePersistenceIntegrity(structuredClone(loaded!) as RuntimePersistenceSnapshot)
    next.state.state.now = 11
    const committed = withRuntimePersistenceIntegrity(next)
    await backend.save(committed, loaded!.integrity?.digest)

    const stale = withRuntimePersistenceIntegrity(structuredClone(loaded!) as RuntimePersistenceSnapshot)
    stale.state.state.now = 12
    const staleSnapshot = withRuntimePersistenceIntegrity(stale)
    await expect(backend.save(staleSnapshot, loaded!.integrity?.digest)).rejects.toThrow('RUNTIME_PERSISTENCE_CONFLICT')
    expect((await backend.load())?.state.state.now).toBe(11)
    await backend.close()
  })

  it('integrates Result/Snapshot stores and EventArchive for checkpoint restore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-integrated-'))
    directories.push(directory)
    const backend = new SqliteRuntimePersistenceBackend(join(directory, 'pulse.db'))
    const program: LaneProgram = { id: 'sqlite-integrated', version: '1', step: ({ lane }) => lane.resume.step === 'start'
      ? { actions: [{ type: 'complete', result: { durable: true } }], next: point('sqlite-integrated', 'finish') }
      : { actions: [], next: point('sqlite-integrated', 'finish') } }
    const runtime = new PulseRuntime()
    const { agentId } = runtime.createAgent('integrated sqlite stores', program)
    await expect(runtime.start(agentId).outcome()).resolves.toMatchObject({ status: 'succeeded' })
    const snapshot = await runtime.checkpoint(backend)
    expect(snapshot.resultBodies).toBe('external')
    expect(snapshot.snapshotBodies).toBe('external')
    expect(snapshot.eventArchive).toMatchObject({ through: expect.any(Number) })
    expect(await backend.eventArchive.read(1)).not.toHaveLength(0)
    const restored = await PulseRuntime.restore(backend, { persistenceBackend: backend, programs: [program] })
    expect([...restored.state.results.values()].some((result) => result.value && typeof result.value === 'object' && !Array.isArray(result.value) && result.value.durable === true)).toBe(true)
    await backend.close()
  })

  it('automatically binds the durable Session Store to Runtime construction and restore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-session-binding-'))
    directories.push(directory)
    const backend = new SqliteRuntimePersistenceBackend(join(directory, 'pulse.db'))
    const program: LaneProgram = { id: 'sqlite-session-binding', version: '1', step: () => ({ actions: [{ type: 'complete', result: {} }], next: point('sqlite-session-binding', 'done') }) }
    const source = new PulseRuntime({ persistenceBackend: backend })
    const created = source.createAgent('session source', program)
    source.state.agents.get(created.agentId)!.globalVersions.set(1, { facts: { durable: true } })
    source.state.agents.get(created.agentId)!.latestGlobalVersion = 1
    backend.sessionStore.put(exportWarmStartSession(source.state, created.agentId))
    await source.flushPersistence()

    const target = new PulseRuntime({ sessionStore: backend.sessionStore })
    const copied = target.createAgent({ goal: 'session target', program, warmStart: { sessionId: created.agentId, globalVersion: 1 } })
    expect(target.state.agents.get(copied.agentId)?.globalVersions.get(0)).toEqual({ facts: { durable: true } })
    await backend.close()
  })
})
