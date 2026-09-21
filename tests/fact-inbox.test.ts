import { describe, expect, it } from 'vitest'
import { FactInbox, factInboxDedupeDigest, type FactInboxDedupeArchive, type FactInboxDedupeArchiveBatch } from '@hunterzhu/pulse-runtime'

class MemoryDedupeArchive implements FactInboxDedupeArchive {
  readonly archiveId = 'memory-dedupe-v1'
  watermark = 0
  private readonly entries = new Map<string, number>()

  append(batch: FactInboxDedupeArchiveBatch): void {
    for (const entry of batch.entries) this.entries.set(entry.eventId, entry.receivedSeq)
    this.watermark = Math.max(this.watermark, batch.through)
  }

  contains(eventId: string, receivedSeq?: number): boolean {
    const archived = this.entries.get(eventId)
    return archived !== undefined && (receivedSeq === undefined || archived === receivedSeq)
  }

  digestThrough(through: number): string {
    return factInboxDedupeDigest([...this.entries.entries()].map(([eventId, receivedSeq]) => ({ eventId, receivedSeq })).filter((entry) => entry.receivedSeq <= through).sort((left, right) => left.receivedSeq - right.receivedSeq))
  }
}

describe('FactInbox', () => {
  it('deduplicates by event id while preserving FIFO sequence', () => {
    const inbox = new FactInbox<{ kind: string; value: number }>()
    expect(inbox.enqueue({ kind: 'complete', value: 1 }, 'event-1')?.receivedSeq).toBe(1)
    expect(inbox.enqueue({ kind: 'complete', value: 1 }, 'event-1')).toBeUndefined()
    inbox.enqueue({ kind: 'cancel', value: 2 }, 'event-2')
    expect(inbox.drain(1)).toEqual([{ eventId: 'event-1', receivedSeq: 1, fact: { kind: 'complete', value: 1 } }])
    expect(inbox.drain()).toEqual([{ eventId: 'event-2', receivedSeq: 2, fact: { kind: 'cancel', value: 2 } }])
  })

  it('does not expose mutable caller-owned facts and validates drain bounds', () => {
    const inbox = new FactInbox<{ payload: { ok: boolean } }>()
    const fact = { payload: { ok: true } }
    inbox.enqueue(fact, 'event-1')
    fact.payload.ok = false
    expect(inbox.drain()[0]?.fact.payload.ok).toBe(true)
    expect(() => inbox.drain(-1)).toThrow('INVALID_FACT_DRAIN_LIMIT')
  })

  it('round-trips queued facts and deduplication history', () => {
    const inbox = new FactInbox<{ kind: string; value: number }>()
    inbox.enqueue({ kind: 'complete', value: 1 }, 'event-1')
    inbox.enqueue({ kind: 'cancel', value: 2 }, 'event-2')
    const restored = FactInbox.fromSnapshot(JSON.parse(JSON.stringify(inbox.snapshot())))
    expect(restored.drain(1)[0]).toMatchObject({ eventId: 'event-1', receivedSeq: 1 })
    expect(restored.enqueue({ kind: 'duplicate', value: 3 }, 'event-1')).toBeUndefined()
    expect(restored.drain()[0]).toMatchObject({ eventId: 'event-2', receivedSeq: 2 })
  })

  it('rejects ambiguous or reordered snapshots instead of normalizing facts', () => {
    const inbox = new FactInbox<{ value: number }>()
    inbox.enqueue({ value: 1 }, 'event-1')
    inbox.enqueue({ value: 2 }, 'event-2')
    const snapshot = inbox.snapshot()
    expect(() => FactInbox.fromSnapshot({ ...snapshot, seen: [...snapshot.seen, 'event-1'] })).toThrow('INVALID_FACT_INBOX_SNAPSHOT')
    expect(() => FactInbox.fromSnapshot({ ...snapshot, queue: [...snapshot.queue].reverse() })).toThrow('INVALID_FACT_INBOX_SNAPSHOT')
  })

  it('only compacts an acknowledged contiguous archive batch and keeps exactly-once after pruning', () => {
    const archive = new MemoryDedupeArchive()
    const inbox = new FactInbox<{ value: number }>({ dedupeArchive: archive })
    inbox.enqueue({ value: 1 }, 'event-1')
    inbox.enqueue({ value: 2 }, 'event-2')
    inbox.drain()

    const batch = inbox.createDedupeArchiveBatch()
    expect(() => inbox.compactDedupeThrough(batch)).toThrow('FACT_INBOX_DEDUPE_ARCHIVE_NOT_DURABLE')
    expect(inbox.has('event-1')).toBe(true)

    archive.append(batch)
    expect(inbox.compactDedupeThrough(batch)).toBe(2)
    expect(inbox.dedupeWatermark).toBe(2)
    expect(inbox.snapshot().seen).toEqual([])
    expect(inbox.enqueue({ value: 99 }, 'event-1')).toBeUndefined()

    const restored = FactInbox.fromSnapshot(JSON.parse(JSON.stringify(inbox.snapshot())), { dedupeArchive: archive })
    expect(restored.dedupeWatermark).toBe(2)
    expect(restored.enqueue({ value: 100 }, 'event-2')).toBeUndefined()
    expect(restored.enqueue({ value: 3 }, 'event-3')?.receivedSeq).toBe(3)
    restored.drain()
    const secondBatch = restored.createDedupeArchiveBatch()
    archive.append(secondBatch)
    expect(restored.compactDedupeThrough(secondBatch)).toBe(1)
    expect(restored.dedupeWatermark).toBe(3)
    expect(restored.enqueue({ value: 101 }, 'event-3')).toBeUndefined()
  })

  it('does not compact queued facts and does not restore a compacted snapshot without its archive', () => {
    const archive = new MemoryDedupeArchive()
    const inbox = new FactInbox<{ value: number }>({ dedupeArchive: archive })
    inbox.enqueue({ value: 1 }, 'event-1')
    const batch = inbox.createDedupeArchiveBatch()
    archive.append(batch)
    expect(() => inbox.compactDedupeThrough(batch)).toThrow('FACT_INBOX_DEDUPE_PENDING_FACTS')
    expect(inbox.has('event-1')).toBe(true)

    inbox.drain()
    expect(inbox.compactDedupeThrough(batch)).toBe(1)
    const compacted = JSON.parse(JSON.stringify(inbox.snapshot()))
    expect(() => FactInbox.fromSnapshot(compacted)).toThrow('FACT_INBOX_DEDUPE_ARCHIVE_REQUIRED')
    const insufficientArchive = new MemoryDedupeArchive()
    insufficientArchive.watermark = 0
    expect(() => FactInbox.fromSnapshot(compacted, { dedupeArchive: insufficientArchive })).toThrow('FACT_INBOX_DEDUPE_ARCHIVE_REQUIRED')
  })

  it('refuses forged, skipped, or out-of-date archive acknowledgements', () => {
    const archive = new MemoryDedupeArchive()
    const inbox = new FactInbox<{ value: number }>({ dedupeArchive: archive })
    inbox.enqueue({ value: 1 }, 'event-1')
    inbox.drain()
    const batch = inbox.createDedupeArchiveBatch()
    expect(() => inbox.compactDedupeThrough({ ...batch, entries: [{ eventId: 'other', receivedSeq: 1 }] })).toThrow('INVALID_FACT_INBOX_DEDUPE_ARCHIVE_BATCH')
    expect(() => inbox.compactDedupeThrough({ ...batch, through: 2 })).toThrow('INVALID_FACT_INBOX_DEDUPE_WATERMARK')
    archive.append(batch)
    expect(inbox.compactDedupeThrough(batch)).toBe(1)
    expect(inbox.compactDedupeThrough(batch)).toBe(0)
  })
})
