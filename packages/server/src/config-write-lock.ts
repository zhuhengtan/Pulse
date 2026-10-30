import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** All policy amendment and settings writers share this cross-process lock.
 * A stale/foreign lock fails closed; it is never stolen on a timer. */
export async function withConfigFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.write-lock`
  const deadline = Date.now() + 5000
  let handle
  for (;;) {
    try { handle = await open(lock, 'wx', 0o600); break }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      if (Date.now() >= deadline) throw new Error('CONFIG_WRITE_BUSY')
      await sleep(25)
    }
  }
  try { return await work() } finally { await handle.close(); await rm(lock) }
}
