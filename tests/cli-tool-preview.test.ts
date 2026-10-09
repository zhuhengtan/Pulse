import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { runShell } from '@hunterzhu/pulse-adapters'

vi.mock('@hunterzhu/pulse-adapters', async (original) => ({
  ...await original<typeof import('@hunterzhu/pulse-adapters')>(),
  runShell: vi.fn(async () => ({ code: 0, stdout: `${'line\n'.repeat(20)}tail-marker`, stderr: '', truncated: false, timedOut: false, aborted: false })),
}))

describe('tool settlement preview', () => {
  it('reports read size without copying the file body into the observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-tool-preview-'))
    const body = 'alpha\nbeta\nunique-body-marker'
    await writeFile(join(directory, 'note.txt'), body)
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.read', input: { path: 'note.txt' } }], mockAfterToolResponse: 'done' })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Read the note' })
      const observations: Array<Record<string, unknown>> = []
      for await (const event of run.events) {
        if (event.type === 'observation' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) observations.push(event.data as Record<string, unknown>)
      }
      const read = observations.find((observation) => observation.tool === 'fs.read' && observation.status === 'succeeded')
      expect(read?.preview).toMatchObject({ bytes: Buffer.byteLength(body), lines: 3, truncated: false })
      expect(JSON.stringify(read?.preview)).not.toContain('unique-body-marker')
    } finally {
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('clips shell output in the preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-tool-shell-preview-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'shell.exec', input: { command: 'printf' } }], mockAfterToolResponse: 'done' })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Run printf' })
      const observations: Array<Record<string, unknown>> = []
      for await (const event of run.events) {
        if (event.type === 'observation' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) observations.push(event.data as Record<string, unknown>)
      }
      const shell = observations.find((observation) => observation.tool === 'shell.exec')
      const preview = shell?.preview as { output?: string; truncated?: boolean; exitCode?: number } | undefined
      expect(preview?.exitCode).toBe(0)
      expect(preview?.truncated).toBe(true)
      expect(preview?.output?.split('\n').length).toBeLessThanOrEqual(8)
      expect(preview?.output).not.toContain('tail-marker')
      expect(runShell).toHaveBeenCalled()
    } finally {
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
