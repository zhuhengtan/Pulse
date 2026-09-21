import type { EffectRecord, JsonValue, RuntimeState } from '../core/types.js'

export interface OutboxEntry {
  id: string
  effectId: string
  attemptId: string
  state: 'pending' | 'claimed'
  createdAt: number
  claimCount: number
}

export interface OutboxSnapshot {
  schemaVersion: 1
  entries: OutboxEntry[]
}

export class EffectOutbox {
  private readonly entries = new Map<string, OutboxEntry>()

  enqueue(effect: Pick<EffectRecord, 'id' | 'attemptId'>, createdAt = 0): OutboxEntry {
    const id = `${effect.id}:${effect.attemptId}`
    const existing = this.entries.get(id)
    if (existing) return { ...existing }
    const entry: OutboxEntry = { id, effectId: effect.id, attemptId: effect.attemptId, state: 'pending', createdAt, claimCount: 0 }
    this.entries.set(id, entry)
    return { ...entry }
  }

  claim(id: string): OutboxEntry | undefined {
    const entry = this.entries.get(id)
    if (!entry || entry.state === 'claimed') return undefined
    entry.state = 'claimed'
    entry.claimCount++
    return { ...entry }
  }

  requeue(id: string): void { const entry = this.entries.get(id); if (entry) entry.state = 'pending' }
  ack(id: string): boolean { return this.entries.delete(id) }
  get(id: string): OutboxEntry | undefined { const entry = this.entries.get(id); return entry === undefined ? undefined : { ...entry } }
  get size(): number { return this.entries.size }
  pending(): OutboxEntry[] { return [...this.entries.values()].filter((entry) => entry.state === 'pending').map((entry) => ({ ...entry })) }
  claimed(): OutboxEntry[] { return [...this.entries.values()].filter((entry) => entry.state === 'claimed').map((entry) => ({ ...entry })) }
  snapshot(): OutboxSnapshot { return { schemaVersion: 1, entries: [...this.entries.values()].map((entry) => ({ ...entry })) } }

  static fromSnapshot(snapshot: OutboxSnapshot | JsonValue): EffectOutbox {
    const value = snapshot as OutboxSnapshot
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('INVALID_OUTBOX_SNAPSHOT')
    const outbox = new EffectOutbox()
    for (const entry of value.entries) {
      if (!entry || typeof entry.id !== 'string' || entry.id.length === 0 || typeof entry.effectId !== 'string' || entry.effectId.length === 0 || typeof entry.attemptId !== 'string' || entry.attemptId.length === 0 || entry.id !== `${entry.effectId}:${entry.attemptId}` || !['pending', 'claimed'].includes(entry.state) || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) || !Number.isInteger(entry.claimCount) || entry.claimCount < 0 || (entry.state === 'claimed' && entry.claimCount < 1)) throw new Error('INVALID_OUTBOX_SNAPSHOT')
      if (outbox.entries.has(entry.id)) throw new Error('INVALID_OUTBOX_SNAPSHOT')
      outbox.entries.set(entry.id, { ...entry })
    }
    return outbox
  }

  recover(state: RuntimeState): { requeued: string[]; unknown: string[] } {
    const requeued: string[] = []
    const unknown: string[] = []
    for (const entry of this.entries.values()) {
      const effect = state.effects.get(entry.effectId)
      if (!effect || effect.attemptId !== entry.attemptId || effect.outcome) { this.entries.delete(entry.id); unknown.push(entry.id); continue }
      if (entry.state === 'claimed') { entry.state = 'pending'; requeued.push(entry.id) }
    }
    return { requeued, unknown }
  }
}
