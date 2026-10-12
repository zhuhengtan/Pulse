import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { PulseRuntime, PulseSession } from '@hunterzhu/pulse-runtime'
import type { JarvisClient } from './client.js'
import type { CandidateMemoryInput, CloseSessionInput, JarvisContextPackage } from './types.js'
import { redactJarvisText } from './privacy.js'
import { MAX_JARVIS_CONTEXT_CHARS } from '../prompt.js'

const closeInputSchema = z.object({
  result: z.enum(['success', 'failure', 'partial']), summary: z.string(),
  decisions: z.array(z.string()).default([]), failures: z.array(z.string()).default([]), nextSteps: z.array(z.string()).default([]),
})
const candidateSchema = z.object({
  scope: z.enum(['global', 'project']).optional(),
  kind: z.enum(['preference', 'fact', 'constraint', 'decision', 'identity', 'workflow']).optional(),
  title: z.string(), content: z.string(), sourceRefs: z.array(z.string()).optional(),
})
const bindingSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string().min(1), context: z.string().optional(),
  contextPackage: z.unknown().optional(),
  recordedEffectIds: z.array(z.string()), closed: z.boolean().default(false),
  pendingEvents: z.array(z.object({ id: z.string(), type: z.enum(['observation', 'action', 'result', 'system']), content: z.string(), effectId: z.string().optional() })).default([]),
  completion: z.object({ input: closeInputSchema, candidate: candidateSchema.optional(), candidateRecorded: z.boolean().default(false) }).optional(),
})
type Binding = z.infer<typeof bindingSchema>

/** One run owns its binding, durable outbox, and acknowledged recording cursor. */
export class JarvisRun {
  private readonly recorded: Set<string>
  private readonly pending = new Set<Promise<void>>()
  private queue: Promise<void> = Promise.resolve()
  private observer: Promise<void> | undefined
  private closing: Promise<void> | undefined

  private constructor(private readonly client: JarvisClient, private readonly path: string, private readonly binding: Binding) {
    this.recorded = new Set([...binding.recordedEffectIds, ...binding.pendingEvents.flatMap((event) => event.effectId ? [event.effectId] : [])])
  }

  get context(): string | undefined { return this.binding.context }
  get contextPackage(): JarvisContextPackage | undefined { return this.binding.contextPackage as JarvisContextPackage | undefined }
  get sessionId(): string { return this.binding.sessionId }

  static async open(client: JarvisClient, path: string, workspace: string, task: string, tokenBudget: number, restore = false): Promise<JarvisRun | undefined> {
    if (restore) {
      const saved = await readFile(path, 'utf8').then((text) => bindingSchema.parse(JSON.parse(text))).catch(() => undefined)
      if (saved && !saved.closed) return new JarvisRun(client, path, saved)
    }
    const session = await client.openSession(workspace, task)
    if (!session) return undefined
    try {
      const pkg = await client.buildContext(session.id, task, tokenBudget).catch(() => undefined)
      const context = typeof pkg?.text === 'string' ? pkg.text.slice(0, MAX_JARVIS_CONTEXT_CHARS) : undefined
      const run = new JarvisRun(client, path, { schemaVersion: 1, sessionId: session.id, ...(context ? { context } : {}), ...(pkg ? { contextPackage: pkg } : {}), recordedEffectIds: [], closed: false, pendingEvents: [] })
      await run.persist()
      return run
    } catch (error) {
      await client.closeSession(session.id, { result: 'failure', summary: 'Pulse could not persist the Jarvis run binding.' }).catch(() => undefined)
      throw error
    }
  }

  /** Replay a finished run's outbox without restarting its task or opening another session. */
  static async retryCompletion(client: JarvisClient, path: string): Promise<void> {
    const saved = await readFile(path, 'utf8').then((text) => bindingSchema.parse(JSON.parse(text))).catch(() => undefined)
    if (!saved || saved.closed || !saved.completion) return
    const run = new JarvisRun(client, path, saved)
    await run.close(undefined, saved.completion.input, saved.completion.candidate as CandidateMemoryInput | undefined)
  }

  private async persist(): Promise<void> {
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.binding, null, 2), { mode: 0o600 })
    await rename(`${this.path}.tmp`, this.path)
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.queue.catch(() => undefined).then(work)
    this.queue = pending
    return pending
  }

  private safeText(text: string): string { return this.client.redactText?.(text) ?? redactJarvisText(text) }

  private async deliverEvents(): Promise<void> {
    while (this.binding.pendingEvents.length) {
      const event = this.binding.pendingEvents[0]!
      await this.client.recordEvent(this.binding.sessionId, event.type, event.content, `pulse:event:${event.id}`)
      this.binding.pendingEvents.shift()
      if (event.effectId && !this.binding.recordedEffectIds.includes(event.effectId)) this.binding.recordedEffectIds.push(event.effectId)
      await this.persist()
    }
  }

  private collect(runtime: PulseRuntime): void {
    if (this.binding.closed) return
    const events: Binding['pendingEvents'] = []
    for (const effect of runtime.state.effects.values()) {
      if (effect.kind !== 'tool' || !effect.outcome || this.recorded.has(effect.id)) continue
      this.recorded.add(effect.id)
      const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input : {}
      const result = effect.outcome.resultRef ? runtime.state.results.get(effect.outcome.resultRef)?.value : undefined
      const shell = input.name === 'shell.exec' && result && typeof result === 'object' && !Array.isArray(result) ? result : undefined
      const failedCommand = shell && (shell.code !== 0 || shell.timedOut === true || shell.aborted === true)
      // Never put arguments, paths, file bodies, outputs or errors in the outbox.
      const content = JSON.stringify({ effectId: effect.id, toolCallId: effect.toolCallId ?? effect.id, tool: input.name, status: failedCommand && effect.outcome.status === 'succeeded' ? 'failed' : effect.outcome.status })
      events.push({ id: effect.id, effectId: effect.id, type: 'action', content })
    }
    if (!events.length) return
    const work = this.enqueue(async () => {
      this.binding.pendingEvents.push(...events)
      await this.persist()
      await this.deliverEvents()
    }).catch(() => undefined)
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
  }

  observe(runtime: PulseRuntime, session: PulseSession, signal: AbortSignal): void {
    if (this.observer) return
    this.observer = (async () => {
      let finished = false
      void session.outcome().then(() => { finished = true }, () => { finished = true })
      while (!finished && !signal.aborted) {
        this.collect(runtime)
        await runtime.waitForActivity()
      }
      this.collect(runtime)
    })()
  }

  recordUserInput(text: string, id: string = randomUUID()): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return Promise.resolve()
    return this.enqueue(async () => {
      this.binding.pendingEvents.push({ id, type: 'observation', content: this.safeText(`User message: ${trimmed}`).slice(0, 100_000) })
      await this.persist()
      await this.deliverEvents()
    })
  }

  async flush(runtime: PulseRuntime): Promise<void> {
    this.collect(runtime)
    while (this.pending.size) await Promise.all([...this.pending])
    await this.enqueue(() => this.deliverEvents())
  }

  close(runtime: PulseRuntime | undefined, input: CloseSessionInput, candidate?: CandidateMemoryInput): Promise<void> {
    if (this.binding.closed) return Promise.resolve()
    return this.closing ??= (async () => {
      await this.enqueue(async () => {
        this.binding.completion ??= {
          input: closeInputSchema.parse({ ...input, summary: this.safeText(input.summary), decisions: input.decisions?.map((text) => this.safeText(text)), failures: input.failures?.map((text) => this.safeText(text)), nextSteps: input.nextSteps?.map((text) => this.safeText(text)) }),
          ...(candidate ? { candidate: { ...candidate, title: this.safeText(candidate.title), content: this.safeText(candidate.content) } } : {}), candidateRecorded: false,
        }
        await this.persist()
      })
      if (runtime) await this.flush(runtime)
      await this.enqueue(async () => {
        await this.deliverEvents()
        const completion = this.binding.completion!
        if (completion.candidate && !completion.candidateRecorded) {
          await this.client.recordCandidate(this.binding.sessionId, completion.candidate as CandidateMemoryInput, 'pulse:candidate')
          completion.candidateRecorded = true
          await this.persist()
        }
        await this.client.closeSession(this.binding.sessionId, completion.input, 'pulse:close')
        this.binding.closed = true
        await this.persist()
      })
    })().finally(() => { this.closing = undefined })
  }
}
