import { describe, expect, it } from 'vitest'
import { FactInbox } from '@pulse/runtime'

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
})
