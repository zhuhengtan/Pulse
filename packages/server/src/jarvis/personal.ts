import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import type { JarvisClient } from './client.js'
import { PERSONAL_JARVIS_GUIDANCE } from '../prompt.js'
import type { PulseJarvisConfig } from './types.js'

const itemSchema = z.object({ externalId: z.string(), content: z.string(), title: z.string().optional(), occurredAt: z.string(), workspace: z.string(), status: z.enum(['pending_sync', 'received', 'failed', 'forgotten']), remoteId: z.string().optional(), error: z.string().optional() })
type Item = z.infer<typeof itemSchema>
const bindingSchema = z.object({ externalId: z.string(), destinationScope: z.string(), content: z.string(), title: z.string().optional(), occurredAt: z.string(), workspace: z.string() }).strict()
type Binding = z.infer<typeof bindingSchema>

/** Each source is its own atomic outbox entry; independent workers never rewrite a shared index. */
export class PersonalJarvisQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly directory: string
  private readonly bindings: string
  constructor(dataDir: string, private readonly client: JarvisClient) {
    this.directory = join(dataDir, 'h5', `jarvis-observations.${client.destinationScope}`)
    this.bindings = join(dataDir, 'h5', 'jarvis-observation-bindings')
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.catch(() => {}).then(fn); this.tail = next; return next }
  private path(id: string): string { if (!/^pulse:[a-f0-9]{64}$/.test(id)) throw new Error('JARVIS_OUTBOX_ID_INVALID'); return join(this.directory, id.slice(6) + '.json') }
  private bindingPath(id: string): string { if (!/^pulse:[a-f0-9]{64}$/.test(id)) throw new Error('JARVIS_OUTBOX_ID_INVALID'); return join(this.bindings, id.slice(6) + '.json') }
  private async readBinding(id: string): Promise<Binding | undefined> {
    try { return bindingSchema.parse(JSON.parse(await readFile(this.bindingPath(id), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  /** First writer keeps the destination, payload and timestamp. Later callers only read that file. */
  private async claim(proposed: Binding): Promise<Binding> {
    const existing = await this.readBinding(proposed.externalId)
    if (existing) return existing
    await mkdir(this.bindings, { recursive: true, mode: 0o700 })
    const target = this.bindingPath(proposed.externalId), temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(proposed), { mode: 0o600, flag: 'wx' })
      try { await link(temporary, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { await rm(temporary, { force: true }) }
    return bindingSchema.parse(JSON.parse(await readFile(target, 'utf8')))
  }
  private async list(): Promise<string[]> { try { return (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
  private async load(path: string): Promise<Item> { return itemSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
  private async save(item: Item, initial = false): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const target = this.path(item.externalId), temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(item), { mode: 0o600, flag: 'wx' })
      if (initial) { try { await link(temporary, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } }
      else { const { replaceStateFile } = await import('../atomic-file.js'); await replaceStateFile(temporary, target) }
    } finally { await rm(temporary, { force: true }) }
  }
  async submit(identity: string, input: { content: string; title?: string | undefined }, workspace: string): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const externalId = `pulse:${createHash('sha256').update(identity).digest('hex')}`
      const content = this.client.redactText(input.content), title = input.title === undefined ? undefined : this.client.redactText(input.title)
      const proposed: Binding = { externalId, destinationScope: this.client.destinationScope, content, ...(title === undefined ? {} : { title }), occurredAt: new Date().toISOString(), workspace }
      const bound = await this.readBinding(externalId) ?? ((await this.list()).length >= 1000 ? undefined : await this.claim(proposed))
      if (!bound) throw new Error('JARVIS_SYNC_QUEUE_FULL')
      if (bound.destinationScope !== this.client.destinationScope) throw new Error('JARVIS_OBSERVATION_DESTINATION_CHANGED')
      if (bound.content !== content || bound.title !== title || bound.workspace !== workspace) throw new Error('JARVIS_OBSERVATION_ID_CONFLICT')
      let item: Item
      try { item = await this.load(this.path(externalId)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.save({ externalId, content: bound.content, ...(bound.title === undefined ? {} : { title: bound.title }), occurredAt: bound.occurredAt, workspace: bound.workspace, status: 'pending_sync' }, true)
        item = await this.load(this.path(externalId))
      }
      if (item.content !== content || item.title !== title || item.workspace !== workspace) throw new Error('JARVIS_OBSERVATION_ID_CONFLICT')
      if (item.status === 'pending_sync') { await this.deliver(item); await this.save(item) }
      return this.receipt(item)
    })
  }
  async flush(): Promise<void> { await this.serial(async () => { for (const name of await this.list()) { const item = await this.load(join(this.directory, name)); if (item.status !== 'pending_sync') continue; await this.deliver(item); await this.save(item); if (item.status === 'pending_sync') break } }) }
  private async deliver(item: Item): Promise<void> {
    try {
      const result = await this.client.observe({ externalId: item.externalId, content: item.content, occurredAt: item.occurredAt, workspace: item.workspace, ...(item.title === undefined ? {} : { title: item.title }) })
      if (!result || typeof result.id !== 'string' || !['pending', 'ready', 'failed', 'forgotten'].includes(result.status)) throw new Error('JARVIS_OBSERVATION_RECEIPT_INVALID')
      item.remoteId = result.id; item.status = result.status === 'forgotten' ? 'forgotten' : 'received'; delete item.error
    } catch (error) {
      item.error = this.client.redactText(error instanceof Error ? error.message : String(error)).slice(0, 500)
      if (item.error.includes('HTTP 409') || item.error.includes('HTTP 400')) item.status = 'failed'
    }
  }
  private receipt(item: Item): Record<string, unknown> { return { externalId: item.externalId, status: item.status, ...(item.remoteId ? { sourceId: item.remoteId } : {}), ...(item.error ? { error: item.error } : {}), note: item.status === 'forgotten' ? 'Forgotten means this source was not kept. It is not active memory and will not be retried.' : 'Received means source accepted, not an active memory or approved preference.' } }
}

const explicitRecordIntent = /(?:记住|记录|记一下|保存.*(?:记忆|资料)|remember|record|save.*memor)/i
const explicitRecordNegation = /(?:请勿|不用|不准|不能|不可|别再|不要|别|禁止|不必|无需|勿|do not|don't|never).{0,48}(?:记|record|remember|save)/i

/** Explicit mode allows a record only when the complete current user text clearly asks for one. History is not consulted. Blank or negated text fails closed. */
export function explicitPersonalRecordAllowed(userText: string): boolean {
  if (!userText.trim()) return false
  if (explicitRecordNegation.test(userText)) return false
  return explicitRecordIntent.test(userText)
}

export function registerPersonalJarvisTools(registry: ToolRegistry, client: JarvisClient, queue: PersonalJarvisQueue, config: PulseJarvisConfig | undefined, workspace: string, owner: string, userRequest: string): void {
  const register = <T extends z.ZodTypeAny>(name: string, description: string, input: T, execute: (value: z.infer<T>, context: import('@hunterzhu/pulse-tool-sdk').ToolContext) => Promise<unknown>, write = false) => registry.register(defineTool({ name, description, input, output: z.unknown(), sideEffectPolicy: write ? 'write' : 'read', retrySafety: write ? 'idempotent' : 'read_only', execute }))
  register('jarvis.context', PERSONAL_JARVIS_GUIDANCE, z.object({ query: z.string().max(10000).default(''), recentContext: z.string().max(6000).optional() }).strict(), async value => {
    const result = await client.retrieveContext(value.query, config?.contextTokenBudget ?? 4000, workspace, value.recentContext)
    if (!result || typeof result.text !== 'string') throw new Error('JARVIS_CONTEXT_UNAVAILABLE')
    return { ...result, text: result.text.slice(0, 32000), historicalReference: true }
  })
  register('jarvis.knowledge_search', 'Find source-backed prior discussions or documents; results are historical reference, not present-state proof.', z.object({ query: z.string().max(10000), topicId: z.string().max(200).optional(), keyword: z.string().max(80).optional(), limit: z.number().int().min(1).max(30).default(12), offset: z.number().int().min(0).default(0) }).strict(), value => client.searchKnowledge(value))
  register('jarvis.knowledge_get', 'Read bounded original evidence; continue using nextLine as offset and nextCharOffset as charOffset.', z.object({ id: z.string().min(1).max(200), offset: z.number().int().positive().default(1), charOffset: z.number().int().min(0).default(0), maxLines: z.number().int().min(1).max(100).default(40), maxChars: z.number().int().min(100).max(12000).default(4000) }).strict(), ({ id, ...value }) => client.getKnowledge(id, value))
  const explicit = config?.observationPolicy === 'explicit' || config?.observationPolicy === undefined && config?.autoCandidate === false
  register('jarvis.observe', `Submit actual user statements or useful evidence, not an invented conclusion. Host assigns stable source identity. Source receipt is not active memory.${explicit ? ' Recording requires an explicit current-user request.' : ' Only record important changes.'}`, z.object({ content: z.string().min(1).max(100000), title: z.string().min(1).max(200).optional() }).strict(), async (value, context) => {
    if (explicit && !explicitPersonalRecordAllowed(userRequest)) throw new Error('JARVIS_EXPLICIT_RECORD_REQUIRED')
    return queue.submit(`${owner}:${context.effectId}:${context.toolCallId}`, value, workspace)
  }, true)
}
