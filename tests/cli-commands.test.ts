import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOneShot } from '../packages/cli/src/commands/run.js'
import { findResumeConversation } from '../packages/cli/src/commands/interactive.js'
import { createLocalHost } from '@hunterzhu/pulse-server'

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

  it('selects the latest saved conversation for --resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-resume-flag-'))
    try {
      const options = { cwd: directory, dataDir: join(directory, 'data') }
      const host = createLocalHost(options)
      await host.init()
      await host.createConversation({ title: 'first' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const latest = await host.createConversation({ title: 'latest' })
      await host.close()

      await expect(findResumeConversation(options)).resolves.toBe(latest.id)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
