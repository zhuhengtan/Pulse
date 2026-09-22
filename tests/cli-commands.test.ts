import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOneShot } from '../packages/cli/src/commands/run.js'

describe('CLI command runners', () => {
  it('cancels approval requests in non-interactive mode instead of hanging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-command-'))
    try {
      const code = await runOneShot({
        cwd: directory,
        dataDir: join(directory, 'data'),
        mockToolCalls: [{ name: 'fs.write', input: { path: 'blocked.txt', content: 'blocked' } }],
      }, 'write a file', 'jsonl')

      expect(code).toBe(3)
      await expect(readFile(join(directory, 'blocked.txt'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
