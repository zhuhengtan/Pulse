import type { WebRunEvent } from '../protocol.js'

export interface TaskNotice {
  id: string
  runId: string
  conversationId: string
  kind: 'complete' | 'ask' | 'approval'
  surface?: 'chat' | 'work'
  groupId?: string
  createdAt: number
}

/** Pending questions survive history eviction; only finished history is bounded. */
export class TaskNoticeInbox {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private read: () => Promise<TaskNotice[] | undefined>, private write: (items: TaskNotice[]) => Promise<unknown>, private pending?: (item: TaskNotice) => Promise<boolean>) {}
  list(): Promise<TaskNotice[]> {
    const work = this.tail.catch(() => undefined).then(async () => {
      const items = await this.read() ?? []
      const valid: TaskNotice[] = []
      for (const item of items) if (item.kind === 'complete' || !this.pending || await this.pending(item).catch(() => true)) valid.push(item)
      const next = this.trim(valid)
      if (JSON.stringify(next) !== JSON.stringify(items)) await this.write(next)
      return next
    })
    this.tail = work
    return work
  }
  private trim(items: TaskNotice[]): TaskNotice[] {
    const completed = new Set(items.filter(item => item.kind === 'complete').map(item => item.runId))
    const history = items.filter(item => item.kind === 'complete').slice(-200)
    return [...items.filter(item => item.kind !== 'complete' && !completed.has(item.runId)), ...history]
  }
  record(event: WebRunEvent, surface: 'chat' | 'work' = 'work'): Promise<unknown> {
    const conversationId = event.conversationId
    if (!conversationId || (event.type !== 'complete' && event.type !== 'interactions')) return Promise.resolve()
    const added: TaskNotice[] = event.type === 'complete'
      ? [{ id: `complete:${event.runId}`, runId: event.runId, conversationId, surface, kind: 'complete', createdAt: Date.now() }]
      : event.data.interactions.map(group => ({ id: `interaction:${event.runId}:${group.groupId}`, runId: event.runId, conversationId, surface, kind: group.kind, groupId: group.groupId, createdAt: Date.now() }))
    const work = this.tail.catch(() => undefined).then(async () => {
      const items = await this.read() ?? []
      const retained = items.filter(item => item.runId !== event.runId || item.kind === 'complete')
      const ids = new Set(retained.map(item => item.id))
      const next = this.trim([...retained, ...added.filter(item => !ids.has(item.id)).map(item => items.find(previous => previous.id === item.id) ?? item)])
      if (JSON.stringify(next) !== JSON.stringify(items)) await this.write(next)
    })
    this.tail = work
    return work
  }
}
