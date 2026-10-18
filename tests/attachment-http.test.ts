import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '@hunterzhu/pulse-server'

it('coalesces work retries by requestId and refuses reuse for a different payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-upload-http-'))
  const host = createLocalHost({ cwd: dir, dataDir: dir, taskController: false, mockResponse: 'ok' })
  const server = new H5Server(host, { dataDir: dir, host: '127.0.0.1', port: 0 })
  try {
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const headers = { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }
    const conversation = await host.createConversation(), send = vi.spyOn(host, 'sendMessage')
    const body = { text: '', requestId: 'request-upload-once', attachments: [{ id: 'attachment-once', name: 'notes.txt', type: 'file', size: 3, mediaType: 'text/plain', data: Buffer.from('abc').toString('base64') }] }
    const post = (value: unknown) => fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify(value) })
    const responses = await Promise.all([post(body), post(body)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const ids = await Promise.all(responses.map(response => response.json()))
    expect(ids[0].runId).toBe(ids[1].runId); expect(send).toHaveBeenCalledTimes(1)
    const next = await post(body); expect(next.status).toBe(200); expect((await next.json()).runId).toBe(ids[0].runId)
    expect((await post({ ...body, text: 'different request' })).status).toBe(409)
    const messages = await host.getConversationMessages(conversation.id)
    expect(messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(messages.find(message => message.role === 'user')?.attachments?.[0]).toMatchObject({ id: 'attachment-once', name: 'notes.txt' })
    await vi.waitFor(() => expect((server as unknown as { activeRuns: Map<string, unknown> }).activeRuns.size).toBe(0), { timeout: 5000 })
  } finally { await server.stop(); await host.close(); await rm(dir, { recursive: true, force: true }) }
})
