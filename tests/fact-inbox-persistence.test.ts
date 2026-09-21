import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileRuntimePersistenceBackend, PulseRuntime, SqliteRuntimePersistenceBackend } from '@pulse/runtime'

const fact = { type: 'cancel' as const, agentId: 'agent-1', reason: 'test' }

describe('FactInbox durable backend archives', () => {
  it('archives and restores dedupe membership through the File backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-fact-file-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const runtime = new PulseRuntime()
      expect(runtime.factInbox.enqueue(fact, 'fact-1')).toBeDefined()
      runtime.factInbox.drain()

      const snapshot = await runtime.checkpoint(backend)
      expect(snapshot.factInbox?.dedupeLedger?.archivedThrough).toBe(1)
      expect(backend.factInboxDedupeArchive.watermark).toBe(1)

      const restored = await PulseRuntime.restore(backend)
      expect(restored.factInbox.enqueue({ ...fact, reason: 'duplicate' }, 'fact-1')).toBeUndefined()
      expect(restored.factInbox.enqueue(fact, 'fact-2')).toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('archives and restores dedupe membership through a fresh SQLite backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-fact-sqlite-'))
    const filePath = join(directory, 'runtime.db')
    try {
      const backend = new SqliteRuntimePersistenceBackend(filePath)
      const runtime = new PulseRuntime()
      runtime.factInbox.enqueue(fact, 'fact-1')
      runtime.factInbox.drain()
      await runtime.checkpoint(backend)
      expect(backend.factInboxDedupeArchive.watermark).toBe(1)
      await backend.close()

      const restoredBackend = new SqliteRuntimePersistenceBackend(filePath)
      const restored = await PulseRuntime.restore(restoredBackend)
      expect(restored.factInbox.enqueue({ ...fact, reason: 'duplicate' }, 'fact-1')).toBeUndefined()
      expect(restored.factInbox.enqueue(fact, 'fact-2')).toBeDefined()
      await restoredBackend.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not compact queued facts until the inbox has drained them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-fact-queued-'))
    try {
      const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
      const runtime = new PulseRuntime()
      runtime.factInbox.enqueue(fact, 'fact-1')
      const first = await runtime.checkpoint(backend)
      expect(first.factInbox?.dedupeLedger?.archivedThrough).toBe(0)
      expect(backend.factInboxDedupeArchive.watermark).toBe(1)
      runtime.factInbox.drain()
      const second = await runtime.checkpoint(backend)
      expect(second.factInbox?.dedupeLedger?.archivedThrough).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
