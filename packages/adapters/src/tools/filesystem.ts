import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

export interface FilesystemWriteResult { hash: string; bytes: number }
export interface FilesystemReadResult { content: string; truncated: boolean }

function filesystemError(code: string, retryable = false, cause?: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  return Object.assign(new Error(code), { code, retryable, ...(cause === undefined ? {} : { cause }) })
}

function filesystemCause(cause: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  if (cause instanceof Error && typeof (cause as Error & { code?: unknown }).code === 'string' && typeof (cause as Error & { retryable?: unknown }).retryable === 'boolean') return cause as Error & { code: string; retryable: boolean; cause?: unknown }
  const code = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string' ? String((cause as { code: string }).code) : 'FILESYSTEM_OPERATION_FAILED'
  const retryable = code === 'EAGAIN' || code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE' || code === 'ETIMEDOUT'
  return filesystemError(code, retryable, cause)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw cause
  }
}

export class FilesystemTool {
  constructor(readonly root: string, private readonly lockTimeoutMs = 30_000) {}
  private safe(path: string): string { const target = resolve(this.root, path); if (isAbsolute(path) || relative(resolve(this.root), target).startsWith('..')) throw filesystemError('PATH_OUTSIDE_SANDBOX'); return target }
  private async existing(path: string): Promise<string> {
    const target = this.safe(path)
    const [root, resolved] = await Promise.all([realpath(this.root), realpath(target)])
    const within = relative(root, resolved)
    if (within.startsWith('..') || isAbsolute(within)) throw filesystemError('PATH_OUTSIDE_SANDBOX')
    return resolved
  }
  private async writable(path: string): Promise<string> {
    const target = this.safe(path)
    await mkdir(dirname(target), { recursive: true })
    const [root, parent] = await Promise.all([realpath(this.root), realpath(dirname(target))])
    const within = relative(root, parent)
    if (within.startsWith('..') || isAbsolute(within)) throw filesystemError('PATH_OUTSIDE_SANDBOX')
    const existing = await lstat(target).catch((cause) => (cause as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(cause))
    if (existing?.isSymbolicLink()) throw filesystemError('PATH_OUTSIDE_SANDBOX')
    return target
  }
  async read(path: string, signal?: AbortSignal): Promise<string> { if (signal?.aborted) throw filesystemError('ABORTED'); return readFile(await this.existing(path), 'utf8') }
  async readLimited(path: string, maxBytes: number, signal?: AbortSignal): Promise<FilesystemReadResult> {
    const { content, truncated } = await this.readRange(path, maxBytes, 0, signal)
    return { content, truncated }
  }
  /** Resolve a one-based source line without confusing line numbers with byte offsets. */
  async offsetForLine(path: string, startLine: number, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(startLine) || startLine < 1) throw filesystemError('INVALID_START_LINE')
    if (signal?.aborted) throw filesystemError('ABORTED')
    if (startLine === 1) return 0
    const handle = await open(await this.existing(path), 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      let offset = 0
      let line = 1
      const scanLimit = 16 * 1024 * 1024
      while (offset < scanLimit) {
        if (signal?.aborted) throw filesystemError('ABORTED')
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, scanLimit - offset), offset)
        if (signal?.aborted) throw filesystemError('ABORTED')
        if (!bytesRead) return offset
        for (let index = 0; index < bytesRead; index++) {
          if (buffer[index] === 10 && ++line === startLine) return offset + index + 1
        }
        offset += bytesRead
      }
      throw filesystemError('READ_LINE_SCAN_LIMIT')
    } finally { await handle.close() }
  }
  async readRange(path: string, maxBytes: number, offset = 0, signal?: AbortSignal): Promise<FilesystemReadResult & { offset: number; nextOffset: number | null }> {
    if (signal?.aborted) throw filesystemError('ABORTED')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000 || !Number.isSafeInteger(offset) || offset < 0) throw filesystemError('INVALID_READ_RANGE')
    const handle = await open(await this.existing(path), 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, offset)
      if (signal?.aborted) throw filesystemError('ABORTED')
      if (bytesRead && (buffer[0]! & 0xc0) === 0x80) throw filesystemError('INVALID_UTF8_OFFSET')
      let end = Math.min(bytesRead, maxBytes)
      if (bytesRead > maxBytes) {
        // The byte after the window is a continuation: drop the partial codepoint.
        while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
      }
      if (end === 0 && bytesRead > 0) throw filesystemError('READ_WINDOW_TOO_SMALL')
      const content = buffer.subarray(0, end).toString('utf8')
      const truncated = bytesRead > end
      return { content, truncated, offset, nextOffset: truncated ? offset + end : null }
    } finally { await handle.close() }
  }
  async list(path = '.', signal?: AbortSignal): Promise<string[]> { if (signal?.aborted) throw filesystemError('ABORTED'); return readdir(await this.existing(path)) }
  async write(path: string, content: string, signal?: AbortSignal): Promise<void> { if (signal?.aborted) throw filesystemError('ABORTED'); await writeFile(await this.writable(path), content, 'utf8') }
  async move(source: string, destination: string, expectedHash?: string, signal?: AbortSignal): Promise<{ hash: string; bytes: number }> {
    if (signal?.aborted) throw filesystemError('ABORTED')
    const sourcePath = this.safe(source)
    const sourceEntry = await lstat(sourcePath).catch((cause) => (cause as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(cause))
    if (!sourceEntry) throw filesystemError('ENOENT')
    if (sourceEntry.isSymbolicLink()) throw filesystemError('PATH_OUTSIDE_SANDBOX')
    const sourceTarget = await this.existing(source)
    const destinationTarget = await this.writable(destination)
    const destinationExists = await lstat(destinationTarget).catch((cause) => (cause as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(cause))
    if (destinationExists) throw filesystemError('MOVE_DESTINATION_EXISTS')
    const currentHash = await this.hash(source, signal)
    if (expectedHash !== undefined && currentHash !== expectedHash) throw filesystemError('FILE_BASELINE_CONFLICT')
    await this.withLock(sourceTarget, async () => { await rename(sourceTarget, destinationTarget) })
    return { hash: currentHash, bytes: sourceEntry.size }
  }
  async hash(path: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw filesystemError('ABORTED')
    const digest = createHash('sha256')
    await pipeline(createReadStream(await this.existing(path)), digest, signal === undefined ? {} : { signal })
    return digest.digest('hex')
  }
  async writeIfUnchanged(path: string, content: string, expectedHash: string | null, signal?: AbortSignal): Promise<FilesystemWriteResult> {
    if (signal?.aborted) throw filesystemError('ABORTED')
    if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw filesystemError('INVALID_FILE_BASELINE_HASH')
    const target = await this.writable(path)
    return this.withLock(target, async () => {
      if (signal?.aborted) throw filesystemError('ABORTED')
      let current: Buffer | undefined
      try { current = await readFile(target) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw filesystemCause(cause) }
      if (current === undefined && expectedHash !== null) throw filesystemError('FILE_BASELINE_MISSING')
      const currentHash = current === undefined ? null : createHash('sha256').update(current).digest('hex')
      if (currentHash !== expectedHash) throw filesystemError('FILE_BASELINE_CONFLICT')
      const bytes = Buffer.byteLength(content, 'utf8')
      const temporary = `${target}.tmp-${process.pid}-${process.hrtime.bigint().toString()}`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(content, 'utf8')
        if (current !== undefined) await handle.chmod((await lstat(target)).mode & 0o777)
        await handle.sync()
        await handle.close()
        handle = undefined
        if (signal?.aborted) throw filesystemError('ABORTED')
        if (expectedHash === null) await link(temporary, target)
        else await rename(temporary, target)
      } finally {
        if (handle) await handle.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
      }
      return { hash: createHash('sha256').update(content).digest('hex'), bytes }
    })
  }

  private async withLock<T>(target: string, work: () => Promise<T>): Promise<T> {
    const lockPath = `${target}.pulse.lock`
    const deadline = Date.now() + this.lockTimeoutMs
    const payload = JSON.stringify({ pid: process.pid, token: `${process.pid}:${process.hrtime.bigint()}` })
    let lock: Awaited<ReturnType<typeof open>> | undefined
    while (lock === undefined) {
      try {
        lock = await open(lockPath, 'wx', 0o600)
        await lock.writeFile(payload)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw filesystemCause(cause)
        const body = await readFile(lockPath, 'utf8').catch(() => undefined)
        let owner: { pid?: number } | undefined
        try { owner = body ? JSON.parse(body) as { pid?: number } : undefined } catch { owner = undefined }
        if (typeof owner?.pid === 'number' && !pidAlive(owner.pid) && body !== undefined) {
          const current = await readFile(lockPath, 'utf8').catch(() => undefined)
          if (current === body) { await rm(lockPath, { force: true }); continue }
        }
        if (Date.now() >= deadline) throw filesystemError('FILESYSTEM_LOCK_TIMEOUT', true)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try { return await work() } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
  }
}
