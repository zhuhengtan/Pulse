import { assertJarvisApiUrl } from './endpoint.js'
import { jarvisMemoryTitle, redactJarvisText } from './privacy.js'
import type { CandidateMemoryInput, CloseSessionInput, JarvisContextPackage, JarvisSession, PulseJarvisConfig } from './types.js'

export class JarvisClient {
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly timeoutMs: number
  private readonly contextTimeoutMs: number
  private warnedUnavailable = false

  constructor(config: PulseJarvisConfig = {}, timeoutMs = 2000, contextTimeoutMs = 8000) {
    this.baseUrl = assertJarvisApiUrl(config.apiUrl ?? 'http://127.0.0.1:7330', config.allowRemote === true)
    this.token = config.token
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

  async openSession(workspace: string, task: string, client = 'pulse'): Promise<JarvisSession | undefined> {
    try {
      const res = await this.request<{ session: JarvisSession }>('/v1/sessions', {
        client,
        workspace,
        task: this.safeText(task),
        mode: 'work',
      })
      return res?.session
    } catch (error) {
      this.warnFailure('openSession', error)
      return undefined
    }
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

  async recordEvent(sessionId: string, type: 'observation' | 'action' | 'result' | 'system', content: string): Promise<void> {
    try {
      await this.request('/v1/events', { sessionId, type, content: this.safeText(content) }, this.contextTimeoutMs)
    } catch (error) {
      this.warnFailure('recordEvent', error)
    }
  }

  async recordCandidate(sessionId: string, candidate: CandidateMemoryInput): Promise<void> {
    try {
      await this.request('/v1/memory/candidates', {
        sessionId,
        scope: candidate.scope ?? 'project',
        kind: candidate.kind ?? 'fact',
        title: jarvisMemoryTitle(this.safeText(candidate.title)),
        content: this.safeText(candidate.content),
        sourceRefs: candidate.sourceRefs ?? [],
      }, this.contextTimeoutMs)
    } catch (error) {
      this.warnFailure('recordCandidate', error)
    }
  }

  async closeSession(sessionId: string, input: CloseSessionInput): Promise<void> {
    try {
      await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
        result: input.result,
        summary: this.safeText(input.summary),
        decisions: (input.decisions ?? []).map((text) => this.safeText(text)),
        failures: (input.failures ?? []).map((text) => this.safeText(text)),
        nextSteps: (input.nextSteps ?? []).map((text) => this.safeText(text)),
      }, this.contextTimeoutMs)
    } catch (error) {
      this.warnFailure('closeSession', error)
    }
  }

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

  private async request<T>(path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
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
}
