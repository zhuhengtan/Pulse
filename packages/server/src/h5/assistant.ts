import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { replaceStateFile } from '../atomic-file.js'
import { dirname, resolve } from 'node:path'
import type { WebAssistantMessageReceipt, WebAttachment, WebMessage } from '../protocol.js'

export interface QueuedAssistantMessage extends WebAssistantMessageReceipt {
  text: string
  attachments?: WebAttachment[]
  skills?: string[]
  mentionedFiles?: string[]
}
interface AssistantQueueFile { schemaVersion: 1; conversationId: string; messages: QueuedAssistantMessage[]; notices?: WebMessage[]; workLinks?: Record<string, { projectId: string; title: string }> }

/** Durable inbox for the single assistant conversation. Entries marked replying at
 * process startup are interrupted rather than replayed because a tool may have run. */
export class AssistantConversationStore {
  private readonly path: string
  private state: AssistantQueueFile | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(dataDir: string) { this.path = resolve(dataDir, 'assistant-inbox.json') }

  async init(createConversation: () => Promise<string>): Promise<string> {
    if (!this.state) {
      const saved = await readFile(this.path, 'utf8').then(text => JSON.parse(text) as AssistantQueueFile).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      this.state = saved?.schemaVersion === 1 && typeof saved.conversationId === 'string' && Array.isArray(saved.messages)
        ? saved
        : { schemaVersion: 1, conversationId: await createConversation(), messages: [] }
      let changed = false
      for (const message of this.state.messages) if (message.state === 'replying') { message.state = 'interrupted'; message.error = '服务在回复期间停止；未自动重试'; message.updatedAt = new Date().toISOString(); changed = true }
      if (!saved || changed) await this.save()
    }
    return this.state.conversationId
  }

  get conversationId(): string {
    if (!this.state) throw new Error('ASSISTANT_STORE_NOT_INITIALIZED')
    return this.state.conversationId
  }

  async enqueue(input: { requestId: string; text: string; attachments?: WebAttachment[]; skills?: string[]; mentionedFiles?: string[] }): Promise<{ message: QueuedAssistantMessage; duplicate: boolean }> {
    return this.serial(async () => {
      const state = this.requireState()
      const existing = state.messages.find(item => item.messageId === input.requestId)
      if (existing) {
        if (existing.text !== input.text) throw new Error('REQUEST_ID_REUSED')
        return { message: structuredClone(existing), duplicate: true }
      }
      const now = new Date().toISOString()
      const message: QueuedAssistantMessage = {
        messageId: input.requestId,
        runId: `run-${randomUUID()}`,
        text: input.text,
        state: 'queued',
        createdAt: now,
        updatedAt: now,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.mentionedFiles ? { mentionedFiles: input.mentionedFiles } : {}),
      }
      state.messages.push(message)
      await this.save()
      return { message: structuredClone(message), duplicate: false }
    })
  }

  async retry(requestId: string, text: string, attachments?: WebAttachment[], skills?: string[], mentionedFiles?: string[]): Promise<{ message: QueuedAssistantMessage; duplicate: boolean }> {
    return this.serial(async () => {
      const state = this.requireState()
      const existing = state.messages.find(item => item.messageId === requestId)
      if (!existing) {
        const now = new Date().toISOString()
        const created: QueuedAssistantMessage = {
          messageId: requestId,
          runId: `run-${randomUUID()}`,
          text,
          state: 'queued',
          createdAt: now,
          updatedAt: now,
          ...(attachments ? { attachments } : {}),
          ...(skills ? { skills } : {}),
          ...(mentionedFiles ? { mentionedFiles } : {}),
        }
        state.messages.push(created)
        await this.save()
        return { message: structuredClone(created), duplicate: false }
      }
      if (existing.text !== text) throw new Error('REQUEST_ID_REUSED')
      if (existing.state === 'queued' || existing.state === 'replying') return { message: structuredClone(existing), duplicate: true }
      if (existing.state === 'completed') throw new Error('ASSISTANT_MESSAGE_ALREADY_COMPLETED')
      existing.runId = `run-${randomUUID()}`
      existing.state = 'queued'
      existing.updatedAt = new Date().toISOString()
      if (attachments) existing.attachments = attachments
      if (skills) existing.skills = skills
      if (mentionedFiles) existing.mentionedFiles = mentionedFiles
      delete existing.error
      await this.save()
      return { message: structuredClone(existing), duplicate: false }
    })
  }

  async next(): Promise<QueuedAssistantMessage | undefined> {
    return this.serial(async () => {
      const message = this.requireState().messages.find(item => item.state === 'queued')
      if (!message) return undefined
      message.state = 'replying'
      message.updatedAt = new Date().toISOString()
      await this.save()
      return structuredClone(message)
    })
  }

  hasQueued(): boolean { return this.requireState().messages.some(message => message.state === 'queued') }

  async update(runId: string, state: WebAssistantMessageReceipt['state'], error?: string): Promise<void> {
    await this.serial(async () => {
      const message = this.requireState().messages.find(item => item.runId === runId)
      if (!message) return
      message.state = state
      message.updatedAt = new Date().toISOString()
      if (error) message.error = error.slice(0, 240)
      else delete message.error
      await this.save()
    })
  }

  list(): WebAssistantMessageReceipt[] {
    return this.requireState().messages.map(({ text: _text, ...message }) => structuredClone(message))
  }

  transcript(): Array<{ requestId: string; runId: string; text: string; createdAt: string; attachments?: WebAttachment[]; skills?: string[]; mentionedFiles?: string[] }> {
    return this.requireState().messages.map(message => ({
      requestId: message.messageId,
      runId: message.runId,
      text: message.text,
      createdAt: message.createdAt,
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.skills ? { skills: message.skills } : {}),
      ...(message.mentionedFiles ? { mentionedFiles: message.mentionedFiles } : {}),
    }))
  }

  async addWorkNotice(message: WebMessage): Promise<void> {
    await this.serial(async () => {
      const notices = this.requireState().notices ??= []
      if (notices.some(item => item.id === message.id)) return
      notices.push(structuredClone(message))
      await this.save()
    })
  }

  async linkWork(conversationId: string, projectId: string, title: string): Promise<void> {
    await this.serial(async () => {
      this.requireState().workLinks ??= {}
      this.requireState().workLinks![conversationId] = { projectId, title }
      await this.save()
    })
  }

  workLink(conversationId: string): { projectId: string; title: string } | undefined {
    const value = this.requireState().workLinks?.[conversationId]
    return value ? structuredClone(value) : undefined
  }

  workNotices(): WebMessage[] { return structuredClone(this.requireState().notices ?? []) }

  receiptByRun(runId: string): WebAssistantMessageReceipt | undefined {
    const message = this.requireState().messages.find(item => item.runId === runId)
    if (!message) return undefined
    const { text: _text, ...receipt } = message
    return structuredClone(receipt)
  }

  private requireState(): AssistantQueueFile {
    if (!this.state) throw new Error('ASSISTANT_STORE_NOT_INITIALIZED')
    return this.state
  }

  private async save(): Promise<void> {
    const state = this.requireState()
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 })
      await replaceStateFile(temporary, this.path)
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolveTail => { release = resolveTail })
    await previous
    try { return await operation() } finally { release() }
  }
}
