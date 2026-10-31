import { assertJarvisApiUrl } from './endpoint.js'
import { createHash } from 'node:crypto'
import { jarvisMemoryTitle, redactJarvisText } from './privacy.js'
import type { CandidateMemoryInput, CloseSessionInput, JarvisContextPackage, JarvisMemoryRecord, JarvisSession, PulseJarvisConfig } from './types.js'

export class JarvisClient {
  readonly destinationScope: string
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly timeoutMs: number
  private readonly contextTimeoutMs: number
  private warnedUnavailable = false

  constructor(config: PulseJarvisConfig = {}, timeoutMs = 2000, contextTimeoutMs = 8000) {
    this.baseUrl = assertJarvisApiUrl(config.apiUrl ?? 'http://127.0.0.1:7330', config.allowRemote === true)
    this.token = config.token
    this.destinationScope = createHash('sha256').update(JSON.stringify([this.baseUrl, this.token ?? ''])).digest('hex')
    this.timeoutMs = timeoutMs
    this.contextTimeoutMs = contextTimeoutMs
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async openSession(workspace: string, task: string, client = 'pulse', mode: 'work' | 'unassigned' = 'work'): Promise<JarvisSession | undefined> {
    try {
      const res = await this.request<{ session: JarvisSession }>('/v1/sessions', {
        client,
        workspace,
        task: this.safeText(task),
        mode,
      })
      return res?.session
    } catch (error) {
      this.warnFailure('openSession', error)
      return undefined
    }
  }

  async retrieveContext(task: string, tokenBudget = 4000, workspace?: string, recentContext?: string): Promise<JarvisContextPackage | undefined> {
    try {
      return await this.request<JarvisContextPackage>('/v1/context/retrieve', {
        task: this.safeText(task), tokenBudget: Math.max(500, Math.min(8000, tokenBudget)), client: 'pulse', ...(workspace ? { workspace } : {}), ...(recentContext ? { recentContext: this.safeText(recentContext).slice(-6000) } : {}),
      }, this.contextTimeoutMs)
    } catch (error) { this.warnFailure('retrieveContext', error); return undefined }
  }

  async observe(input: { externalId: string; content: string; title?: string; occurredAt: string; workspace?: string; keywords?: string[] }): Promise<{ id: string; status: string }> {
    return this.request('/v1/observe', { ...input, content: this.safeText(input.content), ...(input.title ? { title: this.safeText(input.title) } : {}), client: 'pulse' }, this.contextTimeoutMs)
  }

  async searchKnowledge(input: { query: string; topicId?: string | undefined; keyword?: string | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<unknown> {
    const params = new URLSearchParams(Object.entries({ ...input, query: this.safeText(input.query) }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    return this.get(`/v1/knowledge/search?${params}`)
  }

  async getKnowledge(id: string, input: { offset?: number; charOffset?: number; maxLines?: number; maxChars?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams(Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    return this.get(`/v1/knowledge/${encodeURIComponent(id)}?${params}`)
  }

  async searchMemory(projectId: string, query: string, limit = 10): Promise<JarvisMemoryRecord[]> {
    const params = new URLSearchParams({ projectId, query: this.safeText(query), limit: String(Math.max(1, Math.min(50, limit))) })
    return this.get<JarvisMemoryRecord[]>(`/v1/memory/search?${params.toString()}`)
  }

  async getMemory(id: string): Promise<JarvisMemoryRecord | undefined> {
    try { return await this.get<JarvisMemoryRecord>(`/v1/memory/${encodeURIComponent(id)}`) }
    catch (error) { if (error instanceof Error && error.message.includes('Jarvis HTTP 404')) return undefined; throw error }
  }

  async listCandidates(projectId?: string): Promise<JarvisMemoryRecord[]> {
    const query = projectId ? `?${new URLSearchParams({ projectId }).toString()}` : ''
    return this.get<JarvisMemoryRecord[]>(`/v1/memory/candidates${query}`)
  }

  async buildContext(sessionId: string, task: string, tokenBudget = 4000): Promise<JarvisContextPackage | undefined> {
    try {
      return await this.request<JarvisContextPackage>('/v1/context/build', {
        sessionId,
        task: this.safeText(task),
        tokenBudget,
      }, this.contextTimeoutMs)
    } catch (error) {
      this.warnFailure('buildContext', error)
      return undefined
    }
  }

  async recordEvent(sessionId: string, type: 'observation' | 'action' | 'result' | 'system', content: string, idempotencyKey?: string): Promise<{ id?: string }> {
    try {
      return await this.request<{ id?: string }>('/v1/events', { sessionId, type, content: this.safeText(content) }, this.contextTimeoutMs, idempotencyKey)
    } catch (error) {
      this.warnFailure('recordEvent', error)
      throw error
    }
  }

  async recordCandidate(sessionId: string, candidate: CandidateMemoryInput, idempotencyKey?: string): Promise<{ id?: string; revision?: number; status?: string }> {
    try {
      return await this.request<{ id?: string; revision?: number; status?: string }>('/v1/memory/candidates', {
        sessionId,
        scope: candidate.scope ?? 'project',
        kind: candidate.kind ?? 'fact',
        title: jarvisMemoryTitle(this.safeText(candidate.title)),
        content: this.safeText(candidate.content),
        sourceRefs: candidate.sourceRefs ?? [],
      }, this.contextTimeoutMs, idempotencyKey)
    } catch (error) {
      this.warnFailure('recordCandidate', error)
      throw error
    }
  }

  async closeSession(sessionId: string, input: CloseSessionInput, idempotencyKey?: string): Promise<void> {
    try {
      // Jarvis bounds extraction at 12 seconds; allow its source write and close to finish.
      await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
        result: input.result,
        summary: this.safeText(input.summary),
        ...(input.details === undefined ? {} : { details: this.safeText(input.details) }),
        ...(input.extractMemory === undefined ? {} : { extractMemory: input.extractMemory }),
        decisions: (input.decisions ?? []).map((text) => this.safeText(text)),
        failures: (input.failures ?? []).map((text) => this.safeText(text)),
        nextSteps: (input.nextSteps ?? []).map((text) => this.safeText(text)),
      }, Math.max(this.contextTimeoutMs, 16_000), idempotencyKey)
    } catch (error) {
      this.warnFailure('closeSession', error)
      throw error
    }
  }

  /** Apply the same outbound redaction before putting retry payloads on disk. */
  redactText(text: string): string { return this.safeText(text) }

  private safeText(text: string): string {
    return redactJarvisText(this.token ? text.split(this.token).join('[REDACTED]') : text)
  }

  private warnFailure(operation: string, error: unknown): void {
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true
      const msg = this.safeText(error instanceof Error ? error.message : String(error))
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[pulse] Jarvis connection unavailable (${operation} failed: ${msg}). Continuing in standalone mode.`)
      }
    }
  }

  private async request<T>(path: string, body: unknown, timeoutMs = this.timeoutMs, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      throw new Error(`Jarvis HTTP ${res.status}: ${res.statusText}`)
    }
    return (await res.json()) as T
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(this.contextTimeoutMs) })
    if (!res.ok) throw new Error(`Jarvis HTTP ${res.status}: ${res.statusText}`)
    return await res.json() as T
  }
}
