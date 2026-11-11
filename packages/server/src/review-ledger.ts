import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ReviewAttempt, ReviewAttemptEvent, ReviewExecutionPolicy } from '@hunterzhu/pulse-adapters'

/** A run-scoped journal, independent of the provider connection and Runtime checkpoint. */
export class ReviewLedger implements ReviewExecutionPolicy {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  claim(reviewKey: string): Promise<ReviewAttempt> {
    const claim = this.queue.then(async () => {
      const rows = await readFile(this.path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      const claims = rows.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) }
        catch { throw Object.assign(new Error('Review journal is incomplete; allowance was not reset.'), { code: 'REVIEW_LEDGER_INVALID', retryable: false }) }
      }).filter(row => row.type === 'claim' && row.reviewKey === reviewKey)
      const attempt = claims.length + 1, remaining = claims.length ? 105_000 - (this.now() - claims[0].atMs) : 105_000
      if (attempt > 2 || remaining <= 0) throw Object.assign(new Error('Review allowance exhausted; completed work and evidence retained.'), { code: 'REVIEW_ATTEMPTS_EXHAUSTED', retryable: false })
      const timeoutMs = Math.min(attempt === 1 ? 60_000 : 45_000, remaining)
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify({ type: 'claim', reviewKey, attempt, atMs: this.now(), timeoutMs }) + '\n', { mode: 0o600 })
      return { attempt, timeoutMs }
    })
    this.queue = claim.catch(() => undefined)
    return claim
  }
  record(event: ReviewAttemptEvent): Promise<void> {
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify({ type: 'result', at: new Date(this.now()).toISOString(), ...event }) + '\n', { mode: 0o600 })
    })
    this.queue = write.catch(() => undefined)
    return write
  }
}
