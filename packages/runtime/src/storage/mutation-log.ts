import { createHash } from 'node:crypto'
import type { JsonValue, RuntimeState } from '../core/types.js'
import type { Mutation } from '../core/mutations.js'
import { apply } from '../core/mutations.js'

export interface MutationLogEntry {
  seq: number
  transactionId: string
  committedAt: number
  checksum: string
  mutations: Mutation[]
}

export interface MutationLogSnapshot {
  schemaVersion: 1
  baseSeq?: number
  nextSeq: number
  entries: Array<{ seq: number; transactionId: string; committedAt: number; checksum: string; mutations: JsonValue }>
}

type EncodedValue = JsonValue

function encode(value: unknown): EncodedValue {
  if (value === undefined) return { $pulseType: 'undefined' }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(encode)
  if (value instanceof Map) return { $pulseType: 'map', entries: [...value.entries()].map(([key, item]) => [encode(key), encode(item)]) }
  if (value instanceof Set) return { $pulseType: 'set', values: [...value.values()].map(encode) }
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = encode(item)
    return result
  }
  throw new Error('UNSERIALIZABLE_MUTATION_VALUE')
}

function decode(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(decode)
  if (!value || typeof value !== 'object') throw new Error('INVALID_MUTATION_LOG')
  const object = value as Record<string, unknown>
  if (object.$pulseType === 'undefined') return undefined
  if (object.$pulseType === 'map') return new Map((object.entries as unknown[]).map((entry) => { const pair = entry as unknown[]; return [decode(pair[0]), decode(pair[1])] }))
  if (object.$pulseType === 'set') return new Set((object.values as unknown[]).map(decode))
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decode(item)]))
}

function checksum(seq: number, transactionId: string, mutations: Mutation[]): string {
  return createHash('sha256').update(JSON.stringify(encode({ seq, transactionId, mutations }))).digest('hex')
}

function cloneMutations(mutations: Mutation[]): Mutation[] { return structuredClone(mutations) }

export class MutationLog {
  private readonly log: MutationLogEntry[]
  private nextSequence: number
  private baseSequence: number

  constructor(entries: MutationLogEntry[] = [], baseSequence = 0) {
    this.log = entries.map((entry) => ({ ...entry, mutations: cloneMutations(entry.mutations) }))
    this.baseSequence = baseSequence
    this.nextSequence = this.log.length ? Math.max(...this.log.map((entry) => entry.seq)) + 1 : baseSequence + 1
    this.validate()
  }

  get entries(): MutationLogEntry[] { return this.log.map((entry) => ({ ...entry, mutations: cloneMutations(entry.mutations) })) }
  get size(): number { return this.log.length }
  get watermark(): number { return this.baseSequence }
  get lastSequence(): number { return this.log.at(-1)?.seq ?? this.baseSequence }

  findTransaction(transactionId: string): MutationLogEntry | undefined {
    const entry = this.log.find((candidate) => candidate.transactionId === transactionId)
    return entry === undefined ? undefined : { ...entry, mutations: cloneMutations(entry.mutations) }
  }

  append(transactionId: string, mutations: Mutation[], committedAt = 0): MutationLogEntry {
    if (!transactionId) throw new Error('INVALID_TRANSACTION_ID')
    const existing = this.findTransaction(transactionId)
    if (existing) return existing
    const entry: MutationLogEntry = { seq: this.nextSequence++, transactionId, committedAt, mutations: cloneMutations(mutations), checksum: checksum(this.nextSequence - 1, transactionId, mutations) }
    this.log.push(entry)
    return { ...entry, mutations: cloneMutations(entry.mutations) }
  }

  snapshot(): MutationLogSnapshot {
    return { schemaVersion: 1, ...(this.baseSequence === 0 ? {} : { baseSeq: this.baseSequence }), nextSeq: this.nextSequence, entries: this.log.map((entry) => ({ seq: entry.seq, transactionId: entry.transactionId, committedAt: entry.committedAt, checksum: entry.checksum, mutations: encode(entry.mutations) })) }
  }

  truncateThrough(seq: number): void {
    if (!Number.isInteger(seq) || seq < this.baseSequence || seq > this.lastSequence) throw new Error('INVALID_CHECKPOINT_WATERMARK')
    while (this.log[0] && this.log[0].seq <= seq) this.log.shift()
    this.baseSequence = seq
    this.nextSequence = this.log[0]?.seq ?? seq + 1
    this.validate()
  }

  static fromSnapshot(snapshot: MutationLogSnapshot | JsonValue): MutationLog {
    const value = snapshot as MutationLogSnapshot
    if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.nextSeq) || !Array.isArray(value.entries) || (value.baseSeq !== undefined && (!Number.isInteger(value.baseSeq) || value.baseSeq < 0))) throw new Error('INVALID_MUTATION_LOG')
    const entries = value.entries.map((entry) => {
      if (!entry || !Number.isInteger(entry.seq) || typeof entry.transactionId !== 'string' || typeof entry.committedAt !== 'number' || typeof entry.checksum !== 'string') throw new Error('INVALID_MUTATION_LOG')
      const mutations = decode(entry.mutations)
      if (!Array.isArray(mutations)) throw new Error('INVALID_MUTATION_LOG')
      return { seq: entry.seq, transactionId: entry.transactionId, committedAt: entry.committedAt, checksum: entry.checksum, mutations: mutations as Mutation[] }
    })
    const log = new MutationLog(entries, value.baseSeq ?? 0)
    if (log.nextSequence !== value.nextSeq) throw new Error('INVALID_MUTATION_LOG')
    return log
  }

  replay(state: RuntimeState, entries: MutationLogEntry[] = this.log): void {
    let expected = this.baseSequence + 1
    for (const entry of entries) {
      if (entry.seq !== expected || checksum(entry.seq, entry.transactionId, entry.mutations) !== entry.checksum) throw new Error('INVALID_MUTATION_LOG')
      apply(state, cloneMutations(entry.mutations))
      expected++
    }
  }

  private validate(): void {
    let expected = this.baseSequence + 1
    for (const entry of this.log) {
      if (entry.seq !== expected || checksum(entry.seq, entry.transactionId, entry.mutations) !== entry.checksum) throw new Error('INVALID_MUTATION_LOG')
      expected++
    }
  }
}

export function commitMutationTransaction(state: RuntimeState, log: MutationLog, transactionId: string, mutations: Mutation[], committedAt = state.now, sessionId = 'session-unknown'): MutationLogEntry {
  const existing = log.findTransaction(transactionId)
  if (existing) return existing
  const transactionalMutations = mutations.map((mutation) => mutation.op === 'appendEvent' && mutation.event.txId === undefined ? { ...mutation, event: { ...mutation.event, txId: transactionId } } : mutation)
  const entry = log.append(transactionId, transactionalMutations, committedAt)
  apply(state, entry.mutations, { sessionId, timestamp: committedAt })
  return entry
}
