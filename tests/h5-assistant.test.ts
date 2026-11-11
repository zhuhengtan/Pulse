import { ConversationData } from '../packages/data/src/index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'
import { assistantChatAllowedToolNames } from '../packages/server/src/index.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('assistant inbox', () => {
  it('deduplicates stable request IDs and preserves FIFO order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-assistant-inbox-'))
    directories.push(dir)
    const store = new AssistantConversationStore(dir)
    await store.init(async () => 'assistant-conversation')
    const first = await store.enqueue({ requestId: 'request-first-1', text: 'first' })
    const duplicate = await store.enqueue({ requestId: 'request-first-1', text: 'first' })
    const second = await store.enqueue({ requestId: 'request-second-2', text: 'second' })
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.message.runId).toBe(first.message.runId)
    expect((await store.next())?.messageId).toBe(first.message.messageId)
    expect((await store.next())?.messageId).toBe(second.message.messageId)
    await store.close()
  })

  it('does not replay an interrupted reply after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-assistant-recovery-'))
    directories.push(dir)
    const store = new AssistantConversationStore(dir)
    await store.init(async () => 'assistant-conversation')
    const active = await store.enqueue({ requestId: 'request-active-1', text: 'active' })
    await store.enqueue({ requestId: 'request-queued-2', text: 'queued' })
    await store.next()
    const restored = new AssistantConversationStore(dir)
    await restored.init(async () => 'should-not-create')
    expect(restored.receiptByRun(active.message.runId)?.state).toBe('interrupted')
    expect(restored.hasQueued()).toBe(true)
    const data = new ConversationData(dir)
    expect((await data.call<{ conversationId: string }>('readState', 'assistant-inbox')).conversationId).toBe('assistant-conversation')
    await data.close(); await store.close(); await restored.close()
  })
})

describe('assistant tool availability', () => {
  const names = ['fs.read', 'jarvis.context', 'work.start', 'work.list', 'work.status']

  it('presents the configured tools for the model to choose and prevents repeated delegation', () => {
    expect(assistantChatAllowedToolNames(names, new Set())).toEqual(names)
    expect(assistantChatAllowedToolNames(names, new Set(['work.list', 'work.start'])))
      .toEqual(['fs.read', 'jarvis.context', 'work.list', 'work.status'])
  })
})
