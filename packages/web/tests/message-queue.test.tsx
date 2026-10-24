import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/transport.js'
import { MessageQueueController, readFollowupBehavior, saveFollowupBehavior, type ConversationQueue, type QueueAdapter, type QueueEntry, type QueueRunState, type QueueStore } from '../src/MessageQueue.js'

class MemoryStore implements QueueStore {
  values = new Map<string, ConversationQueue>()
  async list(scope: string) { return structuredClone([...this.values.values()].filter(item => item.scope === scope)) }
  async update(key: string, change: (queue: ConversationQueue | undefined) => ConversationQueue) {
    const next = change(structuredClone(this.values.get(key))); this.values.set(key, structuredClone(next)); return next
  }
}
function fixture() {
  const store = new MemoryStore(), sent: QueueEntry[] = []
  let state: QueueRunState = { waiting: false }
  const adapter: QueueAdapter = {
    inspect: async () => state,
    send: async (_queue, entry) => { sent.push(structuredClone(entry)); const runId = `run-${sent.length}`; state = { waiting: false, activeRunId: runId, state: 'running' }; return { runId } },
  }
  const controller = new MessageQueueController('service-one', store, adapter, () => {})
  return { store, sent, adapter, controller, state: (next: QueueRunState) => { state = next }, queue: () => store.values.get(controller.key('conversation'))! }
}
describe('durable frontend message queue', () => {
  it('defaults to queue and saves a frontend-only preference', () => {
    localStorage.clear(); expect(readFollowupBehavior()).toBe('queue')
    saveFollowupBehavior('immediate'); expect(readFollowupBehavior()).toBe('immediate'); localStorage.clear()
  })
  it('preserves the complete payload and dispatches FIFO only after release and success', async () => {
    const f = fixture()
    const payload = { richContent: { version: 1 as const, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first', marks: [{ type: 'bold' }] }] }] } }, text: 'first', attachments: [{ id: 'attachment', name: 'note.txt', type: 'file' as const, size: 4, mediaType: 'text/plain', data: 'data:text/plain;base64,dGVzdA==' }], skills: ['skill'], mentionedFiles: ['file.ts'] }
    await f.controller.enqueue('conversation', 'work', payload, 'previous')
    await f.controller.enqueue('conversation', 'work', { text: 'second' }, 'previous')
    payload.text = 'new draft'
    f.state({ state: 'running', activeRunId: 'previous', waiting: false }); await f.controller.tick(); expect(f.sent).toHaveLength(0)
    f.state({ state: 'succeeded', activeRunId: 'previous', waiting: false }); await f.controller.tick(); expect(f.sent).toHaveLength(0)
    f.state({ state: 'succeeded', waiting: false }); await f.controller.tick()
    expect(f.sent[0]?.payload).toEqual({ ...payload, text: 'first' }); expect(f.queue().entries).toHaveLength(1)
    await f.controller.tick(); expect(f.sent).toHaveLength(1)
    f.state({ state: 'succeeded', waiting: false }); await f.controller.tick()
    expect(f.sent.map(item => item.payload.text)).toEqual(['first', 'second'])
  })
  it('atomically replaces rich content, serialized text and references during queue edits', async () => {
    const f = fixture()
    await f.controller.enqueue('conversation', 'work', { text: 'old', skills: ['old-skill'], mentionedFiles: ['old.ts'] })
    const id = f.queue().entries[0]!.requestId
    const payload = { text: '**new** @中文/文件.md', richContent: { version: 1 as const, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new', marks: [{ type: 'bold' }] }, { type: 'fileChip', attrs: { id: '中文/文件.md', label: '文件.md' } }] }] } }, mentionedFiles: ['中文/文件.md'] }
    await f.controller.edit('conversation', id, payload)
    expect(f.queue().entries[0]!.payload).toEqual(payload)
    f.controller.close()
    const restored = new MessageQueueController('service-one', f.store, f.adapter, () => {})
    await restored.tick(); expect(f.sent[0]!.payload).toEqual(payload); restored.close()
  })
  it('never drains when ask is waiting or its answer has merely been accepted', async () => {
    const f = fixture(); await f.controller.enqueue('conversation', 'chat', { text: 'not an ask answer' }, 'active')
    f.state({ state: 'running', activeRunId: 'active', waiting: true }); await f.controller.tick()
    f.state({ state: 'running', activeRunId: 'active', waiting: false }); await f.controller.tick()
    expect(f.sent).toEqual([]); expect(f.queue().entries[0]?.payload.text).toBe('not an ask answer')
    f.state({ state: 'succeeded', waiting: true }); await f.controller.tick(); expect(f.sent).toEqual([])
    f.state({ state: 'succeeded', waiting: false }); await f.controller.tick(); expect(f.sent).toHaveLength(1)
  })
  it.each(['failed', 'cancelled', 'interrupted'] as const)('pauses after %s and resumes only by explicit action', async state => {
    const f = fixture(); await f.controller.enqueue('conversation', 'work', { text: 'next' }, 'old')
    f.state({ state, waiting: false }); await f.controller.tick(); expect(f.queue().paused).toBe(true); expect(f.sent).toHaveLength(0)
    f.state({ waiting: false }); await f.controller.tick(); expect(f.sent).toHaveLength(0)
    await f.controller.pause('conversation', false); await f.controller.tick(); expect(f.sent).toHaveLength(1)
  })
  it('replays an unknown delivery using the same ID after reload, before advancing', async () => {
    const f = fixture(), attempts: string[] = []; let fail = true
    f.adapter.send = async (_queue, entry) => { attempts.push(entry.requestId); if (fail) { fail = false; throw new Error('response lost') } return { runId: 'accepted-run' } }
    await f.controller.enqueue('conversation', 'chat', { text: 'once' }); await f.controller.enqueue('conversation', 'chat', { text: 'later' })
    await f.controller.tick(); expect(f.queue().entries[0]?.sending).toBe(true); f.controller.close()
    f.state({ state: 'running', activeRunId: 'accepted-run', waiting: false })
    const restored = new MessageQueueController('service-one', f.store, f.adapter, () => {})
    await restored.tick(); expect(attempts).toEqual([attempts[0], attempts[0]]); expect(f.queue().entries.map(item => item.payload.text)).toEqual(['later'])
    await restored.tick(); expect(attempts).toHaveLength(2)
  })
  it('leases across tabs prevent duplicate delivery during a pending request', async () => {
    const f = fixture(); let release!: () => void
    f.adapter.send = async (_queue, entry) => { f.sent.push(entry); await new Promise<void>(resolve => { release = resolve }); return { runId: 'one' } }
    await f.controller.enqueue('conversation', 'work', { text: 'once' })
    const first = f.controller.tick(); while (!release) await Promise.resolve()
    const other = new MessageQueueController('service-one', f.store, f.adapter, () => {}); await other.tick(); expect(f.sent).toHaveLength(1)
    release(); await first; expect(f.queue().entries).toHaveLength(0)
  })
  it('rejects stale edits after another tab has started delivery', async () => {
    const f = fixture(); let release!: () => void
    f.adapter.send = async () => { await new Promise<void>(resolve => { release = resolve }); return { runId: 'one' } }
    await f.controller.enqueue('conversation', 'work', { text: 'original', skills: ['keep'] })
    const requestId = f.queue().entries[0]!.requestId
    const sending = f.controller.tick(); while (!release) await Promise.resolve()
    const other = new MessageQueueController('service-one', f.store, f.adapter, () => {})
    await expect(other.edit('conversation', requestId, 'late edit')).rejects.toThrow()
    expect(f.queue().entries[0]?.payload).toEqual({ text: 'original', skills: ['keep'] })
    release(); await sending
    await expect(other.edit('conversation', requestId, 'missing')).rejects.toThrow()
  })
  it('immediate sends only the selected entry and retains pause, attachments and remaining order', async () => {
    const f = fixture(); await f.controller.enqueue('conversation', 'work', { text: 'one', skills: ['keep'] })
    await f.controller.enqueue('conversation', 'work', { text: 'two' }); await f.controller.enqueue('conversation', 'work', { text: 'three' })
    const [first, second] = f.queue().entries
    await f.controller.edit('conversation', first!.requestId, 'edited'); expect(f.queue().entries[0]?.payload.skills).toEqual(['keep'])
    await f.controller.pause('conversation', true); f.state({ activeRunId: 'running', state: 'running', waiting: true })
    await f.controller.sendNow('conversation', second!.requestId)
    expect(f.sent.map(item => item.payload.text)).toEqual(['two']); expect(f.sent[0]?.immediate).toBe(true)
    expect(f.queue().paused).toBe(true); expect(f.queue().entries.map(item => item.payload.text)).toEqual(['edited', 'three'])
    await f.controller.remove('conversation', first!.requestId); expect(f.queue().entries.map(item => item.payload.text)).toEqual(['three'])
  })
  it('does not share queues between service instances and dispatches unselected conversations', async () => {
    const f = fixture(); await f.controller.enqueue('conversation', 'work', { text: 'background' })
    const other = new MessageQueueController('other-service', f.store, f.adapter, () => {}); await other.tick(); expect(f.sent).toHaveLength(0)
    await f.controller.tick(); expect(f.sent).toHaveLength(1)
  })
  it('retains messages on busy races and pauses on rejected payloads', async () => {
    const f = fixture(); await f.controller.enqueue('conversation', 'work', { text: 'keep' })
    f.adapter.send = async () => { throw new ApiError(409, 'CONVERSATION_BUSY') }
    await f.controller.tick(); expect(f.queue().entries).toHaveLength(1); expect(f.queue().paused).toBe(false)
    f.adapter.send = async () => { throw new ApiError(400, 'INVALID') }
    await f.controller.tick(); expect(f.queue().paused).toBe(true); expect(f.queue().entries).toHaveLength(1)
  })
  it('fails enqueue when durable storage fails', async () => {
    const store: QueueStore = { list: async () => [], update: async () => { throw new Error('quota') } }
    const f = fixture(), controller = new MessageQueueController('service', store, f.adapter, () => {})
    await expect(controller.enqueue('conversation', 'chat', { text: 'preserve draft' })).rejects.toThrow('quota'); expect(f.sent).toHaveLength(0)
  })
})
