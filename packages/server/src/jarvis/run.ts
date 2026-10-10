import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { PulseRuntime, PulseSession } from '@hunterzhu/pulse-runtime'
import type { JarvisClient } from './client.js'
import type { CandidateMemoryInput, CloseSessionInput } from './types.js'
import { MAX_JARVIS_CONTEXT_CHARS } from '../prompt.js'

const bindingSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  context: z.string().optional(),
  recordedEffectIds: z.array(z.string()),
  closed: z.boolean().default(false),
})
type Binding = z.infer<typeof bindingSchema>

/** One run owns its binding, pending writes, and durable recording cursor. */
export class JarvisRun {
  private readonly recorded: Set<string>
  private readonly pending = new Set<Promise<void>>()
  private persistence: Promise<void> = Promise.resolve()
  private observer: Promise<void> | undefined
  private closing: Promise<void> | undefined

  private constructor(private readonly client: JarvisClient, private readonly path: string, private readonly binding: Binding) {
    this.recorded = new Set(binding.recordedEffectIds)
  }

  get context(): string | undefined { return this.binding.context }

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
      const run = new JarvisRun(client, path, { schemaVersion: 1, sessionId: session.id, ...(context ? { context } : {}), recordedEffectIds: [], closed: false })
      await run.persist()
      return run
    } catch (error) {
      await client.closeSession(session.id, { result: 'failure', summary: 'Pulse could not persist the Jarvis run binding.' }).catch(() => undefined)
      throw error
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.binding, null, 2)
    this.persistence = this.persistence.catch(() => undefined).then(async () => {
      await writeFile(`${this.path}.tmp`, snapshot, { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    })
    return this.persistence
  }

  private collect(runtime: PulseRuntime): void {
    for (const effect of runtime.state.effects.values()) {
      if (effect.kind !== 'tool' || !effect.outcome || this.recorded.has(effect.id)) continue
      this.recorded.add(effect.id)
      const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input : {}
      const result = effect.outcome.resultRef ? runtime.state.results.get(effect.outcome.resultRef)?.value : undefined
      const shell = input.name === 'shell.exec' && result && typeof result === 'object' && !Array.isArray(result) ? result : undefined
      const failedCommand = shell && (shell.code !== 0 || shell.timedOut === true || shell.aborted === true)
      // Argument values, paths, file bodies, outputs and errors may contain
      // credentials. Only execution identity and outcome cross this boundary.
      const content = JSON.stringify({ effectId: effect.id, toolCallId: effect.toolCallId ?? effect.id, tool: input.name, status: failedCommand && effect.outcome.status === 'succeeded' ? 'failed' : effect.outcome.status })
      const work = Promise.resolve().then(() => this.client.recordEvent(this.binding.sessionId, 'action', content)).then(async () => {
        this.binding.recordedEffectIds.push(effect.id)
        await this.persist()
      }).catch(() => undefined)
      this.pending.add(work)
      void work.finally(() => this.pending.delete(work))
    }
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

  async flush(runtime: PulseRuntime): Promise<void> {
    this.collect(runtime)
    while (this.pending.size) await Promise.all([...this.pending])
    await this.persistence
  }

  close(runtime: PulseRuntime | undefined, input: CloseSessionInput, candidate?: CandidateMemoryInput): Promise<void> {
    return this.closing ??= (async () => {
      if (runtime) await this.flush(runtime)
      if (candidate) await this.client.recordCandidate(this.binding.sessionId, candidate).catch(() => undefined)
      await this.client.closeSession(this.binding.sessionId, input).catch(() => undefined)
      this.binding.closed = true
      await this.persist()
    })()
  }
}
