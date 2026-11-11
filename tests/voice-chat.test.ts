import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
it('persists voice origin and links the final response through the ordinary assistant HTTP queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-voice-chat-'))
  const host = createLocalHost({ cwd: directory, dataDir: directory, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', mockResponse: 'Voice reply', jarvis: { enabled: false } })
  const server = new H5Server(host, { dataDir: directory, port: 0, host: '127.0.0.1' })
  try {
    await host.init(); const { port } = await server.start()
    const base = `http://127.0.0.1:${port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const cookie = session.headers.get('set-cookie')!
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }
    const send = () => fetch(`${base}/api/assistant/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Hello', requestId: 'voice-fixture-one', inputMode: 'voice', delivery: 'immediate' }) })
    expect((await send()).ok).toBe(true)
    let view: any
    await expect.poll(async () => { view = await fetch(`${base}/api/assistant`, { headers }).then(r => r.json()); const receipt = view.receipts?.find((r:any) => r.messageId === 'voice-fixture-one'); if(receipt?.state==='failed')throw new Error(receipt.error); return receipt?.state }, { timeout: 15000 }).toBe('completed')
    expect(view.messages.find((m:any) => m.id === 'msg-voice-fixture-one')).toMatchObject({ inputMode: 'voice', role: 'user' })
    expect(view.messages.find((m:any) => m.text === 'Voice reply')).toMatchObject({ replyToId: 'msg-voice-fixture-one', messageKind: 'reply' })
    await send()
    const after = await fetch(`${base}/api/assistant`, { headers }).then(r=>r.json())
    expect(after.receipts.filter((r:any) => r.messageId === 'voice-fixture-one')).toHaveLength(1)
  } finally { await server.stop(); await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 20000)
