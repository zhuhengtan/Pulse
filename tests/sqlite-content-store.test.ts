import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { SqliteRuntimeContentStore, SqliteRuntimeEventArchive } from '@hunterzhu/pulse-runtime'
import type { RuntimeEvent } from '@hunterzhu/pulse-runtime'

describe('SQLite runtime content and event stores', () => {
  it('shares result/snapshot bodies between instances with idempotent conflict checks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-content-'))
    try {
      const path = join(directory, 'content.db')
      const resultWriter = new SqliteRuntimeContentStore(path, 'result')
      const resultReader = new SqliteRuntimeContentStore(path, 'result')
      const snapshot = new SqliteRuntimeContentStore(path, 'snapshot')
      await resultWriter.save('result-1', { answer: 42 })
      await resultReader.save('result-1', { answer: 42 })
      expect(await resultReader.load('result-1')).toEqual({ answer: 42 })
      await expect(resultReader.save('result-1', { answer: 43 })).rejects.toThrow('RUNTIME_CONTENT_CONFLICT')
      await snapshot.save('lane:lane-1:1', { state: { ready: true } })
      expect(await snapshot.load('lane:lane-1:1')).toEqual({ state: { ready: true } })
      await resultWriter.close(); await resultReader.close(); await snapshot.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('appends an event archive atomically and reads ordered ranges across instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-sqlite-events-'))
    try {
      const path = join(directory, 'events.db')
      const first = new SqliteRuntimeEventArchive(path)
      const second = new SqliteRuntimeEventArchive(path)
      const event = (seq: number, type: string): RuntimeEvent => ({ id: `event-${seq}`, schemaVersion: 1, seq, type, timestamp: seq, sessionId: 'session-1', payload: null })
      await Promise.all([first.append([event(1, 'lane.created'), event(2, 'effect.settled')]), second.append([event(2, 'effect.settled'), event(3, 'agent.cancelled')])])
      await first.append([event(1, 'lane.created')])
      expect(await second.read(2, 3)).toEqual([event(2, 'effect.settled'), event(3, 'agent.cancelled')])
      await expect(second.append([event(2, 'effect.failed')])).rejects.toThrow('RUNTIME_EVENT_ARCHIVE_CONFLICT')
      await first.close(); await second.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
