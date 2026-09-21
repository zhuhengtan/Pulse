import { createHash } from 'node:crypto'
import type { JsonValue } from './types.js'

export interface FactEnvelope<T extends JsonValue = JsonValue> {
  eventId: string
  receivedSeq: number
  fact: T
}

export interface FactInboxDedupeEntry {
  eventId: string
  receivedSeq: number
}

/**
 * A durable, exact membership view for event ids already archived by a
 * checkpoint. `contains(eventId)` is used on the hot enqueue path, while the
 * sequence argument lets compaction verify that the archive contains the
 * exact ledger entry rather than only an unrelated event with the same shape.
 *
 * Implementations must make the view durable before acknowledging an archive
 * batch to FactInbox. The interface is synchronous on purpose: enqueue() is a
 * synchronous single-writer boundary and cannot safely await a storage query.
 */
export interface FactInboxDedupeArchive {
  readonly archiveId: string
  /** Highest contiguous receivedSeq durably present in this archive. */
  readonly watermark: number
  contains(eventId: string, receivedSeq?: number): boolean
  /** Digest of the exact archived ledger prefix through `watermark`. */
  digestThrough(through: number): string
}

/**
 * A durable archive writer used by checkpoint implementations. Membership
 * reads stay synchronous for the FactInbox hot path; checkpoint writes are
 * explicitly asynchronous and must be durable before compaction is acked.
 */
export interface FactInboxDedupeArchiveWriter extends FactInboxDedupeArchive {
  append(batch: FactInboxDedupeArchiveBatch): Promise<void>
}

export interface FactInboxDedupeArchiveBatch {
  schemaVersion: 1
  archiveId: string
  through: number
  ledgerDigest: string
  entries: FactInboxDedupeEntry[]
}

export interface FactInboxDedupeLedgerSnapshot {
  schemaVersion: 1
  archivedThrough: number
  entries: FactInboxDedupeEntry[]
  /** Event ids restored from the pre-ledger v1 snapshot format. */
  legacyEventIds?: string[]
  archiveId?: string
  archiveDigest?: string
}

const EMPTY_FACT_INBOX_DEDUPE_DIGEST = createHash('sha256').update('pulse.fact-inbox.dedupe.v1').digest('hex')

export function factInboxDedupeDigestFrom(previousDigest: string, entries: readonly FactInboxDedupeEntry[]): string {
  let digest = previousDigest
  for (const entry of entries) digest = createHash('sha256').update(`${digest}\u0000${entry.eventId}\u0000${entry.receivedSeq}`).digest('hex')
  return digest
}

export function factInboxDedupeDigest(entries: readonly FactInboxDedupeEntry[]): string {
  return factInboxDedupeDigestFrom(EMPTY_FACT_INBOX_DEDUPE_DIGEST, entries)
}

export interface FactInboxSnapshot<T extends JsonValue = JsonValue> {
  schemaVersion: 1 | 2
  nextSeq: number
  seen: string[]
  queue: FactEnvelope<T>[]
  dedupeLedger?: FactInboxDedupeLedgerSnapshot
}

export class FactInbox<T extends JsonValue = JsonValue> {
  private readonly queue: FactEnvelope<T>[] = []
  private readonly seen = new Map<string, number | undefined>()
  private nextSeq = 1
  private archivedThrough = 0
  private dedupeArchive: FactInboxDedupeArchive | undefined

  constructor(options: { dedupeArchive?: FactInboxDedupeArchive } = {}) {
    this.dedupeArchive = options.dedupeArchive
  }

  /** Attach a backend-provided archive before the first compaction. */
  attachDedupeArchive(archive: FactInboxDedupeArchive): void {
    if (this.dedupeArchive !== undefined && this.dedupeArchive !== archive) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_MISMATCH')
    if (this.archivedThrough > 0) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_ALREADY_COMPACTED')
    this.dedupeArchive = archive
  }

  enqueue(fact: T, eventId: string): FactEnvelope<T> | undefined {
    if (!eventId || this.seen.has(eventId) || this.dedupeArchive?.contains(eventId)) return undefined
    const envelope: FactEnvelope<T> = { eventId, receivedSeq: this.nextSeq++, fact: structuredClone(fact) }
    this.seen.set(eventId, envelope.receivedSeq)
    this.queue.push(envelope)
    return structuredClone(envelope)
  }

  drain(limit = Number.POSITIVE_INFINITY): FactEnvelope<T>[] {
    if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)) throw new Error('INVALID_FACT_DRAIN_LIMIT')
    return this.queue.splice(0, limit).map((envelope) => structuredClone(envelope))
  }

  get size(): number { return this.queue.length }
  get dedupeWatermark(): number { return this.archivedThrough }
  has(eventId: string): boolean { return this.seen.has(eventId) || Boolean(this.dedupeArchive?.contains(eventId)) }
  snapshot(): FactInboxSnapshot<T> {
    const entries = [...this.seen.entries()].filter((entry): entry is [string, number] => entry[1] !== undefined).map(([eventId, receivedSeq]) => ({ eventId, receivedSeq }))
    const legacyEventIds = [...this.seen.entries()].filter((entry) => entry[1] === undefined).map(([eventId]) => eventId)
    return {
      schemaVersion: 2,
      nextSeq: this.nextSeq,
      seen: [...this.seen.keys()],
      queue: this.queue.map((envelope) => structuredClone(envelope)),
      dedupeLedger: {
        schemaVersion: 1,
        archivedThrough: this.archivedThrough,
        entries,
        ...(legacyEventIds.length === 0 ? {} : { legacyEventIds }),
        ...(this.archivedThrough === 0 || this.dedupeArchive === undefined ? {} : { archiveId: this.dedupeArchive.archiveId, archiveDigest: this.dedupeArchive.digestThrough(this.archivedThrough) }),
      },
    }
  }

  /**
   * Build the exact ledger batch that a durable checkpoint/archive must
   * acknowledge before local dedupe entries can be compacted.
   */
  createDedupeArchiveBatch(through = this.nextSeq - 1): FactInboxDedupeArchiveBatch {
    if (!Number.isInteger(through) || through < this.archivedThrough || through >= this.nextSeq) throw new Error('INVALID_FACT_INBOX_DEDUPE_WATERMARK')
    const bySeq = new Map<number, FactInboxDedupeEntry>()
    for (const [eventId, receivedSeq] of this.seen) {
      if (receivedSeq !== undefined && receivedSeq > this.archivedThrough && receivedSeq <= through) bySeq.set(receivedSeq, { eventId, receivedSeq })
    }
    const entries: FactInboxDedupeEntry[] = []
    for (let receivedSeq = this.archivedThrough + 1; receivedSeq <= through; receivedSeq++) {
      const entry = bySeq.get(receivedSeq)
      if (!entry) throw new Error('FACT_INBOX_DEDUPE_LEDGER_INCOMPLETE')
      entries.push({ ...entry })
    }
    if (!this.dedupeArchive || this.dedupeArchive.watermark < this.archivedThrough) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_REQUIRED')
    return { schemaVersion: 1, archiveId: this.dedupeArchive.archiveId, through, ledgerDigest: factInboxDedupeDigestFrom(this.dedupeArchive.digestThrough(this.archivedThrough), entries), entries }
  }

  /**
   * Acknowledge a batch only after its exact entries are durably archived.
   * This is the sole operation that advances the watermark or removes local
   * dedupe entries; clear() intentionally does not affect deduplication.
   */
  compactDedupeThrough(batch: FactInboxDedupeArchiveBatch): number {
    if (!batch || batch.schemaVersion !== 1 || !Number.isInteger(batch.through) || batch.through < 1 || batch.archiveId !== this.dedupeArchive?.archiveId) throw new Error('INVALID_FACT_INBOX_DEDUPE_ARCHIVE_BATCH')
    if (batch.through <= this.archivedThrough) return 0
    const expected = this.createDedupeArchiveBatch(batch.through)
    if (expected.ledgerDigest !== batch.ledgerDigest || expected.entries.length !== batch.entries.length || expected.entries.some((entry, index) => entry.eventId !== batch.entries[index]?.eventId || entry.receivedSeq !== batch.entries[index]?.receivedSeq)) throw new Error('INVALID_FACT_INBOX_DEDUPE_ARCHIVE_BATCH')
    if (this.queue.some((envelope) => envelope.receivedSeq <= batch.through)) throw new Error('FACT_INBOX_DEDUPE_PENDING_FACTS')
    if (this.dedupeArchive!.watermark < batch.through) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_NOT_DURABLE')
    for (const entry of expected.entries) if (!this.dedupeArchive!.contains(entry.eventId, entry.receivedSeq)) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_NOT_DURABLE')
    if (this.dedupeArchive!.digestThrough(batch.through) !== batch.ledgerDigest) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_NOT_DURABLE')
    for (const entry of expected.entries) this.seen.delete(entry.eventId)
    this.archivedThrough = batch.through
    return expected.entries.length
  }

  restore(snapshot: FactInboxSnapshot<T> | JsonValue): void {
    const restored = FactInbox.fromSnapshot<T>(snapshot, this.dedupeArchive === undefined ? {} : { dedupeArchive: this.dedupeArchive })
    this.queue.splice(0, this.queue.length, ...restored.queue.map((envelope) => structuredClone(envelope)))
    this.seen.clear()
    for (const [eventId, receivedSeq] of restored.seen) this.seen.set(eventId, receivedSeq)
    this.nextSeq = restored.nextSeq
    this.archivedThrough = restored.archivedThrough
  }

  static fromSnapshot<T extends JsonValue = JsonValue>(snapshot: FactInboxSnapshot<T> | JsonValue, options: { dedupeArchive?: FactInboxDedupeArchive } = {}): FactInbox<T> {
    const value = snapshot as FactInboxSnapshot<T>
    if (!value || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !Number.isInteger(value.nextSeq) || value.nextSeq < 1 || !Array.isArray(value.seen) || value.seen.some((eventId) => typeof eventId !== 'string' || eventId.length === 0) || !Array.isArray(value.queue)) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
    if (new Set(value.seen).size !== value.seen.length) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
    const ledger = value.dedupeLedger
    if (ledger !== undefined && (ledger.schemaVersion !== 1 || !Number.isInteger(ledger.archivedThrough) || ledger.archivedThrough < 0 || ledger.archivedThrough >= value.nextSeq || !Array.isArray(ledger.entries) || !Array.isArray(ledger.legacyEventIds ?? []) || ledger.entries.some((entry) => !entry || typeof entry.eventId !== 'string' || entry.eventId.length === 0 || !Number.isInteger(entry.receivedSeq) || entry.receivedSeq < 1 || entry.receivedSeq <= ledger.archivedThrough || entry.receivedSeq >= value.nextSeq) || ledger.legacyEventIds?.some((eventId) => typeof eventId !== 'string' || eventId.length === 0) || (ledger.archivedThrough > 0 && ((ledger.legacyEventIds ?? []).length > 0 || !ledger.archiveId || !ledger.archiveDigest || !/^[a-f0-9]{64}$/.test(ledger.archiveDigest))) || (ledger.archivedThrough === 0 && ledger.archiveDigest !== undefined) || new Set(ledger.entries.map((entry) => entry.eventId)).size !== ledger.entries.length || new Set(ledger.entries.map((entry) => entry.receivedSeq)).size !== ledger.entries.length || new Set(ledger.legacyEventIds ?? []).size !== (ledger.legacyEventIds ?? []).length || ledger.entries.some((entry) => (ledger.legacyEventIds ?? []).includes(entry.eventId)))) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
    if (ledger?.archivedThrough && (!options.dedupeArchive || ledger.archiveId !== options.dedupeArchive.archiveId || options.dedupeArchive.watermark < ledger.archivedThrough || options.dedupeArchive.digestThrough(ledger.archivedThrough) !== ledger.archiveDigest)) throw new Error('FACT_INBOX_DEDUPE_ARCHIVE_REQUIRED')
    const inbox = new FactInbox<T>(options)
    const seen = new Map<string, number | undefined>()
    if (ledger) {
      for (const entry of ledger.entries) seen.set(entry.eventId, entry.receivedSeq)
      for (const eventId of ledger.legacyEventIds ?? []) seen.set(eventId, undefined)
      if (new Set(seen.keys()).size !== value.seen.length || value.seen.some((eventId) => !seen.has(eventId))) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      inbox.archivedThrough = ledger.archivedThrough
    } else {
      const queued = new Map(value.queue.map((envelope) => [envelope.eventId, envelope.receivedSeq]))
      for (const eventId of value.seen) seen.set(eventId, queued.get(eventId))
    }
    let maxReceivedSeq = 0
    for (const envelope of value.queue) {
      if (!envelope || typeof envelope.eventId !== 'string' || (!seen.has(envelope.eventId) && !options.dedupeArchive?.contains(envelope.eventId, envelope.receivedSeq)) || !Number.isInteger(envelope.receivedSeq) || envelope.receivedSeq < 1 || envelope.fact === undefined) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      if (inbox.queue.some((candidate) => candidate.eventId === envelope.eventId || candidate.receivedSeq === envelope.receivedSeq)) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      if (envelope.receivedSeq <= maxReceivedSeq) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      const knownSeq = seen.get(envelope.eventId)
      if (knownSeq !== undefined && knownSeq !== envelope.receivedSeq) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      if ([...seen.entries()].some(([eventId, receivedSeq]) => eventId !== envelope.eventId && receivedSeq === envelope.receivedSeq)) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      inbox.queue.push({ eventId: envelope.eventId, receivedSeq: envelope.receivedSeq, fact: structuredClone(envelope.fact) })
      maxReceivedSeq = Math.max(maxReceivedSeq, envelope.receivedSeq)
    }
    if (value.nextSeq <= maxReceivedSeq) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
    for (const [eventId, receivedSeq] of seen) inbox.seen.set(eventId, receivedSeq)
    inbox.nextSeq = value.nextSeq
    return inbox
  }
  clear(): void { this.queue.length = 0 }
}

export interface ObservationEnvelope {
  seq: number
  agentId: string
  laneId?: string
  type: 'progress' | 'chunk' | 'trace' | 'warning' | 'diagnostic'
  data: JsonValue
  timestamp: number
}

export class ObservationInbox {
  private readonly queue: ObservationEnvelope[] = []
  private readonly droppedThroughByAgent = new Map<string, number>()
  private bytes = 0
  private nextSeq = 1
  constructor(readonly maxEntries = 4096, readonly maxBytes = 1_000_000) {}
  enqueue(input: Omit<ObservationEnvelope, 'seq'>): ObservationEnvelope {
    const event = structuredClone({ ...input, seq: this.nextSeq++ })
    this.queue.push(event)
    this.bytes += this.eventBytes(event)
    while (this.queue.length > this.maxEntries || this.bytes > this.maxBytes) {
      const dropped = this.queue.shift()!
      this.bytes -= this.eventBytes(dropped)
      this.droppedThroughByAgent.set(dropped.agentId, Math.max(this.droppedThroughByAgent.get(dropped.agentId) ?? 0, dropped.seq))
    }
    return structuredClone(event)
  }
  drain(agentId?: string): ObservationEnvelope[] {
    if (agentId === undefined) {
      const selected = this.queue.splice(0)
      this.bytes = 0
      return selected.map((event) => structuredClone(event))
    }
    const selected = this.queue.filter((event) => event.agentId === agentId)
    if (selected.length) {
      const ids = new Set(selected.map((event) => event.seq))
      for (let index = this.queue.length - 1; index >= 0; index--) if (ids.has(this.queue[index]!.seq)) { this.bytes -= this.eventBytes(this.queue[index]!); this.queue.splice(index, 1) }
    }
    return selected.map((event) => structuredClone(event))
  }
  get size(): number { return this.queue.length }
  get sizeBytes(): number { return this.bytes }
  droppedThrough(agentId: string): number { return this.droppedThroughByAgent.get(agentId) ?? 0 }
  snapshot(): ObservationEnvelope[] { return this.queue.map((event) => structuredClone(event)) }
  private eventBytes(event: ObservationEnvelope): number { return Buffer.byteLength(JSON.stringify(event), 'utf8') }
}
