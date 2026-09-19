import { contentHash, stableSerialize } from '../context/builder.js'
import type { JsonValue } from '../core/types.js'

export type StorageKind = 'event' | 'result' | 'snapshot'
export type StorageState = 'memory' | 'compacted'

export interface StoragePolicyConfig {
  maxEventLogBytes?: number
  maxResultBytes?: number
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

export class SessionStoragePolicy {
  private readonly records = new Map<string, StoredRecord>()
  private readonly limits: Required<StoragePolicyConfig>

  constructor(config: StoragePolicyConfig = {}) {
    this.limits = { maxEventLogBytes: config.maxEventLogBytes ?? 1_000_000, maxResultBytes: config.maxResultBytes ?? 1_000_000, maxSnapshotBytes: config.maxSnapshotBytes ?? 1_000_000, maxTotalMemoryBytes: config.maxTotalMemoryBytes ?? 4_000_000 }
  }

  put(kind: StorageKind, key: string, value: JsonValue, pin = false): StoredRecord {
    const bytes = Buffer.byteLength(stableSerialize(value))
    const previous = this.records.get(key)
    if (previous && previous.kind !== kind) throw new Error('STORAGE_KEY_KIND_CONFLICT')
    const record: StoredRecord = { key, kind, storageState: 'memory', pinCount: (previous?.pinCount ?? 0) + (pin ? 1 : 0), bytes, hash: contentHash(value), value: structuredClone(value) }
    this.records.set(key, record)
    this.compactToFit(kind, key)
    if (this.memoryBytes(kind) > this.kindLimit(kind) || this.memoryBytes() > this.limits.maxTotalMemoryBytes) {
      if (previous) this.records.set(key, previous)
      else this.records.delete(key)
      throw new Error('SESSION_STORAGE_LIMIT_EXCEEDED')
    }
    return this.clone(record)
  }

  get(key: string): JsonValue | undefined {
    const record = this.records.get(key)
    return record?.storageState === 'memory' && record.value !== undefined ? structuredClone(record.value) : undefined
  }

  pin(key: string): void { const record = this.require(key); record.pinCount++ }
  unpin(key: string): void { const record = this.require(key); record.pinCount = Math.max(0, record.pinCount - 1) }

  compact(key: string): boolean {
    const record = this.require(key)
    if (record.kind === 'event') throw new Error('FACT_EVENT_REQUIRES_PERSISTENCE')
    if (record.pinCount > 0 || record.storageState === 'compacted') return false
    delete record.value
    record.storageState = 'compacted'
    return true
  }

  inspect(): StoredRecord[] { return [...this.records.values()].map((record) => this.clone(record)) }
  get memoryBytesTotal(): number { return this.memoryBytes() }

  private compactToFit(kind: StorageKind, protectedKey: string): void {
    while (this.memoryBytes(kind) > this.kindLimit(kind) || this.memoryBytes() > this.limits.maxTotalMemoryBytes) {
      const candidate = [...this.records.values()].find((record) => record.key !== protectedKey && record.storageState === 'memory' && record.pinCount === 0 && record.kind !== 'event')
      if (!candidate || !this.compact(candidate.key)) break
    }
  }

  private memoryBytes(kind?: StorageKind): number { return [...this.records.values()].filter((record) => record.storageState === 'memory' && (kind === undefined || record.kind === kind)).reduce((total, record) => total + record.bytes, 0) }
  private kindLimit(kind: StorageKind): number { return kind === 'event' ? this.limits.maxEventLogBytes : kind === 'result' ? this.limits.maxResultBytes : this.limits.maxSnapshotBytes }
  private require(key: string): StoredRecord { const record = this.records.get(key); if (!record) throw new Error(`UNKNOWN_STORAGE_KEY:${key}`); return record }
  private clone(record: StoredRecord): StoredRecord { return { ...record, ...(record.value === undefined ? {} : { value: structuredClone(record.value) }) } }
}
