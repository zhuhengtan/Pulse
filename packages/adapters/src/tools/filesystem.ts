import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface FilesystemWriteResult { hash: string; bytes: number }

function filesystemError(code: string, retryable = false, cause?: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  return Object.assign(new Error(code), { code, retryable, ...(cause === undefined ? {} : { cause }) })
}

function filesystemCause(cause: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  if (cause instanceof Error && typeof (cause as Error & { code?: unknown }).code === 'string' && typeof (cause as Error & { retryable?: unknown }).retryable === 'boolean') return cause as Error & { code: string; retryable: boolean; cause?: unknown }
  const code = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string' ? String((cause as { code: string }).code) : 'FILESYSTEM_OPERATION_FAILED'
  const retryable = code === 'EAGAIN' || code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE' || code === 'ETIMEDOUT'
  return filesystemError(code, retryable, cause)
}

export class FilesystemTool {
  constructor(readonly root: string) {}
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
  async list(path = '.', signal?: AbortSignal): Promise<string[]> { if (signal?.aborted) throw filesystemError('ABORTED'); return readdir(await this.existing(path)) }
  async write(path: string, content: string, signal?: AbortSignal): Promise<void> { if (signal?.aborted) throw filesystemError('ABORTED'); await writeFile(await this.writable(path), content, 'utf8') }
  async hash(path: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw filesystemError('ABORTED')
    return createHash('sha256').update(await readFile(await this.existing(path))).digest('hex')
  }
  async writeIfUnchanged(path: string, content: string, expectedHash: string, signal?: AbortSignal): Promise<FilesystemWriteResult> {
    if (signal?.aborted) throw filesystemError('ABORTED')
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw filesystemError('INVALID_FILE_BASELINE_HASH')
    const target = await this.writable(path)
    return this.withLock(target, async () => {
      if (signal?.aborted) throw filesystemError('ABORTED')
      let current: Buffer
      try { current = await readFile(target) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw filesystemError('FILE_BASELINE_MISSING'); throw filesystemCause(cause) }
      const currentHash = createHash('sha256').update(current).digest('hex')
      if (currentHash !== expectedHash) throw filesystemError('FILE_BASELINE_CONFLICT')
      const bytes = Buffer.byteLength(content, 'utf8')
      const temporary = `${target}.tmp-${process.pid}-${process.hrtime.bigint().toString()}`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(content, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporary, target)
      } finally {
        if (handle) await handle.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
      }
      return { hash: createHash('sha256').update(content).digest('hex'), bytes }
    })
  }

  private async withLock<T>(target: string, work: () => Promise<T>): Promise<T> {
    const lockPath = `${target}.pulse.lock`
    const deadline = Date.now() + 30_000
    let lock: Awaited<ReturnType<typeof open>> | undefined
    while (lock === undefined) {
      try { lock = await open(lockPath, 'wx', 0o600) }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw filesystemCause(cause)
        const lockStat = await stat(lockPath).catch(() => undefined)
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue }
        if (Date.now() >= deadline) throw filesystemError('FILESYSTEM_LOCK_TIMEOUT', true)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try { return await work() } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
  }
}
