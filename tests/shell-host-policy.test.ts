import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { runShell } from '@hunterzhu/pulse-adapters'

vi.mock('@hunterzhu/pulse-adapters', async (original) => ({
  ...await original<typeof import('@hunterzhu/pulse-adapters')>(),
  runShell: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false })),
}))

describe('host shell network policy', () => {
  it('reports a nonzero command exit as a failed tool in the UI', async () => {
    vi.mocked(runShell).mockResolvedValueOnce({ code: 127, stdout: '', stderr: 'command missing', truncated: false, timedOut: false, aborted: false })
    const directory = await mkdtemp(join(tmpdir(), 'pulse-shell-exit-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'ask', mockToolCalls: [{ name: 'shell.exec', input: { command: 'missing' } }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Run the command' })
      const observations: unknown[] = []
      for await (const event of run.events) {
        if (event.type === 'waiting') await run.reply((event.data as { effectId: string }).effectId, { approved: true })
        if (event.type === 'observation') observations.push(event.data)
      }
      expect(observations).toContainEqual(expect.objectContaining({ tool: 'shell.exec', status: 'failed', result: expect.objectContaining({ exitCode: 127 }) }))
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it.each([false, true])('forwards only explicitly enabled domains (network=%s)', async (allowNetwork) => {
    vi.mocked(runShell).mockClear()
    const directory = await mkdtemp(join(tmpdir(), 'pulse-shell-policy-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'ask', allowNetwork, networkHosts: ['github.com'], mockToolCalls: [{ name: 'shell.exec', input: { command: 'git', args: ['status'], cwd: directory } }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Check git status' })
      for await (const event of run.events) {
        if (event.type === 'waiting') await run.reply((event.data as { effectId: string }).effectId, { approved: true })
      }
      expect(runShell).toHaveBeenCalledTimes(1)
      expect(vi.mocked(runShell).mock.calls[0]?.[2]?.allowedDomains).toEqual(allowNetwork ? ['github.com'] : [])
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
