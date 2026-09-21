import { describe, expect, it } from 'vitest'
import { FactInbox, PulseRuntime, factInboxDedupeDigest, type FactInboxDedupeArchive, type FactInboxDedupeArchiveBatch } from '@hunterzhu/pulse-runtime'

class MemoryDedupeArchive implements FactInboxDedupeArchive {
  readonly archiveId = 'runtime-memory-dedupe-v1'
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

describe('Runtime FactInbox dedupe integration', () => {
  it('requires an explicit archive and exposes safe watermark compaction', () => {
    const archive = new MemoryDedupeArchive()
    const runtime = new PulseRuntime({ factInboxDedupeArchive: archive })
    runtime.factInbox.enqueue({ type: 'cancel', agentId: 'agent-1', reason: 'test' }, 'fact-1')
    runtime.factInbox.drain()

    const batch = runtime.createFactInboxDedupeArchiveBatch()
    expect(() => runtime.compactFactInboxDedupeThrough(batch)).toThrow('FACT_INBOX_DEDUPE_ARCHIVE_NOT_DURABLE')
    archive.append(batch)
    expect(runtime.compactFactInboxDedupeThrough(batch)).toBe(1)
    expect(runtime.factInbox.enqueue({ type: 'cancel', agentId: 'agent-1', reason: 'duplicate' }, 'fact-1')).toBeUndefined()
  })

  it('fails closed when restoring a compacted inbox without its matching archive', () => {
    const archive = new MemoryDedupeArchive()
    const runtime = new PulseRuntime({ factInboxDedupeArchive: archive })
    runtime.factInbox.enqueue({ type: 'cancel', agentId: 'agent-1', reason: 'test' }, 'fact-1')
    runtime.factInbox.drain()
    const batch = runtime.createFactInboxDedupeArchiveBatch()
    archive.append(batch)
    runtime.compactFactInboxDedupeThrough(batch)
    const snapshot = runtime.exportPersistence()

    expect(() => new PulseRuntime({ persistence: snapshot })).toThrow('FACT_INBOX_DEDUPE_ARCHIVE_REQUIRED')
    expect(() => new PulseRuntime({ persistence: snapshot, factInboxDedupeArchive: archive })).not.toThrow()
    const restored = new PulseRuntime({ persistence: snapshot, factInboxDedupeArchive: archive })
    expect(restored.factInbox.enqueue({ type: 'cancel', agentId: 'agent-1', reason: 'duplicate' }, 'fact-1')).toBeUndefined()
  })

  it('preserves legacy FactInbox snapshots without claiming an archive watermark', () => {
    const legacy = new FactInbox<{ type: string }>()
    legacy.enqueue({ type: 'fact' }, 'legacy-1')
    legacy.drain()
    const runtime = new PulseRuntime({ persistence: {
      schemaVersion: 1,
      state: {
        schemaVersion: 1,
        state: {
          now: 0, agents: [], lanes: [], effects: [], waits: [], results: [], mergeProposals: [], events: [], nextIds: { agent: 1, lane: 1, effect: 1, wait: 1, result: 1, artifact: 1, proposal: 1, event: 1 }, maxTotalLanes: 64, maxQueuedEffects: 64, maxRunning: { llm: 2, tool: 4, agent: 2, none: 'Infinity' },
        },
      },
      mutationLog: { schemaVersion: 1, nextSeq: 1, entries: [] },
      outbox: { schemaVersion: 1, entries: [] },
      factInbox: { ...legacy.snapshot(), schemaVersion: 1 },
    } })
    expect(runtime.factInbox.has('legacy-1')).toBe(true)
    expect(() => runtime.createFactInboxDedupeArchiveBatch()).toThrow('FACT_INBOX_DEDUPE_ARCHIVE_REQUIRED')
  })
})
