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
