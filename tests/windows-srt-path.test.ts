import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifiedWindowsSrt } from '../packages/adapters/src/tools/windows-srt-path.js'

it('requires the packaged Windows broker and matching build provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-srt-integrity-'))
  try {
    expect(() => verifiedWindowsSrt(directory)).toThrow('WINDOWS_SANDBOX_HELPER_UNAVAILABLE')
    const binary = Buffer.from('fixture bytes; never executed')
    await writeFile(join(directory, 'srt-win.exe'), binary)
    await writeFile(join(directory, 'srt-win.json'), JSON.stringify({ sha256: createHash('sha256').update(binary).digest('hex') }))
    expect(verifiedWindowsSrt(directory)).toBe(join(directory, 'srt-win.exe'))
    await writeFile(join(directory, 'srt-win.exe'), 'changed')
    expect(() => verifiedWindowsSrt(directory)).toThrow('WINDOWS_SANDBOX_HELPER_UNAVAILABLE')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
