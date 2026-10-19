import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '@hunterzhu/pulse-server'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'

it('waits for an in-flight assistant launch and leaves later messages queued when stopping', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-h5-stop-'))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false }, mockResponse: 'done' })
  const server = new H5Server(host, { dataDir: join(cwd, 'data'), host: '127.0.0.1', port: 0 })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const original = host.sendMessage.bind(host)
  const send = vi.spyOn(host, 'sendMessage').mockImplementation(async (...args) => { await barrier; return original(...args) })
  let stopping: Promise<void> | undefined
  try {
    const info = await server.start(), base = `http://127.0.0.1:${info.port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const cookie = session.headers.get('set-cookie')!
    await session.text()
    for (const requestId of ['stop-message-one', 'stop-message-two']) {
      const response = await fetch(`${base}/api/assistant/messages`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, text: 'hello' }) })
      expect(response.status).toBe(202)
      await response.text()
    }
    await expect.poll(() => send.mock.calls.length).toBe(1)
    let stopped = false
    stopping = server.stop().then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(stopped, 'shutdown must wait for the launch already in progress').toBe(false)
    release()
    await stopping
    expect(send).toHaveBeenCalledTimes(1)
    expect((server as any).assistantInbox.list().find((item: any) => item.messageId === 'stop-message-two')).toMatchObject({ state: 'queued' })
    expect((await host.listConversations()).every(item => !item.activeRunId)).toBe(true)
  } finally {
    release()
    await stopping
    await (server as any).assistantPump
    await server.stop()
    await host.close()
    send.mockRestore()
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, process.platform === 'win32' ? 120_000 : 30_000)

it('waits for work result integration to finish before closing workspace resources', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-h5-stop-result-'))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false }, mockResponse: 'done' })
  const server = new H5Server(host, { dataDir: join(cwd, 'data'), host: '127.0.0.1', port: 0 })
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const finishing = new Promise<void>(resolve => { entered = resolve })
  const finish = vi.spyOn(H5WorkspaceManager.prototype, 'finish').mockImplementation(async () => { entered(); await barrier; return { status: 'pending' } })
  let stopping: Promise<void> | undefined
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const auth = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: auth.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ cwd, name: 'Shutdown fixture' }) }).then(r => r.json()) as { id: string }
    const conversation = await host.createConversation({ cwd, projectId: project.id })
    const sent = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Reply with done' }) })
    expect(sent.status).toBe(200); await sent.text()
    await finishing
    let stopped = false
    stopping = server.stop().then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(stopped, 'shutdown must join result integration after model completion').toBe(false)
    release(); await stopping
    expect(finish).toHaveBeenCalledOnce()
  } finally {
    release(); await stopping; await server.stop(); await host.close(); finish.mockRestore()
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, process.platform === 'win32' ? 120_000 : 30_000)
