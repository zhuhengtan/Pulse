import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { SqliteDistributedWorkerCoordinator } from '@pulse/runtime'

describe('SqliteDistributedWorkerCoordinator', () => {
  it('atomically claims one queued task across independent coordinator instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-distributed-worker-'))
    const path = join(directory, 'worker.sqlite')
    try {
      const first = new SqliteDistributedWorkerCoordinator(path)
      const second = new SqliteDistributedWorkerCoordinator(path)
      first.registerRemote('worker-a')
      second.registerRemote('worker-b')
      const result = first.submit({ job: 'distributed' }, { taskId: 'distributed-task', idempotencyKey: 'distributed-key', leaseMs: 50 })
      const firstLease = first.claim('worker-a', 100)
      const secondLease = second.claim('worker-b', 100)
      expect(firstLease).toMatchObject({ workerId: 'worker-a', task: { id: 'distributed-task', state: 'leased', attempt: 1 } })
      expect(secondLease).toBeUndefined()
      expect(first.renewLease('worker-a', firstLease!.leaseId, 110, 100)).toBe(210)
      expect(second.completeRemote('worker-a', firstLease!.leaseId, { ok: true }, 120)).toBe(true)
      await expect(result).resolves.toEqual({ ok: true })
      expect(second.get('distributed-task')).toMatchObject({ state: 'succeeded', result: { ok: true } })
      expect(first.completeRemote('worker-a', firstLease!.leaseId, { stale: true })).toBe(false)
      first.close(); second.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reclaims expired leases and preserves idempotency after a coordinator restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-distributed-worker-recovery-'))
    const path = join(directory, 'worker.sqlite')
    try {
      const first = new SqliteDistributedWorkerCoordinator(path)
      first.registerRemote('worker-a')
      const pending = first.submit({ job: 'recover' }, { taskId: 'recover-task', idempotencyKey: 'recover-key', leaseMs: 10 })
      void pending.catch(() => undefined)
      const lease = first.claim('worker-a', 100)
      expect(lease?.task.leaseExpiresAt).toBe(110)

      const second = new SqliteDistributedWorkerCoordinator(path)
      second.registerRemote('worker-b')
      expect(second.recoverExpired(110)).toEqual(['recover-task'])
      const recovered = second.claim('worker-b', 120)
      expect(recovered).toMatchObject({ task: { id: 'recover-task', attempt: 2 }, workerId: 'worker-b' })
      expect(second.failRemote('worker-b', recovered!.leaseId, { code: 'DOWNSTREAM', message: 'failed', retryable: true }, 125)).toBe(true)
      await expect(pending).rejects.toThrow('failed')
      await expect(second.submit({ ignored: true }, { idempotencyKey: 'recover-key' })).rejects.toThrow('failed')
      first.close()
      second.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('runs a local handler while keeping the lease transitions durable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-distributed-worker-handler-'))
    const path = join(directory, 'worker.sqlite')
    try {
      const coordinator = new SqliteDistributedWorkerCoordinator(path)
      coordinator.register('worker-local', async (payload) => ({ handled: payload }))
      await expect(coordinator.submit({ value: 7 }, { taskId: 'handler-task' })).resolves.toEqual({ handled: { value: 7 } })
      expect(coordinator.get('handler-task')).toMatchObject({ state: 'succeeded', attempt: 1 })
      coordinator.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
