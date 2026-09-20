import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PulseRuntime } from '@pulse/runtime'
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

    const restored = new PulseRuntime({ persistence: snapshot, persistenceBackend: backend, programs: [program] })
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
})
