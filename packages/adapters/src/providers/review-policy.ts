import type { ModelCandidate, ReasoningEffort } from '@hunterzhu/pulse-runtime'
import { resolveReasoningSupport } from './reasoning-effort.js'

export interface ReviewAttempt {
  attempt: number
  timeoutMs: number
}
export interface ReviewAttemptEvent {
  reviewKey: string
  attempt: number
  model: string
  reasoningEffort?: ReasoningEffort
  maxOutputTokens: number
  timeoutMs: number
  elapsedMs: number
  status: 'completed' | 'unavailable'
  code?: string
}
/** Claims are durable before provider dispatch, shared by retries and schema repair. */
export interface ReviewExecutionPolicy {
  claim(reviewKey: string): Promise<ReviewAttempt>
  record(event: ReviewAttemptEvent): Promise<void>
}
export const reviewRetryCodes = ['REVIEW_REQUEST_TIMEOUT', 'PROVIDER_NETWORK_ERROR', 'OUTPUT_TRUNCATED', 'OUTPUT_SCHEMA_VIOLATION', ...[408, 425, 429, ...Array.from({ length: 100 }, (_, i) => 500 + i)].map(code => `PROVIDER_HTTP_${code}`)]
export function reviewEffort(provider: string, candidate: ModelCandidate, explicit?: ReasoningEffort): ReasoningEffort | undefined {
  if (explicit) return explicit
  const levels = resolveReasoningSupport(provider, candidate.id, candidate.supportedReasoningEfforts).levels
  return levels.includes('low') ? 'low' : ['none', 'minimal', 'medium', 'high', 'xhigh', 'max'].find(level => levels.includes(level as ReasoningEffort)) as ReasoningEffort | undefined
}
