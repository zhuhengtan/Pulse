import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'
import { startChatAcknowledgement } from '../packages/server/src/chat-acknowledgement.js'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('does not acknowledge fast replies or publish after cancellation', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async () => {})
  const stop = startChatAcknowledgement(save)
  await vi.advanceTimersByTimeAsync(500); await stop(); await vi.advanceTimersByTimeAsync(2000)
  expect(save).not.toHaveBeenCalled()
})
it('publishes one acknowledgement while the detailed answer is pending', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async () => {})
  const stop = startChatAcknowledgement(save, async () => '我先看看。')
  await vi.advanceTimersByTimeAsync(1300)
  expect(save).toHaveBeenCalledWith('我先看看。'); expect(save).toHaveBeenCalledTimes(1)
  await stop(); await vi.advanceTimersByTimeAsync(5000)
  expect(save).toHaveBeenCalledTimes(1)
})
it('persists the pre-reply, merges a mid-generation supplement and never publishes the superseded answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-chat-reply-'))
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const requests: any[] = []
  vi.stubGlobal('fetch', async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body)); const first = requests.length === 1
    if (first) { entered(); await waiting }
    return Response.json({ choices: [{ message: { content: first ? '过时答案' : '已结合补充，用中文给出完整答案。' }, finish_reason: 'stop' }] })
  })
  const provider = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider, providerProfiles: { fixture: provider }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', jarvis: { enabled: false } })
  try {
    const conversation = await host.createConversation()
    const handle = await host.sendMessage(conversation.id, { text: '解释这个概念', assistantChat: true })
    const events = (async () => { for await (const _ of handle.events) {} })()
    await started
    await vi.waitFor(async () => expect((await host.getConversationMessages(conversation.id)).some(message => message.messageKind === 'pre_reply')).toBe(true), { timeout: 3000 })
    await handle.submitHumanInput('补充：请用中文。', undefined, { requestId: 'supplement-fixture' })
    release(); const outcome = await handle.outcome(); await events
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded')
    const messages = await host.getConversationMessages(conversation.id)
    expect(messages.filter(message => message.messageKind === 'pre_reply')).toHaveLength(1)
    expect(messages.some(message => message.text === '过时答案')).toBe(false)
    expect(messages.at(-1)?.text).toContain('已结合补充')
    expect(JSON.stringify(requests.at(-1))).toContain('补充：请用中文')
  } finally { release(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)
