import type { WebRunEvent } from '../protocol.js'
import { createHash } from 'node:crypto'

export interface TaskNotice {
  id: string
  runId: string
  conversationId: string
  kind: 'complete' | 'ask' | 'approval'
  surface?: 'chat' | 'work'
  groupId?: string
  createdAt: number
  revision?: string
  readAt?: number
}

/** Pending questions survive history eviction; only finished history is bounded. */
export class TaskNoticeInbox {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private read: () => Promise<TaskNotice[] | undefined>, private write: (items: TaskNotice[]) => Promise<unknown>, private pending?: (item: TaskNotice) => Promise<boolean>) {}
  list(): Promise<TaskNotice[]> {
    const work = this.tail.catch(() => undefined).then(async () => {
      const original = await this.read() ?? []
      const items = this.migrate(original)
      const valid: TaskNotice[] = []
      for (const item of items) if (item.kind === 'complete' || !this.pending || await this.pending(item).catch(() => true)) valid.push(item)
      const next = this.trim(valid)
      if (JSON.stringify(next) !== JSON.stringify(original)) await this.write(next)
      return next
    })
    this.tail = work
    return work
  }
  private migrate(items: TaskNotice[]): TaskNotice[] {
    return items.map(item => item.revision ? item : { ...item, revision: 'legacy', ...(item.kind === 'complete' ? { readAt: item.createdAt } : {}) })
  }
  markRead(targets: Array<{ id: string; revision: string }>): Promise<void> {
    const work = this.tail.catch(() => undefined).then(async () => {
      const items = this.migrate(await this.read() ?? [])
      const now = Date.now()
      await this.write(items.map(item => !item.readAt && targets.some(target => target.id === item.id && target.revision === item.revision) ? { ...item, readAt: now } : item))
    })
    this.tail = work
    return work
  }
  private trim(items: TaskNotice[]): TaskNotice[] {
    const completed = new Set(items.filter(item => item.kind === 'complete').map(item => item.runId))
    const finished = items.filter(item => item.kind === 'complete')
    const recent = new Set(finished.slice(-200).map(item => item.id))
    const history = finished.filter(item => !item.readAt || recent.has(item.id))
    return [...items.filter(item => item.kind !== 'complete' && !completed.has(item.runId)), ...history]
  }
  record(event: WebRunEvent, surface: 'chat' | 'work' = 'work'): Promise<unknown> {
    const conversationId = event.conversationId
    if (!conversationId || (event.type !== 'complete' && event.type !== 'interactions')) return Promise.resolve()
    const added: TaskNotice[] = event.type === 'complete'
      ? [{ id: `complete:${event.runId}`, revision: 'complete', runId: event.runId, conversationId, surface, kind: 'complete', createdAt: Date.now() }]
      : event.data.interactions.map(group => ({ id: `interaction:${event.runId}:${group.groupId}`, revision: createHash('sha256').update(JSON.stringify(group)).digest('hex'), runId: event.runId, conversationId, surface, kind: group.kind, groupId: group.groupId, createdAt: Date.now() }))
    const work = this.tail.catch(() => undefined).then(async () => {
      const items = this.migrate(await this.read() ?? [])
      const retained = items.filter(item => item.runId !== event.runId || item.kind === 'complete')
      const ids = new Set(retained.map(item => item.id))
      const next = this.trim([...retained, ...added.filter(item => !ids.has(item.id)).map(item => items.find(previous => previous.id === item.id && previous.revision === item.revision) ?? item)])
      if (JSON.stringify(next) !== JSON.stringify(items)) await this.write(next)
    })
    this.tail = work
    return work
  }
}
