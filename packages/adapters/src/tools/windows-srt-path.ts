import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Only the packaged host installation can select the sandbox broker. */
export function verifiedWindowsSrt(directory = fileURLToPath(new URL('../../dist/native/', import.meta.url))): string {
  const path = join(directory, 'srt-win.exe')
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'srt-win.json'), 'utf8')) as { sha256?: string }
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (manifest.sha256 !== sha256) throw new Error('WINDOWS_SANDBOX_HELPER_HASH_MISMATCH')
    return path
  } catch (cause) {
    throw Object.assign(new Error('WINDOWS_SANDBOX_HELPER_UNAVAILABLE: run pnpm desktop:build or reinstall the release package'), { code: 'WINDOWS_SANDBOX_HELPER_UNAVAILABLE', cause })
  }
}
