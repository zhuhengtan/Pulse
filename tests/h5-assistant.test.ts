import { ConversationData } from '../packages/data/src/index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'
import { assistantChatAllowedToolNames, assistantChatRequiredToolNames, assistantExplicitToolRequests } from '../packages/server/src/index.js'

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

describe('assistant explicit tool routing', () => {
  const names = ['fs.read', 'jarvis.context', 'work.start', 'work.list', 'work.status']

  it('requires work.start and allows work.list to resolve its project prerequisite', () => {
    expect(assistantChatRequiredToolNames(names, '请通过 work.start 在 Pulse 项目启动工作会话，读取 packages/cli/package.json；若无法确认项目 ID，请先调用 work.list。'))
      .toEqual(['work.start', 'work.list'])
  })

  it('does not force a negated work tool and preserves the direct file-read route', () => {
    expect(assistantChatRequiredToolNames(names, '请读取 packages/cli/package.json；不要调用 work.start。'))
      .toEqual(['fs.read'])
  })

  it('recognizes explicit tool names wrapped in Markdown code ticks', () => {
    expect(assistantExplicitToolRequests(names, '请调用 `work.status` 查询状态。'))
      .toEqual(['work.status'])
  })

  it('recognizes a named work tool followed by its action without an invocation verb', () => {
    expect(assistantChatRequiredToolNames(names, '请用 work.list 确认 Pulse 项目 ID，然后 work.start 创建只读工作，读取 packages/cli/package.json 的 name 字段。'))
      .toEqual(['work.start', 'work.list'])
  })

  it('unlocks follow-up tools after all explicitly required tools have run', () => {
    const message = '请用 work.list 确认 Pulse 项目 ID，然后 work.start 创建只读工作。'
    expect(assistantChatAllowedToolNames(names, message, new Set(['work.list'])))
      .toEqual(['work.start'])
    expect(assistantChatAllowedToolNames(names, message, new Set(['work.list', 'work.start'])))
      .toEqual(['fs.read', 'jarvis.context', 'work.list', 'work.status'])
  })

  it('does not treat an explanation or a negated mention as a tool request', () => {
    expect(assistantExplicitToolRequests(names, '请解释 work.start 是什么，以及 work.list 做什么。'))
      .toEqual([])
    expect(assistantExplicitToolRequests(names, '不要调用 work.start，也不要 work.list。'))
      .toEqual([])
  })
})
