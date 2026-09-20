import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface FilesystemWriteResult { hash: string; bytes: number }

export class FilesystemTool {
  constructor(readonly root: string) {}
  private safe(path: string): string { const target = resolve(this.root, path); if (isAbsolute(path) || relative(this.root, target).startsWith('..')) throw new Error('PATH_OUTSIDE_SANDBOX'); return target }
  async read(path: string, signal?: AbortSignal): Promise<string> { if (signal?.aborted) throw new Error('ABORTED'); return readFile(this.safe(path), 'utf8') }
  async list(path = '.', signal?: AbortSignal): Promise<string[]> { if (signal?.aborted) throw new Error('ABORTED'); return readdir(this.safe(path)) }
  async write(path: string, content: string, signal?: AbortSignal): Promise<void> { if (signal?.aborted) throw new Error('ABORTED'); const target = this.safe(path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, 'utf8') }
  async hash(path: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('ABORTED')
    return createHash('sha256').update(await readFile(this.safe(path))).digest('hex')
  }
  async writeIfUnchanged(path: string, content: string, expectedHash: string, signal?: AbortSignal): Promise<FilesystemWriteResult> {
    if (signal?.aborted) throw new Error('ABORTED')
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('INVALID_FILE_BASELINE_HASH')
    const target = this.safe(path)
    await mkdir(dirname(target), { recursive: true })
    return this.withLock(target, async () => {
      if (signal?.aborted) throw new Error('ABORTED')
      let current: Buffer
      try { current = await readFile(target) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FILE_BASELINE_MISSING'); throw cause }
      const currentHash = createHash('sha256').update(current).digest('hex')
      if (currentHash !== expectedHash) throw new Error('FILE_BASELINE_CONFLICT')
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
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        const lockStat = await stat(lockPath).catch(() => undefined)
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue }
        if (Date.now() >= deadline) throw new Error('FILESYSTEM_LOCK_TIMEOUT')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try { return await work() } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
  }
}
