import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Bounded memory observation plus a separately bounded, private durable byte stream. */
export class ShellOutput {
  readonly id = randomUUID()
  private streams = new Map<string, { fd?: number; head: Buffer; tail: Buffer; bytes: number; stored: number; hash: ReturnType<typeof createHash>; storedHash: ReturnType<typeof createHash>; error?: string }>()
  constructor(private readonly memoryLimit: number, private readonly directory?: string, private readonly diskLimit = 16 * 1024 * 1024, private readonly keepTail = true) {}
  append(name: 'stdout' | 'stderr', chunk: Buffer): void {
    let s = this.streams.get(name)
    if (!s) {
      s = { head: Buffer.alloc(0), tail: Buffer.alloc(0), bytes: 0, stored: 0, hash: createHash('sha256'), storedHash: createHash('sha256') }
      if (this.directory) try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); s.fd = openSync(join(this.directory, `${this.id}-${name}.log`), 'wx', 0o600) } catch { s.error = 'OUTPUT_ARCHIVE_OPEN_FAILED' }
      this.streams.set(name, s)
    }
    s.bytes += chunk.length
    s.hash.update(chunk)
    const half = this.keepTail ? Math.floor(this.memoryLimit / 2) : this.memoryLimit
    if (s.head.length < half) s.head = Buffer.concat([s.head, chunk.subarray(0, half - s.head.length)])
    if (this.keepTail) s.tail = Buffer.concat([s.tail, chunk]).subarray(-Math.max(1, this.memoryLimit - half))
    if (s.fd !== undefined && !s.error) try {
      const kept = chunk.subarray(0, Math.max(0, this.diskLimit - s.stored))
      let offset = 0
      while (offset < kept.length) offset += writeSync(s.fd, kept, offset, kept.length - offset)
      s.storedHash.update(kept)
      s.stored += offset
      if (kept.length < chunk.length) s.error = 'OUTPUT_ARCHIVE_LIMIT'
    } catch { s.error = 'OUTPUT_ARCHIVE_WRITE_FAILED' }
  }
  text(name: 'stdout' | 'stderr'): string {
    const s = this.streams.get(name)
    if (!s || this.memoryLimit === 0) return ''
    // When the output fits, tail contains the suffix after the head without a gap.
    const tail = s.bytes <= this.memoryLimit ? s.tail.subarray(Math.max(0, s.tail.length - (s.bytes - s.head.length))) : s.tail
    let bytes = Buffer.concat([s.head, tail]).subarray(0, this.memoryLimit)
    while (bytes.length && bytes.toString('utf8').endsWith('\ufffd')) bytes = bytes.subarray(0, -1)
    return bytes.toString('utf8')
  }
  finish() {
    const output: Record<string, { id: string; bytes: number; storedBytes: number; sha256: string; storedSha256: string; omittedStart: number; omittedEnd: number; complete: boolean; error?: string }> = {}
    for (const [name, s] of this.streams) {
      if (s.fd !== undefined) { try { closeSync(s.fd) } catch { s.error = 'OUTPUT_ARCHIVE_CLOSE_FAILED' }; delete s.fd }
      output[name] = { id: `${this.id}-${name}.log`, bytes: s.bytes, storedBytes: s.stored, sha256: s.hash.digest('hex'), storedSha256: s.storedHash.digest('hex'), omittedStart: s.head.length, omittedEnd: Math.max(s.head.length, s.bytes - s.tail.length), complete: !!this.directory && s.stored === s.bytes && !s.error, ...(s.error ? { error: s.error } : {}) }
    }
    return output
  }
}
