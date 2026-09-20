import type { JsonValue } from './types.js'

export interface FactEnvelope<T extends JsonValue = JsonValue> {
  eventId: string
  receivedSeq: number
  fact: T
}

export interface FactInboxSnapshot<T extends JsonValue = JsonValue> {
  schemaVersion: 1
  nextSeq: number
  seen: string[]
  queue: FactEnvelope<T>[]
}

export class FactInbox<T extends JsonValue = JsonValue> {
  private readonly queue: FactEnvelope<T>[] = []
  private readonly seen = new Set<string>()
  private nextSeq = 1

  enqueue(fact: T, eventId: string): FactEnvelope<T> | undefined {
    if (!eventId || this.seen.has(eventId)) return undefined
    const envelope: FactEnvelope<T> = { eventId, receivedSeq: this.nextSeq++, fact: structuredClone(fact) }
    this.seen.add(eventId)
    this.queue.push(envelope)
    return structuredClone(envelope)
  }

  drain(limit = Number.POSITIVE_INFINITY): FactEnvelope<T>[] {
    if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)) throw new Error('INVALID_FACT_DRAIN_LIMIT')
    return this.queue.splice(0, limit).map((envelope) => structuredClone(envelope))
  }

  get size(): number { return this.queue.length }
  has(eventId: string): boolean { return this.seen.has(eventId) }
  snapshot(): FactInboxSnapshot<T> { return { schemaVersion: 1, nextSeq: this.nextSeq, seen: [...this.seen], queue: this.queue.map((envelope) => structuredClone(envelope)) } }
  static fromSnapshot<T extends JsonValue = JsonValue>(snapshot: FactInboxSnapshot<T> | JsonValue): FactInbox<T> {
    const value = snapshot as FactInboxSnapshot<T>
    if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.nextSeq) || value.nextSeq < 1 || !Array.isArray(value.seen) || value.seen.some((eventId) => typeof eventId !== 'string' || eventId.length === 0) || !Array.isArray(value.queue)) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
    const inbox = new FactInbox<T>()
    const seen = new Set(value.seen)
    let maxReceivedSeq = 0
    for (const envelope of value.queue) {
      if (!envelope || typeof envelope.eventId !== 'string' || !seen.has(envelope.eventId) || !Number.isInteger(envelope.receivedSeq) || envelope.receivedSeq < 1 || envelope.fact === undefined) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      if (inbox.queue.some((candidate) => candidate.eventId === envelope.eventId || candidate.receivedSeq === envelope.receivedSeq)) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
      inbox.queue.push({ eventId: envelope.eventId, receivedSeq: envelope.receivedSeq, fact: structuredClone(envelope.fact) })
      maxReceivedSeq = Math.max(maxReceivedSeq, envelope.receivedSeq)
    }
    if (value.nextSeq <= maxReceivedSeq) throw new Error('INVALID_FACT_INBOX_SNAPSHOT')
    inbox.seen.clear()
    for (const eventId of seen) inbox.seen.add(eventId)
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
  private nextSeq = 1
  constructor(readonly maxEntries = 4096) {}
  enqueue(input: Omit<ObservationEnvelope, 'seq'>): ObservationEnvelope {
    const event = { ...input, seq: this.nextSeq++ }
    this.queue.push(structuredClone(event))
    while (this.queue.length > this.maxEntries) this.queue.shift()
    return structuredClone(event)
  }
  drain(agentId?: string): ObservationEnvelope[] {
    if (agentId === undefined) return this.queue.splice(0).map((event) => structuredClone(event))
    const selected = this.queue.filter((event) => event.agentId === agentId)
    if (selected.length) { const ids = new Set(selected.map((event) => event.seq)); for (let index = this.queue.length - 1; index >= 0; index--) if (ids.has(this.queue[index]!.seq)) this.queue.splice(index, 1) }
    return selected.map((event) => structuredClone(event))
  }
  get size(): number { return this.queue.length }
  snapshot(): ObservationEnvelope[] { return this.queue.map((event) => structuredClone(event)) }
}
