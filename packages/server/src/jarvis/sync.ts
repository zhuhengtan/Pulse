import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CandidateMemoryInput } from './types.js'
import type { JarvisClient } from './client.js'

type SyncState = 'pending_sync' | 'synced' | 'candidate_review' | 'active' | 'archived' | 'failed'
interface SyncItem {
  requestId: string
  sessionId: string
  kind: 'event' | 'candidate'
  content: string
  sourceContent?: string
  eventType?: 'observation' | 'result'
  title?: string
  memoryKind?: CandidateMemoryInput['kind']
  scope?: 'global' | 'project'
  projectId?: string
  status: SyncState
  remoteId?: string
  remoteStatus?: string
  error?: string
  createdAt: string
  updatedAt: string
}
interface SyncFile { schemaVersion: 1; items: SyncItem[] }

/** Durable, idempotent outbox for assistant-initiated Jarvis writes. */
export class JarvisSyncQueue {
  private readonly path: string
  private state: SyncFile | undefined
  private tail: Promise<void> = Promise.resolve()
  private flushing: Promise<void> | undefined

  constructor(dataDir: string, private readonly client: JarvisClient) { this.path = resolve(dataDir, 'h5', 'jarvis-sync.json') }

  async init(): Promise<void> { await this.load() }

  async submitEvent(input: { requestId: string; sessionId: string; type: 'observation' | 'result'; content: string }): Promise<Record<string, unknown>> {
    const { type, ...event } = input
    const item = await this.insert({ ...event, eventType: type, kind: 'event' })
    queueMicrotask(() => { void this.flush() })
    return this.publicState(item)
  }

  async submitCandidate(input: { requestId: string; sessionId: string; scope: 'global' | 'project'; projectId?: string; candidate: CandidateMemoryInput; source: string }): Promise<Record<string, unknown>> {
    const item = await this.insert({
      requestId: input.requestId, sessionId: input.sessionId, kind: 'candidate', content: input.candidate.content,
      title: input.candidate.title, memoryKind: input.candidate.kind, scope: input.scope,
      ...(input.projectId ? { projectId: input.projectId } : {}), eventType: 'observation', sourceContent: input.source,
    })
    queueMicrotask(() => { void this.flush() })
    return this.publicState(item)
  }

  async status(id: string): Promise<Record<string, unknown> | undefined> {
    await this.load()
    const item = this.requireState().items.find(value => value.requestId === id || value.remoteId === id)
    if (!item) return undefined
    if (item.kind === 'candidate' && item.remoteId) {
      try {
        const active = await this.client.getMemory(item.remoteId)
        if (active) {
          item.status = active.status === 'archived' ? 'archived' : active.status === 'active' ? 'active' : item.status
          if (active.status) item.remoteStatus = active.status
          item.updatedAt = new Date().toISOString()
          await this.save()
        } else {
          const candidates = await this.client.listCandidates(item.scope === 'global' ? 'unassigned' : item.projectId)
          const candidate = candidates.find(value => value.id === item.remoteId)
          if (candidate) {
            if (candidate.status) item.remoteStatus = candidate.status
            item.status = candidate.status === 'archived' ? 'archived' : candidate.status === 'active' ? 'active' : 'candidate_review'
            item.updatedAt = new Date().toISOString()
            await this.save()
          }
        }
      } catch { /* Report the last durable receipt when Jarvis is offline. */ }
    }
    return this.publicState(item)
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      await this.load()
      for (;;) {
        const item = await this.serial(async () => {
          const next = this.requireState().items.find(value => value.status === 'pending_sync')
          return next ? structuredClone(next) : undefined
        })
        if (!item) return
        try {
          const source = await this.client.recordEvent(item.sessionId, item.eventType ?? 'observation', item.kind === 'candidate' ? `Candidate memory evidence: ${item.title}\n${item.sourceContent ?? item.content}` : item.content, `${item.requestId}:source`)
          let remoteId = source.id
          let remoteStatus = 'synced'
          let status: SyncState = 'synced'
          if (item.kind === 'candidate') {
            const candidate = await this.client.recordCandidate(item.sessionId, {
              scope: item.scope ?? 'global', kind: item.memoryKind ?? 'fact', title: item.title ?? 'Pulse memory',
              content: item.content, ...(source.id ? { sourceRefs: [source.id] } : []),
            }, `${item.requestId}:candidate`)
            remoteId = candidate.id
            remoteStatus = candidate.status ?? 'candidate'
            status = remoteStatus === 'active' ? 'active' : remoteStatus === 'archived' ? 'archived' : 'candidate_review'
          }
          await this.serial(async () => {
            const current = this.requireState().items.find(value => value.requestId === item.requestId)
            if (!current) return
            current.status = status
            current.remoteStatus = remoteStatus
            if (remoteId) current.remoteId = remoteId
            delete current.error
            current.updatedAt = new Date().toISOString()
            await this.save()
          })
        } catch (error) {
          await this.serial(async () => {
            const current = this.requireState().items.find(value => value.requestId === item.requestId)
            if (!current) return
            current.status = 'pending_sync'
            current.error = this.client.redactText(error instanceof Error ? error.message : String(error)).slice(0, 240)
            current.updatedAt = new Date().toISOString()
            await this.save()
          })
          return
        }
      }
    })().finally(() => { this.flushing = undefined })
    return this.flushing
  }

  private publicState(item: SyncItem): Record<string, unknown> {
    return { requestId: item.requestId, status: item.status, ...(item.remoteId ? { id: item.remoteId } : {}), ...(item.remoteStatus ? { jarvisStatus: item.remoteStatus } : {}), ...(item.error ? { error: item.error } : {}), updatedAt: item.updatedAt }
  }

  private async insert(input: Omit<SyncItem, 'status' | 'createdAt' | 'updatedAt'>): Promise<SyncItem> {
    await this.load()
    return this.serial(async () => {
      const existing = this.requireState().items.find(value => value.requestId === input.requestId)
      if (existing) return structuredClone(existing)
      // Only completed receipts may be removed. Never acknowledge new work by
      // discarding an older pending write or a candidate still under review.
      let toRemove = Math.max(0, this.requireState().items.length + 1 - 800)
      const retained = this.requireState().items.filter(value => {
        if (toRemove > 0 && ['synced', 'active', 'archived'].includes(value.status)) {
          toRemove--
          return false
        }
        return true
      })
      if (toRemove > 0) throw new Error('JARVIS_SYNC_QUEUE_FULL')
      const item: SyncItem = { ...input, content: this.client.redactText(input.content), ...(input.sourceContent ? { sourceContent: this.client.redactText(input.sourceContent) } : {}), ...(input.title ? { title: this.client.redactText(input.title) } : {}), status: 'pending_sync', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      const previous = this.requireState().items
      this.requireState().items = [...retained, item]
      try { await this.save() }
      catch (error) { this.requireState().items = previous; throw error }
      return structuredClone(item)
    })
  }

  private async load(): Promise<void> {
    if (this.state) return
    const saved = await readFile(this.path, 'utf8').then(text => JSON.parse(text) as SyncFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    this.state = saved?.schemaVersion === 1 && Array.isArray(saved.items) ? saved : { schemaVersion: 1, items: [] }
    for (const item of this.state.items) {
      const legacy = item as SyncItem & { type?: unknown }
      if (item.kind === 'event' && !item.eventType && (legacy.type === 'observation' || legacy.type === 'result')) item.eventType = legacy.type
    }
    if (!saved) await this.save()
  }

  private requireState(): SyncFile { if (!this.state) throw new Error('JARVIS_SYNC_NOT_INITIALIZED'); return this.state }

  private async save(): Promise<void> {
    const state = this.requireState()
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path) }
    finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolveTail => { release = resolveTail })
    await previous
    try { return await fn() } finally { release() }
  }
}
