import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOneShot } from '../packages/cli/src/commands/run.js'
import { runResume } from '../packages/cli/src/commands/resume.js'
import { findResumeConversation } from '../packages/cli/src/commands/interactive.js'
import { createLocalHost } from '@hunterzhu/pulse-server'

describe('CLI command runners', () => {
  it('includes cumulative usage in the resume JSONL result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-resume-usage-'))
    const options = { cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'finished', taskController: false }
    const host = createLocalHost(options)
    let output = ''
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { output += String(chunk); return true })
    try {
      const conversation = await host.createConversation()
      await (await host.sendMessage(conversation.id, { text: 'Check the project' })).outcome()
      await host.close()
      await runResume(options, conversation.id, '继续检查', 'jsonl')
      const result = output.trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'result')
      expect(result.usage).toMatchObject({ schemaVersion: 1, modelCalls: expect.any(Number) })
      expect(result.usage.modelCalls).toBeGreaterThan(0)
    } finally { stdout.mockRestore(); await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
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

  it('validates explicit IDs without creating or switching to a different conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-explicit-resume-'))
    const options = { cwd: directory, dataDir: join(directory, 'data') }
    const host = createLocalHost(options)
    try {
      const existing = await host.createConversation()
      await expect(findResumeConversation(options, existing.id)).resolves.toBe(existing.id)
      await expect(findResumeConversation(options, 'conv-11111111-1111-4111-8111-111111111111')).rejects.toThrow('未找到指定会话')
      await expect(findResumeConversation(options, '../escape')).rejects.toThrow('INVALID_CONVERSATION_ID')
      expect((await host.listConversations()).map(item => item.id)).toEqual([existing.id])
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
