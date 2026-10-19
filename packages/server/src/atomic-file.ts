import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

/** Replace an existing state file without making it disappear between reads.
 * Windows readers and antivirus scans can briefly deny the replacement. */
export async function replaceStateFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 9) throw error
      await setTimeout(25 * (attempt + 1))
    }
  }
}
