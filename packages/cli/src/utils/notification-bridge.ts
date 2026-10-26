import { createHash } from 'node:crypto'
import type { AssistantEvent, LocalHost, RunHandle } from '@hunterzhu/pulse-server'
import type { WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

type Store = Pick<LocalHost['conversationData'], 'call'>
type Command = { requestId: string; runId: string; conversationId: string; expiresAt: number; method: 'reply' | 'cancel'; groupId?: string; answers?: Parameters<RunHandle['replyBatch']>[1] }
type Receipt = { requestId: string; digest: string; ok: boolean; error?: string }
const commandDigest = (command: Command) => createHash('sha256').update(JSON.stringify({ requestId: command.requestId, runId: command.runId, conversationId: command.conversationId, method: command.method, groupId: command.groupId, answers: command.answers ? [...command.answers].sort((a, b) => a.effectId.localeCompare(b.effectId)) : undefined })).digest('hex')

/** v1 CLI mailbox protocol. All keys are owned by one run; the existing data
 * service remains the sole database writer. H5 only writes the command key. */
export class CliNotificationBridge {
  private tail: Promise<unknown> = Promise.resolve()
  private state: WebRunSnapshot
  private receipts: Receipt[] = []
  private stopped = false
  private applying = false
  private lastWrite = 0
  constructor(private store: Store, private run: RunHandle, private pending?: (effectIds: Set<string>) => void, private now = Date.now) {
    this.state = { runId: run.id, state: 'running', seq: 0, activities: [], interactions: [] }
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(work)
    this.tail = result
    return result
  }
  private async save(): Promise<void> {
    this.lastWrite = this.now()
    await this.store.call('saveState', `cli-notice:${this.run.id}`, { version: 1, conversationId: this.run.conversationId, updatedAt: this.lastWrite, snapshot: this.state })
  }
  private async refresh(): Promise<void> {
    const interactions = this.state.state === 'running' ? await this.run.pendingInteractions() : []
    this.pending?.(new Set(interactions.flatMap(group => group.items.map(item => item.effectId))))
    if (JSON.stringify(interactions) !== JSON.stringify(this.state.interactions)) {
      this.state = { ...this.state, seq: this.state.seq + 1, interactions }
      await this.save()
    } else if (this.now() - this.lastWrite >= 2000) await this.save()
  }
  event(event: AssistantEvent): Promise<void> {
    return this.queue(async () => {
      if (this.stopped) return
      if (event.type === 'complete') {
        const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
        const status = data.status === 'succeeded' || data.status === 'cancelled' ? data.status : 'failed'
        this.state = { ...this.state, state: status, seq: this.state.seq + 1, interactions: [], complete: { type: 'complete', runId: this.run.id, conversationId: this.run.conversationId, seq: this.state.seq + 1, data: { status } } }
        this.pending?.(new Set())
        await this.save()
      } else if (event.type === 'waiting') await this.refresh()
    })
  }
  /** Heartbeats stay on the state queue. A reply must not block the next timestamp. */
  heartbeat(): Promise<void> {
    return this.queue(async () => {
      if (!this.stopped && this.state.state === 'running') await this.refresh()
    })
  }
  tick(): Promise<void> {
    return this.turn()
  }
  private async turn(): Promise<void> {
    let command: Command | undefined
    await this.queue(async () => {
      if (this.stopped || this.state.state !== 'running') return
      await this.refresh()
      if (this.applying) return
      command = await this.store.call<Command | undefined>('readState', `cli-notice-command:${this.run.id}`)
      if (command) this.applying = true
    })
    if (!command) return
    try { await this.consume(command) }
    finally {
      await this.queue(async () => {
        this.applying = false
        if (!this.stopped && this.state.state === 'running') await this.refresh()
      })
    }
  }
  private async consume(command: Command): Promise<void> {
    const digest = commandDigest(command)
    const receipts = await this.store.call<Receipt[] | undefined>('readState', `cli-notice-receipts:${this.run.id}`) ?? []
    const previous = receipts.find(item => item.requestId === command.requestId)
    if (!previous) {
      let error: string | undefined
      try {
        if (command.runId !== this.run.id || command.conversationId !== this.run.conversationId || command.expiresAt < this.now()) throw new Error('QUESTION_EXPIRED')
        if (command.method === 'cancel') await this.run.cancel('USER_REQUESTED')
        else {
          const groups = await this.run.pendingInteractions()
          const group = groups.find(item => item.groupId === command.groupId)
          if (!group || !command.answers || group.items.length !== command.answers.length || group.items.some(item => !command.answers!.some(answer => answer.effectId === item.effectId))) throw new Error('INTERACTION_GROUP_MISMATCH')
          await this.run.replyBatch(group.groupId, command.answers)
        }
      } catch (cause) { error = cause instanceof Error ? cause.message : 'REPLY_FAILED' }
      const next = [...receipts, { requestId: command.requestId, digest, ok: !error, ...(error ? { error } : {}) }].slice(-100)
      await this.queue(async () => {
        this.receipts = next
        await this.store.call('saveState', `cli-notice-receipts:${this.run.id}`, next)
        await this.refresh()
        const result = next.find(item => item.requestId === command.requestId)
        await this.store.call('saveState', `cli-notice-result:${this.run.id}`, result)
      })
      return
    }
    await this.queue(async () => {
      this.receipts = receipts
      if (previous.digest !== digest) {
        await this.store.call('saveState', `cli-notice-result:${this.run.id}`, { requestId: command.requestId, digest: previous.digest, ok: false, error: 'REQUEST_ID_REUSED' })
        return
      }
      await this.refresh()
      const result = receipts.find(item => item.requestId === command.requestId)!
      const last = await this.store.call<Receipt | undefined>('readState', `cli-notice-result:${this.run.id}`)
      if (JSON.stringify(last) !== JSON.stringify(result)) await this.store.call('saveState', `cli-notice-result:${this.run.id}`, result)
    })
  }
  close(): Promise<void> {
    return this.queue(async () => {
      this.stopped = true
      if (this.state.state === 'running') { this.state = { ...this.state, state: 'interrupted', interactions: [], seq: this.state.seq + 1 }; await this.save() }
    })
  }
}

export async function withCliNotifications(host: LocalHost | null, run: RunHandle, pending?: (effectIds: Set<string>) => void): Promise<RunHandle> {
  if (!host) return run
  const bridge = new CliNotificationBridge(host.conversationData, run, pending)
  let warned = false
  const optional = async (work: Promise<void>) => { try { await work } catch { if (!warned) { warned = true; process.stderr.write('CLI 任务通知暂不可用，终端任务继续运行。\n') } } }
  await optional(bridge.tick())
  const timer = setInterval(() => { void optional(bridge.tick()) }, 1000)
  timer.unref()
  return { ...run,
    events: (async function* () {
      try { for await (const event of run.events) { await optional(bridge.event(event)); yield event } }
      finally { clearInterval(timer); await optional(bridge.close()) }
    })(),
    reply: async (...args) => { await run.reply(...args); await optional(bridge.tick()) },
    replyBatch: async (...args) => { await run.replyBatch(...args); await optional(bridge.tick()) },
  }
}
