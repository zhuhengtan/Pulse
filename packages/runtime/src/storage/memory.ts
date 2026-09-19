import { stableSerialize } from '../context/builder.js'
import type { JsonValue } from '../core/types.js'

export class MemoryStorage {
  private readonly values = new Map<string, JsonValue>()
  private bytes = 0
  constructor(readonly hardLimitBytes = 1_000_000) {}
  put(key: string, value: JsonValue): void {
    const nextBytes = Buffer.byteLength(stableSerialize(value))
    const previous = this.values.has(key) ? Buffer.byteLength(stableSerialize(this.values.get(key))) : 0
    if (this.bytes - previous + nextBytes > this.hardLimitBytes) throw new Error('SESSION_STORAGE_LIMIT_EXCEEDED')
    this.values.set(key, structuredClone(value)); this.bytes = this.bytes - previous + nextBytes
  }
  get(key: string): JsonValue | undefined { const value = this.values.get(key); return value === undefined ? undefined : structuredClone(value) }
  delete(key: string): boolean { const value = this.values.get(key); if (value === undefined) return false; this.bytes -= Buffer.byteLength(stableSerialize(value)); return this.values.delete(key) }
  get sizeBytes(): number { return this.bytes }
}
