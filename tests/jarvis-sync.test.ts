import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JarvisSyncQueue } from '../packages/server/src/jarvis/sync.js'
import type { JarvisClient } from '../packages/server/src/jarvis/client.js'

const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Jarvis durable sync queue', () => {
  it('preserves result event types through an offline restart, including legacy queued events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-jarvis-event-type-'))
    roots.push(root)
    let online = false
    const delivered: string[] = []
    const client = {
      redactText: (text: string) => text,
      recordEvent: async (_session: string, type: string) => {
        if (!online) throw new Error('offline')
        delivered.push(type)
        return { id: `event-${delivered.length}` }
      },
    } as unknown as JarvisClient
    const queue = new JarvisSyncQueue(root, client)
    await queue.init()
    await queue.submitEvent({ requestId: 'result-new', sessionId: 's1', type: 'result', content: 'Assistant result' })
    await queue.flush()
    const path = join(root, 'h5', 'jarvis-sync.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.items.push({ ...saved.items[0], requestId: 'result-legacy', eventType: undefined, type: 'result' })
    await writeFile(path, JSON.stringify(saved))
    online = true
    await new JarvisSyncQueue(root, client).flush()
    expect(delivered).toEqual(['result', 'result'])
  })

  it.each([false, true])('never evicts pending writes at capacity (completed receipt available: %s)', async (completed) => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-jarvis-capacity-'))
    roots.push(root)
    await mkdir(join(root, 'h5'), { recursive: true })
    const path = join(root, 'h5', 'jarvis-sync.json')
    const items = Array.from({ length: 800 }, (_, i) => ({ requestId: `pending-${i}`, sessionId: 's1', kind: 'event', content: 'unsent', status: completed && i === 799 ? 'synced' : 'pending_sync', createdAt: '2026-10-12', updatedAt: '2026-10-12' }))
    await writeFile(path, JSON.stringify({ schemaVersion: 1, items }))
    const client = { redactText: (text: string) => text, recordEvent: async () => { throw new Error('offline') } } as unknown as JarvisClient
    const queue = new JarvisSyncQueue(root, client)
    await queue.init()
    const submit = () => queue.submitEvent({ requestId: 'new', sessionId: 's1', type: 'observation', content: 'new' })
    if (completed) {
      await expect(submit()).resolves.toMatchObject({ status: 'pending_sync' })
      await queue.flush()
    } else {
      await expect(submit()).rejects.toThrow('JARVIS_SYNC_QUEUE_FULL')
      expect(await queue.status('new')).toBeUndefined()
    }
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.items).toHaveLength(800)
    expect(saved.items[0].requestId).toBe('pending-0')
    expect(saved.items.some((item: { requestId: string }) => item.requestId === 'new')).toBe(completed)
    // An idempotent replay still works even when no more records can be accepted.
    await expect(queue.submitEvent({ requestId: 'pending-0', sessionId: 's1', type: 'observation', content: 'unsent' })).resolves.toMatchObject({ requestId: 'pending-0' })
    await queue.flush()
  })

  it('persists offline writes, retries idempotently, and reports the actual candidate review state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-jarvis-sync-'))
    roots.push(root)
    let eventAttempts = 0
    const eventKeys: string[] = []
    const candidateKeys: string[] = []
    const client = {
      redactText: (text: string) => text.replaceAll('secret-token', '[REDACTED]'),
      recordEvent: async (_session: string, _type: string, _content: string, key?: string) => {
        eventKeys.push(key ?? '')
        eventAttempts++
        if (eventAttempts === 1) throw new Error('Jarvis temporarily unavailable')
        return { id: 'event-1' }
      },
      recordCandidate: async (_session: string, _candidate: unknown, key?: string) => { candidateKeys.push(key ?? ''); return { id: 'memory-1', status: 'candidate' } },
      getMemory: async () => undefined,
      listCandidates: async () => [{ id: 'memory-1', status: 'active', title: 'Pulse preference', scope: 'global' }],
    } as unknown as JarvisClient
    const queue = new JarvisSyncQueue(root, client)
    await queue.init()
    const submitted = await queue.submitCandidate({ requestId: 'pulse:jarvis:remember:effect-1', sessionId: 'session-1', scope: 'global', candidate: { scope: 'global', kind: 'preference', title: 'Reply language', content: 'Chinese' }, source: 'User requested Chinese replies.' })
    expect(submitted.status).toBe('pending_sync')
    await queue.flush()
    expect((await queue.status('pulse:jarvis:remember:effect-1'))?.status).toBe('pending_sync')

    await queue.flush()
    expect(eventKeys).toEqual(['pulse:jarvis:remember:effect-1:source', 'pulse:jarvis:remember:effect-1:source'])
    expect(candidateKeys).toEqual(['pulse:jarvis:remember:effect-1:candidate'])
    expect((await queue.status('memory-1'))).toMatchObject({ status: 'active', jarvisStatus: 'active', id: 'memory-1' })
  })
})
