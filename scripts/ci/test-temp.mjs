import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Keep fixture siblings separate from runner tool caches and build scratch. */
export async function testTempEnvironment(directory) {
  const fixtures = join(directory, 'fixtures')
  await mkdir(fixtures, { recursive: true, mode: 0o700 })
  return { TMPDIR: fixtures, TMP: fixtures, TEMP: fixtures }
}
