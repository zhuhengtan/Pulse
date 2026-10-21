import { createRequestId } from './requestId.js'
import { ApiError, apiJson, jsonRequest, type PulseWebTransport, type WebConversation, type WebRunSnapshot } from './transport.js'
import type { ComposerPayload } from './RichComposer.js'

export type FollowupBehavior = 'queue' | 'immediate'
export const followupStorageKey = 'pulse-web-followup-behavior'
export function readFollowupBehavior(): FollowupBehavior {
  try { return localStorage.getItem(followupStorageKey) === 'immediate' ? 'immediate' : 'queue' } catch { return 'queue' }
}
export function saveFollowupBehavior(value: FollowupBehavior): void {
  localStorage.setItem(followupStorageKey, value)
  window.dispatchEvent(new Event('pulse-followup-change'))
}
export interface QueueEntry {
  requestId: string
  payload: ComposerPayload
  createdAt: string
  sending?: boolean
  immediate?: boolean
}
export interface ConversationQueue {
  key: string
  scope: string
  conversationId: string
  surface: 'chat' | 'work'
  entries: QueueEntry[]
  paused: boolean
  error?: string
  awaitingRunId?: string
  lease?: { owner: string; until: number }
}
export interface QueueStore {
  list(scope: string): Promise<ConversationQueue[]>
  update(key: string, change: (current: ConversationQueue | undefined) => ConversationQueue): Promise<ConversationQueue>
}

/** Transactions also protect against lost updates from other browser tabs. */
export class IndexedMessageQueueStore implements QueueStore {
  private database: Promise<IDBDatabase> | undefined
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('pulse-message-queue', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('queues', { keyPath: 'key' })
      request.onerror = () => { this.database = undefined; reject(request.error) }
      request.onblocked = () => { this.database = undefined; reject(new Error('队列缓存暂时不可用')) }
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined }
        resolve(request.result)
      }
    })
  }
  async list(scope: string): Promise<ConversationQueue[]> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queues', 'readonly'), request = tx.objectStore('queues').getAll()
      tx.oncomplete = () => resolve((request.result as ConversationQueue[]).filter(item => item.scope === scope))
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  async update(key: string, change: (current: ConversationQueue | undefined) => ConversationQueue): Promise<ConversationQueue> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queues', 'readwrite'), store = tx.objectStore('queues'), request = store.get(key)
      let result: ConversationQueue
      request.onsuccess = () => {
        try { result = change(request.result as ConversationQueue | undefined); store.put(result) }
        catch (error) { tx.abort(); reject(error) }
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('队列缓存写入失败'))
    })
  }
}

export interface QueueRunState { activeRunId?: string; waiting: boolean; state?: WebRunSnapshot['state'] }
export interface QueueAdapter {
  inspect(queue: ConversationQueue): Promise<QueueRunState>
  send(queue: ConversationQueue, entry: QueueEntry): Promise<{ runId: string }>
  accepted?(queue: ConversationQueue, entry: QueueEntry, runId: string): void
}
export function queueAdapter(transport: PulseWebTransport, accepted?: QueueAdapter['accepted']): QueueAdapter {
  return {
    async inspect(queue) {
      const conversation = queue.surface === 'chat'
        ? (await apiJson<{ conversation: WebConversation }>(transport, '/api/assistant')).conversation
        : await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(queue.conversationId)}`)
      const runId = conversation.activeRunId ?? queue.awaitingRunId
      if (!runId) return { waiting: false }
      const snapshot = await apiJson<WebRunSnapshot>(transport, `/api/runs/${encodeURIComponent(runId)}/state`)
      return { ...(conversation.activeRunId ? { activeRunId: conversation.activeRunId } : {}), waiting: Boolean(snapshot.waiting || snapshot.interactions?.length), state: snapshot.state }
    },
    async send(queue, entry) {
      return apiJson(transport, queue.surface === 'chat' ? '/api/assistant/messages' : `/api/conversations/${encodeURIComponent(queue.conversationId)}/messages`, jsonRequest('POST', {
        ...entry.payload, requestId: entry.requestId, delivery: entry.immediate ? 'immediate' : 'whenIdle',
      }))
    },
    ...(accepted ? { accepted } : {}),
  }
}

/** Lives above the selected conversation. Never observes or submits ask answers. */
export class MessageQueueController {
  private owner = createRequestId('queue')
  private ticking = false
  private closed = false
  constructor(readonly scope: string, private store: QueueStore, private adapter: QueueAdapter, private changed: (items: ConversationQueue[]) => void) {}
  key(conversationId: string): string { return JSON.stringify([this.scope, conversationId]) }
  async refresh(): Promise<void> { if (!this.closed) this.changed(await this.store.list(this.scope)) }
  close(): void { this.closed = true }
  async enqueue(conversationId: string, surface: 'chat' | 'work', payload: ComposerPayload, runId?: string, requestId = createRequestId('queue')): Promise<void> {
    const entry: QueueEntry = { requestId, payload: structuredClone(payload), createdAt: new Date().toISOString() }
    await this.store.update(this.key(conversationId), current => ({
      ...(current ?? { key: this.key(conversationId), scope: this.scope, conversationId, surface, entries: [], paused: false }),
      entries: current?.entries.some(item => item.requestId === requestId) ? current.entries : [...(current?.entries ?? []), entry],
      ...(!current?.awaitingRunId && runId ? { awaitingRunId: runId } : {}),
    }))
    await this.refresh().catch(() => undefined)
  }
  async change(conversationId: string, update: (queue: ConversationQueue) => ConversationQueue): Promise<void> {
    await this.store.update(this.key(conversationId), current => { if (!current) throw new Error('队列不存在'); return update(current) })
    await this.refresh()
  }
  async pause(conversationId: string, paused: boolean): Promise<void> {
    await this.change(conversationId, queue => {
      const { error: _error, awaitingRunId, ...rest } = queue
      // Explicit resume acknowledges the failed/stopped barrier; still inspect any active run.
      return { ...rest, ...(paused && awaitingRunId ? { awaitingRunId } : {}), paused }
    })
  }
  async remove(conversationId: string, requestId: string): Promise<void> {
    await this.change(conversationId, queue => ({ ...queue, entries: queue.entries.filter(item => item.requestId !== requestId || item.sending) }))
  }
  async edit(conversationId: string, requestId: string, text: string): Promise<void> {
    await this.change(conversationId, queue => ({ ...queue, entries: queue.entries.map(item => item.requestId === requestId && !item.sending ? { ...item, payload: { ...item.payload, text } } : item) }))
  }
  async sendNow(conversationId: string, requestId: string): Promise<void> {
    await this.change(conversationId, queue => ({ ...queue, entries: queue.entries.map(item => item.requestId === requestId && !item.sending ? { ...item, immediate: true } : item) }))
    await this.tick()
  }
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return
    this.ticking = true
    try {
      for (const queue of await this.store.list(this.scope)) {
        if (this.closed) break
        if (!queue.entries.length || queue.paused && !queue.entries.some(item => item.immediate)) continue
        await this.dispatch(queue)
      }
      await this.refresh()
    } finally { this.ticking = false }
  }
  private async dispatch(initial: ConversationQueue): Promise<void> {
    let claimed = false
    const claim = await this.store.update(initial.key, current => {
      const queue = current!
      if (queue.lease && queue.lease.owner !== this.owner && queue.lease.until > Date.now()) return queue
      claimed = true
      return { ...queue, lease: { owner: this.owner, until: Date.now() + 30_000 } }
    })
    if (!claimed) return
    const heartbeat = setInterval(() => { void this.store.update(initial.key, queue => queue?.lease?.owner === this.owner ? { ...queue, lease: { owner: this.owner, until: Date.now() + 30_000 } } : queue!).catch(() => undefined) }, 5000)
    try {
      const immediate = claim.entries.find(item => item.immediate)
      if (claim.paused && !immediate || !claim.entries.length) return
      const entry = immediate ?? claim.entries[0]!
      if (!entry.immediate && !entry.sending) {
        const state = await this.adapter.inspect(claim)
        if (state.state && ['failed', 'cancelled', 'interrupted'].includes(state.state)) {
          await this.change(claim.conversationId, queue => ({ ...queue, paused: true, error: '上轮未成功完成，队列已暂停。' })); return
        }
        if (state.activeRunId || state.waiting || state.state === 'running') {
          if (state.activeRunId && state.activeRunId !== claim.awaitingRunId) await this.change(claim.conversationId, queue => ({ ...queue, awaitingRunId: state.activeRunId! }))
          return
        }
        if (claim.awaitingRunId && state.state !== 'succeeded') {
          await this.change(claim.conversationId, queue => ({ ...queue, paused: true, error: '上轮未成功完成，队列已暂停。' })); return
        }
      }
      // Persist the attempt before the network request. Unknown outcomes retry the same ID.
      let allowed = false
      const sending = await this.store.update(claim.key, queue => {
        if (!queue || queue.lease?.owner !== this.owner || queue.paused && !entry.immediate || !queue.entries.some(item => item.requestId === entry.requestId)) return queue!
        allowed = true
        return { ...queue, entries: queue.entries.map(item => item.requestId === entry.requestId ? { ...item, sending: true } : item) }
      })
      if (!allowed || this.closed) return
      const attempt = sending.entries.find(item => item.requestId === entry.requestId)!
      const receipt = await this.adapter.send(sending, attempt)
      await this.store.update(claim.key, queue => {
        const { error: _error, ...rest } = queue!
        return { ...rest, awaitingRunId: receipt.runId, entries: rest.entries.filter(item => item.requestId !== entry.requestId) }
      })
      this.adapter.accepted?.(sending, attempt, receipt.runId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.detail === 'CONVERSATION_BUSY') {
        await this.change(claim.conversationId, queue => ({ ...queue, entries: queue.entries.map(item => ({ ...item, sending: false })) }))
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        await this.change(claim.conversationId, queue => ({ ...queue, paused: true, entries: queue.entries.map(item => ({ ...item, sending: false })), error: '消息未发送，内容已保留。请检查后继续队列。' }))
      }
      // Network errors and server restarts retain the durable attempt for idempotent replay.
    } finally {
      clearInterval(heartbeat)
      await this.store.update(initial.key, queue => {
        if (queue?.lease?.owner !== this.owner) return queue!
        const { lease: _lease, ...rest } = queue
        return rest
      })
    }
  }
}
