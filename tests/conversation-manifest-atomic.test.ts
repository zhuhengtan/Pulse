import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'

const writes = vi.hoisted(() => ({ pause: undefined as undefined | { entered: () => void; release: Promise<void> } }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    const pause = writes.pause
    if (pause && String(args[0]).includes('manifest.json')) {
      writes.pause = undefined
      const options = args[2] as { flag?: string; mode?: number } | undefined
      const file = await fs.open(args[0] as string, options?.flag ?? 'w', options?.mode)
      try { pause.entered(); await pause.release; await file.writeFile(args[1] as string) }
      finally { await file.close() }
      return
    }
    return fs.writeFile(...args)
  } }
})

it('keeps the previous manifest readable while an assistant update is being written', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-manifest-atomic-'))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false } })
  let release!: () => void
  let entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const writing = new Promise<void>(resolve => { entered = resolve })
  let update: Promise<void> | undefined
  try {
    const conversation = await host.createConversation({ title: 'before' })
    writes.pause = { entered, release: barrier }
    update = host.appendAssistantUserMessage(conversation.id, { id: 'msg-one', runId: 'run-one', text: 'after', createdAt: new Date().toISOString() })
    await writing
    expect((await host.getConversation(conversation.id)).summary.title).toBe('before')
    expect((await host.listConversations()).map(item => item.id)).toContain(conversation.id)
    release()
    await update
    expect((await host.getConversation(conversation.id)).summary.title).toBe('after')
  } finally {
    release()
    writes.pause = undefined
    await update
    await host.close()
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
