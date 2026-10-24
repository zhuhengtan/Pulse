import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRichContent, type RichContent } from '../packages/server/src/rich-content.js'
import { AssistantConversationStore } from '../packages/server/src/h5/assistant.js'
import { createLocalHost } from '../packages/server/src/index.js'
const rich: RichContent = { version: 1, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文', marks: [{ type: 'bold' }] }, { type: 'fileChip', attrs: { id: '中文目录/设计 文档.md', label: '设计 文档.md' } }] }] } }
describe('rich presentation persistence', () => {
  it('round trips durable assistant inbox, retry and transcript and rejects a conflicting document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-rich-inbox-'))
    const store = new AssistantConversationStore(dir), restored = new AssistantConversationStore(dir)
    try {
      await store.init(async () => 'assistant-rich')
      const input = { requestId: 'rich-assistant-01', text: '**正文** @中文目录/设计 文档.md', richContent: rich, mentionedFiles: ['中文目录/设计 文档.md'] }
      const first = await store.enqueue(input)
      expect(first.message.richContent).toEqual(rich)
      expect((await store.enqueue(input)).duplicate).toBe(true)
      await expect(store.enqueue({ ...input, richContent: { version: 1, document: { type: 'doc', content: [{ type: 'paragraph' }] } } })).rejects.toThrow('REQUEST_ID_REUSED')
      await store.next()
      await restored.init(async () => 'must-not-create')
      expect(restored.transcript()[0]?.richContent).toEqual(rich)
      expect((await restored.retry(input.requestId, input.text, undefined, undefined, input.mentionedFiles, rich)).message.richContent).toEqual(rich)
    } finally { await store.close(); await restored.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('persists a regular work message through host restart and keeps model text independent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-rich-host-'))
    const options = { cwd: dir, dataDir: dir, taskController: false, jarvis: { enabled: false }, mockResponse: 'confirmed' }
    const host = createLocalHost(options)
    let reopened: ReturnType<typeof createLocalHost> | undefined
    try {
      await host.init(); const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '**正文** @中文目录/设计 文档.md', requestId: 'rich-work-01', richContent: rich })
      for await (const _event of run.events) { /* Drain real host mock-provider execution. */ }
      expect((await host.getConversationMessages(conversation.id)).find(message => message.role === 'user')?.richContent).toEqual(rich)
      await host.close(); reopened = createLocalHost(options); await reopened.init()
      expect((await reopened.getMessagePage(conversation.id)).items.find(message => message.role === 'user')?.richContent).toEqual(rich)
    } finally { await reopened?.close(); await host.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })
  it('bounds and copies presentation data without admitting arbitrary attributes or unsafe schemes', () => {
    const input = structuredClone(rich); input.document.content![0]!.attrs = { onclick: 'bad' }
    expect(parseRichContent(input)).toEqual(rich)
    expect(parseRichContent(undefined)).toBeUndefined()
    expect(() => parseRichContent({ ...rich, version: 2 })).toThrow('RICH_CONTENT_INVALID')
    expect(() => parseRichContent({ version: 1, document: { type: 'doc', content: [{ type: 'text', text: 'invalid root child' }] } })).toThrow()
    const dangerous = structuredClone(rich); dangerous.document.content![0]!.content![0]!.marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
    expect(() => parseRichContent(dangerous)).toThrow()
  })
})
