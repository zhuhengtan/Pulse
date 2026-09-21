import { contentHash, stableSerialize } from '../context/builder.js'
import type { JsonValue } from '../core/types.js'

export type StorageKind = 'event' | 'result' | 'artifact' | 'snapshot'
export type StorageState = 'memory' | 'persisted' | 'compacted'

export interface StoragePolicyConfig {
  maxEventLogBytes?: number
  maxResultBytes?: number
  maxArtifactBytes?: number
  maxSnapshotBytes?: number
  maxTotalMemoryBytes?: number
}

export interface StoredRecord {
  key: string
  kind: StorageKind
  storageState: StorageState
  pinCount: number
  bytes: number
  hash: string
  value?: JsonValue
}

/** Record metadata without the body; safe to hand out without cloning the value. */
export type StoredRecordInfo = Omit<StoredRecord, 'value'>

export interface StoragePolicySnapshot {
  schemaVersion: 1
  limits: Required<StoragePolicyConfig>
  records: StoredRecord[]
  pinSources: Array<[string, string[]]>
}

const storageLimitKeys = ['maxEventLogBytes', 'maxResultBytes', 'maxArtifactBytes', 'maxSnapshotBytes', 'maxTotalMemoryBytes'] as const
function validStorageLimits(value: unknown): value is Required<StoragePolicyConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const limits = value as Record<string, unknown>
  return storageLimitKeys.every((key) => Number.isInteger(limits[key]) && (limits[key] as number) >= 0)
}
function validStoragePolicySnapshot(value: unknown): value is StoragePolicySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as StoragePolicySnapshot
  if (snapshot.schemaVersion !== 1 || !validStorageLimits(snapshot.limits) || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.pinSources)) return false
  const keys = new Set<string>()
  for (const record of snapshot.records) {
    if (!record || typeof record.key !== 'string' || record.key.length === 0 || keys.has(record.key) || !['event', 'result', 'artifact', 'snapshot'].includes(record.kind) || !['memory', 'persisted', 'compacted'].includes(record.storageState) || !Number.isInteger(record.pinCount) || record.pinCount < 0 || !Number.isInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.hash) || (record.kind === 'event' && record.storageState === 'compacted') || (record.storageState === 'memory' && record.value === undefined) || (record.storageState !== 'memory' && record.value !== undefined)) return false
    if (record.value !== undefined) {
      try { if (Buffer.byteLength(stableSerialize(record.value), 'utf8') !== record.bytes || contentHash(record.value) !== record.hash) return false } catch { return false }
    }
    keys.add(record.key)
  }
  const sources = new Set<string>()
  const managedPins = new Map<string, number>()
  for (const entry of snapshot.pinSources) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length === 0 || sources.has(entry[0]) || !Array.isArray(entry[1]) || new Set(entry[1]).size !== entry[1].length || entry[1].some((key) => typeof key !== 'string' || key.length === 0)) return false
    sources.add(entry[0])
    for (const key of entry[1]) managedPins.set(key, (managedPins.get(key) ?? 0) + 1)
  }
  for (const record of snapshot.records) if (record.pinCount < (managedPins.get(record.key) ?? 0)) return false
  return true
}

/**
 * Session-wide memory accounting for events, results, artifacts and snapshots.
 *
 * Records are treated as immutable values: every state change replaces the
 * record object instead of mutating it. That makes `clone()` a shallow copy of
 * the maps (copy-on-write), keeps per-kind byte totals as O(1) counters, and
 * lets `put()` roll back by restoring the handful of records it touched instead
 * of snapshotting the whole policy. Values are still cloned on the way in and
 * out, so callers can never alias internal state.
 */
export class SessionStoragePolicy {
  private records = new Map<string, StoredRecord>()
  private pinSources = new Map<string, Set<string>>()
  /** Reverse index: record key -> number of pin sources holding it. */
  private managedPins = new Map<string, number>()
  private readonly limits: Required<StoragePolicyConfig>
  private memoryByKind: Record<StorageKind, number> = { event: 0, result: 0, artifact: 0, snapshot: 0 }
  private memoryTotal = 0

  constructor(config: StoragePolicyConfig = {}) {
    const limits = { maxEventLogBytes: config.maxEventLogBytes ?? 1_000_000, maxResultBytes: config.maxResultBytes ?? 1_000_000, maxArtifactBytes: config.maxArtifactBytes ?? 4_000_000, maxSnapshotBytes: config.maxSnapshotBytes ?? 1_000_000, maxTotalMemoryBytes: config.maxTotalMemoryBytes ?? 4_000_000 }
    if (!validStorageLimits(limits)) throw new Error('INVALID_STORAGE_POLICY_LIMITS')
    this.limits = limits
  }

  put(kind: StorageKind, key: string, value: JsonValue, pin = false): StoredRecord {
    const bytes = Buffer.byteLength(stableSerialize(value))
    const hash = contentHash(value)
    const previous = this.records.get(key)
    if (previous && previous.kind !== kind) throw new Error('STORAGE_KEY_KIND_CONFLICT')
    const managedPin = previous === undefined ? this.managedPins.get(key) ?? 0 : 0
    const unchanged = previous !== undefined && previous.bytes === bytes && previous.hash === hash
    const storageState = unchanged ? previous.storageState : 'memory'
    const record: StoredRecord = { key, kind, storageState, pinCount: (previous?.pinCount ?? 0) + (pin ? 1 : 0) + managedPin, bytes, hash, ...(storageState === 'memory' ? { value: unchanged && previous.value !== undefined ? previous.value : structuredClone(value) } : {}) }
    const touched = new Map<string, StoredRecord | undefined>([[key, previous]])
    this.set(record)
    this.compactToFit(kind, key, touched)
    if (this.memoryByKind[kind] > this.kindLimit(kind) || this.memoryTotal > this.limits.maxTotalMemoryBytes) {
      for (const [touchedKey, original] of touched) if (original === undefined) this.unset(touchedKey); else this.set(original)
      throw new Error('SESSION_STORAGE_LIMIT_EXCEEDED')
    }
    return this.copyRecord(record)
  }

  get(key: string): JsonValue | undefined {
    const record = this.records.get(key)
    return record?.storageState === 'memory' && record.value !== undefined ? structuredClone(record.value) : undefined
  }

  has(key: string): boolean { return this.records.has(key) }

  /** Metadata for one record without cloning its body. */
  record(key: string): StoredRecordInfo | undefined {
    const record = this.records.get(key)
    if (!record) return undefined
    const { value: _value, ...info } = record
    return info
  }

  pin(key: string): void { const record = this.require(key); this.set({ ...record, pinCount: record.pinCount + 1 }) }
  unpin(key: string): void { const record = this.require(key); this.set({ ...record, pinCount: Math.max(0, record.pinCount - 1) }) }
  remove(key: string): boolean {
    const record = this.records.get(key)
    if (!record || record.pinCount > 0 || record.kind === 'event') return false
    this.unset(key)
    if (this.managedPins.has(key)) {
      for (const [source, keys] of this.pinSources) {
        if (!keys.has(key)) continue
        const next = new Set(keys)
        next.delete(key)
        if (next.size === 0) this.pinSources.delete(source)
        else this.pinSources.set(source, next)
      }
      this.managedPins.delete(key)
    }
    return true
  }

  /** Replace one logical owner’s pins without double-counting repeated reconciliation. */
  replacePinSource(source: string, keys: Iterable<string>): void {
    const next = new Set(keys)
    const previous = this.pinSources.get(source) ?? new Set<string>()
    for (const key of previous) if (!next.has(key)) {
      const count = (this.managedPins.get(key) ?? 1) - 1
      if (count <= 0) this.managedPins.delete(key); else this.managedPins.set(key, count)
      if (this.records.has(key)) this.unpin(key)
    }
    for (const key of next) if (!previous.has(key)) {
      this.managedPins.set(key, (this.managedPins.get(key) ?? 0) + 1)
      if (this.records.has(key)) this.pin(key)
    }
    if (next.size) this.pinSources.set(source, next)
    else this.pinSources.delete(source)
  }

  /** Make a private copy suitable for validate-stage storage admission. Shallow: records are immutable and shared. */
  clone(): SessionStoragePolicy {
    const copy = new SessionStoragePolicy(this.limits)
    copy.records = new Map(this.records)
    copy.pinSources = new Map(this.pinSources)
    copy.managedPins = new Map(this.managedPins)
    copy.memoryByKind = { ...this.memoryByKind }
    copy.memoryTotal = this.memoryTotal
    return copy
  }

  /** Adopt the state of a clone produced by `clone()` after it has been mutated as a candidate. */
  adopt(candidate: SessionStoragePolicy): void {
    if (storageLimitKeys.some((key) => candidate.limits[key] !== this.limits[key])) throw new Error('STORAGE_POLICY_LIMITS_MISMATCH')
    this.records = new Map(candidate.records)
    this.pinSources = new Map(candidate.pinSources)
    this.managedPins = new Map(candidate.managedPins)
    this.memoryByKind = { ...candidate.memoryByKind }
    this.memoryTotal = candidate.memoryTotal
  }

  snapshot(): StoragePolicySnapshot { return { schemaVersion: 1, limits: { ...this.limits }, records: [...this.records.values()].map((record) => this.copyRecord(record)), pinSources: [...this.pinSources.entries()].map(([source, keys]) => [source, [...keys]]) } }

  /** Atomically replace this policy with a previously validated candidate snapshot. */
  replaceSnapshot(snapshot: StoragePolicySnapshot): void {
    if (!validStoragePolicySnapshot(snapshot)) throw new Error('INVALID_STORAGE_POLICY_SNAPSHOT')
    this.restore(snapshot)
  }

  static fromSnapshot(snapshot: StoragePolicySnapshot | JsonValue): SessionStoragePolicy {
    const value = snapshot as StoragePolicySnapshot
    if (!validStoragePolicySnapshot(value)) throw new Error('INVALID_STORAGE_POLICY_SNAPSHOT')
    const policy = new SessionStoragePolicy(value.limits)
    policy.restore(value)
    return policy
  }

  compact(key: string): boolean {
    const record = this.require(key)
    if (record.kind === 'event') throw new Error('FACT_EVENT_REQUIRES_PERSISTENCE')
    if (record.pinCount > 0 || record.storageState === 'compacted') return false
    const { value: _value, ...rest } = record
    this.set({ ...rest, storageState: 'compacted' })
    return true
  }

  /** Mark records durable only after the persistence backend has acknowledged the snapshot. */
  markPersisted(keys?: Iterable<string>): void {
    const selected = keys === undefined ? [...this.records.keys()] : [...keys]
    for (const key of selected) {
      const record = this.require(key)
      if (record.storageState === 'compacted') continue
      const { value: _value, ...rest } = record
      this.set({ ...rest, storageState: 'persisted' })
    }
  }

  inspect(): StoredRecord[] { return [...this.records.values()].map((record) => this.copyRecord(record)) }
  /** Keys of all records, without copying bodies. */
  keys(): IterableIterator<string> { return this.records.keys() }
  get memoryBytesTotal(): number { return this.memoryTotal }

  private compactToFit(kind: StorageKind, protectedKey: string, touched: Map<string, StoredRecord | undefined>): void {
    while (this.memoryByKind[kind] > this.kindLimit(kind) || this.memoryTotal > this.limits.maxTotalMemoryBytes) {
      let candidate: StoredRecord | undefined
      for (const record of this.records.values()) if (record.key !== protectedKey && record.storageState === 'memory' && record.pinCount === 0 && record.kind !== 'event') { candidate = record; break }
      if (!candidate) break
      if (!touched.has(candidate.key)) touched.set(candidate.key, candidate)
      if (!this.compact(candidate.key)) break
    }
  }

  /** Install a record and keep the byte counters in sync with its residency. */
  private set(record: StoredRecord): void {
    const previous = this.records.get(record.key)
    if (previous?.storageState === 'memory') { this.memoryByKind[previous.kind] -= previous.bytes; this.memoryTotal -= previous.bytes }
    if (record.storageState === 'memory') { this.memoryByKind[record.kind] += record.bytes; this.memoryTotal += record.bytes }
    this.records.set(record.key, record)
  }

  private unset(key: string): void {
    const previous = this.records.get(key)
    if (!previous) return
    if (previous.storageState === 'memory') { this.memoryByKind[previous.kind] -= previous.bytes; this.memoryTotal -= previous.bytes }
    this.records.delete(key)
  }

  private kindLimit(kind: StorageKind): number { return kind === 'event' ? this.limits.maxEventLogBytes : kind === 'result' ? this.limits.maxResultBytes : kind === 'artifact' ? this.limits.maxArtifactBytes : this.limits.maxSnapshotBytes }
  private require(key: string): StoredRecord { const record = this.records.get(key); if (!record) throw new Error(`UNKNOWN_STORAGE_KEY:${key}`); return record }
  private copyRecord(record: StoredRecord): StoredRecord { return { ...record, ...(record.value === undefined ? {} : { value: structuredClone(record.value) }) } }
  private restore(snapshot: StoragePolicySnapshot): void {
    this.records = new Map()
    this.memoryByKind = { event: 0, result: 0, artifact: 0, snapshot: 0 }
    this.memoryTotal = 0
    for (const record of snapshot.records) this.set(this.copyRecord(record))
    this.pinSources = new Map()
    this.managedPins = new Map()
    for (const [source, keys] of snapshot.pinSources) {
      this.pinSources.set(source, new Set(keys))
      for (const key of keys) this.managedPins.set(key, (this.managedPins.get(key) ?? 0) + 1)
    }
  }
}
