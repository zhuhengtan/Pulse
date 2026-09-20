import type { JsonValue } from './types.js'

export interface FactEnvelope<T extends JsonValue = JsonValue> {
  eventId: string
  receivedSeq: number
  fact: T
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
