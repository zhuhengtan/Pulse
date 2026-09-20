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

export interface StoragePolicySnapshot {
  schemaVersion: 1
  limits: Required<StoragePolicyConfig>
  records: StoredRecord[]
  pinSources: Array<[string, string[]]>
}

export class SessionStoragePolicy {
  private readonly records = new Map<string, StoredRecord>()
  private readonly pinSources = new Map<string, Set<string>>()
  private readonly limits: Required<StoragePolicyConfig>

  constructor(config: StoragePolicyConfig = {}) {
    this.limits = { maxEventLogBytes: config.maxEventLogBytes ?? 1_000_000, maxResultBytes: config.maxResultBytes ?? 1_000_000, maxArtifactBytes: config.maxArtifactBytes ?? 4_000_000, maxSnapshotBytes: config.maxSnapshotBytes ?? 1_000_000, maxTotalMemoryBytes: config.maxTotalMemoryBytes ?? 4_000_000 }
  }

  put(kind: StorageKind, key: string, value: JsonValue, pin = false): StoredRecord {
    const before = this.snapshot()
    const bytes = Buffer.byteLength(stableSerialize(value))
    const previous = this.records.get(key)
    if (previous && previous.kind !== kind) throw new Error('STORAGE_KEY_KIND_CONFLICT')
    const managedPin = previous === undefined && this.isManagedPinned(key) ? 1 : 0
    const record: StoredRecord = { key, kind, storageState: 'memory', pinCount: (previous?.pinCount ?? 0) + (pin ? 1 : 0) + managedPin, bytes, hash: contentHash(value), value: structuredClone(value) }
    this.records.set(key, record)
    this.compactToFit(kind, key)
    if (this.memoryBytes(kind) > this.kindLimit(kind) || this.memoryBytes() > this.limits.maxTotalMemoryBytes) {
      this.restore(before)
      throw new Error('SESSION_STORAGE_LIMIT_EXCEEDED')
    }
    return this.copyRecord(record)
  }

  get(key: string): JsonValue | undefined {
    const record = this.records.get(key)
    return record?.storageState === 'memory' && record.value !== undefined ? structuredClone(record.value) : undefined
  }

  pin(key: string): void { const record = this.require(key); record.pinCount++ }
  unpin(key: string): void { const record = this.require(key); record.pinCount = Math.max(0, record.pinCount - 1) }

  /** Replace one logical owner’s pins without double-counting repeated reconciliation. */
  replacePinSource(source: string, keys: Iterable<string>): void {
    const next = new Set(keys)
    const previous = this.pinSources.get(source) ?? new Set<string>()
    for (const key of previous) if (!next.has(key) && this.records.has(key)) this.unpin(key)
    for (const key of next) if (!previous.has(key) && this.records.has(key)) this.pin(key)
    if (next.size) this.pinSources.set(source, next)
    else this.pinSources.delete(source)
  }

  /** Make a private copy suitable for validate-stage storage admission. */
  clone(): SessionStoragePolicy {
    const copy = new SessionStoragePolicy(this.limits)
    copy.restore(this.snapshot())
    return copy
  }

  snapshot(): StoragePolicySnapshot { return { schemaVersion: 1, limits: { ...this.limits }, records: [...this.records.values()].map((record) => this.copyRecord(record)), pinSources: [...this.pinSources.entries()].map(([source, keys]) => [source, [...keys]]) } }

  static fromSnapshot(snapshot: StoragePolicySnapshot | JsonValue): SessionStoragePolicy {
    const value = snapshot as StoragePolicySnapshot
    if (!value || value.schemaVersion !== 1 || !value.limits || !Array.isArray(value.records) || !Array.isArray(value.pinSources)) throw new Error('INVALID_STORAGE_POLICY_SNAPSHOT')
    const policy = new SessionStoragePolicy(value.limits)
    policy.restore(value)
    return policy
  }

  compact(key: string): boolean {
    const record = this.require(key)
    if (record.kind === 'event') throw new Error('FACT_EVENT_REQUIRES_PERSISTENCE')
    if (record.pinCount > 0 || record.storageState === 'compacted') return false
    delete record.value
    record.storageState = 'compacted'
    return true
  }

  /** Mark records durable only after the persistence backend has acknowledged the snapshot. */
  markPersisted(keys?: Iterable<string>): void {
    const selected = keys === undefined ? [...this.records.keys()] : [...keys]
    for (const key of selected) {
      const record = this.require(key)
      if (record.storageState === 'compacted') continue
      delete record.value
      record.storageState = 'persisted'
    }
  }

  inspect(): StoredRecord[] { return [...this.records.values()].map((record) => this.copyRecord(record)) }
  get memoryBytesTotal(): number { return this.memoryBytes() }

  private compactToFit(kind: StorageKind, protectedKey: string): void {
    while (this.memoryBytes(kind) > this.kindLimit(kind) || this.memoryBytes() > this.limits.maxTotalMemoryBytes) {
      const candidate = [...this.records.values()].find((record) => record.key !== protectedKey && record.storageState === 'memory' && record.pinCount === 0 && record.kind !== 'event')
      if (!candidate || !this.compact(candidate.key)) break
    }
  }

  private memoryBytes(kind?: StorageKind): number { return [...this.records.values()].filter((record) => record.storageState === 'memory' && (kind === undefined || record.kind === kind)).reduce((total, record) => total + record.bytes, 0) }
  private kindLimit(kind: StorageKind): number { return kind === 'event' ? this.limits.maxEventLogBytes : kind === 'result' ? this.limits.maxResultBytes : kind === 'artifact' ? this.limits.maxArtifactBytes : this.limits.maxSnapshotBytes }
  private require(key: string): StoredRecord { const record = this.records.get(key); if (!record) throw new Error(`UNKNOWN_STORAGE_KEY:${key}`); return record }
  private copyRecord(record: StoredRecord): StoredRecord { return { ...record, ...(record.value === undefined ? {} : { value: structuredClone(record.value) }) } }
  private isManagedPinned(key: string): boolean { return [...this.pinSources.values()].some((keys) => keys.has(key)) }
  private restore(snapshot: StoragePolicySnapshot): void {
    this.records.clear()
    for (const record of snapshot.records) this.records.set(record.key, this.copyRecord(record))
    this.pinSources.clear()
    for (const [source, keys] of snapshot.pinSources) this.pinSources.set(source, new Set(keys))
  }
}
