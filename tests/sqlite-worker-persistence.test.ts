import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteWorkerPersistenceBackend, WorkerCoordinator } from '@hunterzhu/pulse-runtime'

describe('SQLite worker persistence backend', () => {
  const directories: string[] = []

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('persists queued and settled lease state and rejects stale CAS writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-worker-sqlite-'))
    directories.push(directory)
    const backend = new SqliteWorkerPersistenceBackend(join(directory, 'worker.db'))
    const coordinator = new WorkerCoordinator({ persistenceBackend: backend })
    coordinator.registerRemote('worker-1')
    coordinator.submit({ value: 1 }, { taskId: 'task-1' })
    await coordinator.flushPersistence()
    const queued = await backend.load()
    expect(queued?.tasks).toEqual([expect.objectContaining({ id: 'task-1', state: 'queued' })])

    const restored = await WorkerCoordinator.fromPersistence(backend)
    restored.registerRemote('worker-2')
    const lease = restored.claim('worker-2', 100)
    expect(lease?.task.id).toBe('task-1')
    await restored.flushPersistence()
    await expect(Promise.resolve(restored.completeRemote('worker-2', lease!.leaseId, { ok: true }))).resolves.toBe(true)
    await restored.flushPersistence()
    expect((await backend.load())?.tasks).toEqual([expect.objectContaining({ id: 'task-1', state: 'succeeded', result: { ok: true } })])
    await expect(backend.save(queued!, queued?.integrity?.digest)).rejects.toThrow('WORKER_PERSISTENCE_CONFLICT')
    await backend.close()
  })
})
