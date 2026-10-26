import { createHash } from 'node:crypto'
import type { LocalHost, RunHandle } from '../index.js'
import type { WebRunSnapshot } from '../protocol.js'

type Store = Pick<LocalHost['conversationData'], 'call'>
type WireSnapshot = { version: 1; supersededBy?: 'h5'; conversationId: string; updatedAt: number; snapshot: Omit<WebRunSnapshot, 'interactions'> & { interactions?: Awaited<ReturnType<RunHandle['pendingInteractions']>> } }
type Receipt = { requestId: string; digest: string; ok: boolean; error?: string }
type Command = { requestId: string; runId: string; conversationId: string; method: 'reply' | 'cancel'; groupId?: string; answers?: Parameters<RunHandle['replyBatch']>[1] }
const commandDigest = (command: Command) => createHash('sha256').update(JSON.stringify({ requestId: command.requestId, runId: command.runId, conversationId: command.conversationId, method: command.method, groupId: command.groupId, answers: command.answers ? [...command.answers].sort((a, b) => a.effectId.localeCompare(b.effectId)) : undefined })).digest('hex')

/** Reads the v1 CLI per-run mailbox through the existing sole data writer.
 * Discovery uses retained change cursors, with a bounded history scan on reset. */
export class CliNotificationReader {
  private cursor: number | undefined
  private readonly known = new Map<string, string>()
  private readonly active = new Set<string>()
  private readonly locks = new Map<string, Promise<unknown>>()
  constructor(private store: Store, private now = Date.now, private pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}
  async snapshot(runId: string): Promise<WireSnapshot | undefined> {
    const value = await this.store.call<WireSnapshot | undefined>('readState', `cli-notice:${runId}`)
    if (value?.version !== 1 || value.supersededBy || value.snapshot?.runId !== runId) return undefined
    if (value.snapshot.state === 'running' && this.now() - value.updatedAt > 15_000) return { ...value, snapshot: { ...value.snapshot, state: 'interrupted', interactions: [] } }
    return value
  }
  /** The resumed host owns this run now. Retain the old data as evidence, but
   * never project it again, including after H5 restarts. A new CLI owner writes
   * a fresh wire snapshot through the ordinary bridge. */
  async takeover(runId: string): Promise<void> {
    const value = await this.store.call<WireSnapshot | undefined>('readState', `cli-notice:${runId}`)
    if (value?.version === 1 && !value.supersededBy) await this.store.call('saveState', `cli-notice:${runId}`, { ...value, supersededBy: 'h5' })
    this.active.delete(runId)
    this.known.delete(runId)
  }
  async sync(): Promise<WireSnapshot[]> {
    const changes = await this.store.call<{ reset: boolean; revision: number; items: Array<{ seq: number; kind: string; item: string | null }> }>('changes', this.cursor ?? 0)
    const ids = new Set(this.active)
    const reset = this.cursor === undefined || changes.reset
    if (reset) {
      const conversations = await this.store.call<Array<{ runs?: string[]; activeRunId?: string; updatedAt: string }>>('list')
      const recent = [...conversations].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).flatMap(item => item.runs ?? []).slice(-200)
      for (const id of recent) ids.add(id)
      for (const item of conversations) if (item.activeRunId) ids.add(item.activeRunId)
    }
    if (!reset) for (const item of changes.items) if (item.kind === 'state' && item.item?.startsWith('cli-notice:')) ids.add(item.item.slice('cli-notice:'.length))
    const result: WireSnapshot[] = []
    for (const id of ids) {
      const item = await this.snapshot(id)
      if (!item) { this.active.delete(id); this.known.delete(id); continue }
      if (item.snapshot.state === 'running') this.active.add(id); else this.active.delete(id)
      const signature = `${item.snapshot.seq}:${item.snapshot.state}`
      if (this.known.get(id) !== signature) { this.known.set(id, signature); result.push(item) }
    }
    while (this.known.size > 1000) {
      const oldest = [...this.known.keys()].find(id => !this.active.has(id))
      if (!oldest) break
      this.known.delete(oldest)
    }
    this.cursor = reset ? changes.revision : changes.items.at(-1)?.seq ?? changes.revision
    return result.sort((a, b) => a.updatedAt - b.updatedAt)
  }
  request(command: Command): Promise<void> {
    const work = (this.locks.get(command.runId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const digest = commandDigest(command)
      const receipts = await this.store.call<Receipt[] | undefined>('readState', `cli-notice-receipts:${command.runId}`) ?? []
      const previous = receipts.find(item => item.requestId === command.requestId)
      if (previous) {
        if (previous.digest !== digest) throw new Error('REQUEST_ID_REUSED')
        if (!previous.ok) throw new Error(previous.error ?? 'REPLY_FAILED')
        return
      }
      const current = await this.snapshot(command.runId)
      if (!current || current.conversationId !== command.conversationId || current.snapshot.state !== 'running') throw new Error('RUN_NOT_ACTIVE')
      if (command.method === 'reply') {
        const group = current.snapshot.interactions?.find(item => item.groupId === command.groupId)
        if (!group || !command.answers || group.items.length !== command.answers.length || group.items.some(item => !command.answers!.some(answer => answer.effectId === item.effectId))) throw new Error('INTERACTION_GROUP_MISMATCH')
      }
      await this.store.call('saveState', `cli-notice-command:${command.runId}`, { ...command, expiresAt: this.now() + 8000 })
      const deadline = this.now() + 8000
      while (this.now() < deadline) {
        const receipt = await this.store.call<Receipt | undefined>('readState', `cli-notice-result:${command.runId}`)
        if (receipt?.requestId === command.requestId) {
          if (!receipt.ok) throw new Error(receipt.error ?? 'REPLY_FAILED')
          return
        }
        await this.pause(100)
      }
      throw new Error('CLI_REPLY_TIMEOUT')
    })
    this.locks.set(command.runId, work)
    void work.finally(() => { if (this.locks.get(command.runId) === work) this.locks.delete(command.runId) }).catch(() => undefined)
    return work
  }
}
