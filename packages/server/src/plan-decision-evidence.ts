import { contentHash, type JsonValue, type PulseRuntime } from '@hunterzhu/pulse-runtime'

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

// Public, successful answers owned by this run only. A durable result may no
// longer have an inline value; an absent/corrupt body is never a caller answer.
export async function planDecisionEvidence(state: PulseRuntime['state'], load: (ref: string) => Promise<JsonValue | undefined>) {
  const decisions: Array<{ question: JsonValue; answer: JsonValue | null; resultRef: string; answerUnavailable?: string }> = []
  let bytes = 0
  for (const effect of [...state.effects.values()].filter(effect => effect.kind === 'human' && effect.outcome?.status === 'succeeded' && record(effect.input)?.kind === 'ask').slice(-24)) {
    const ref = effect.outcome?.resultRef
    const result = ref ? state.results.get(ref) : undefined
    if (!ref || !result || result.privacy !== 'public' || result.privacyTaints?.length || result.producer?.kind !== 'effect' || result.producer.id !== effect.id) continue
    const value = result.value ?? await load(ref).catch(() => undefined)
    const valid = value !== undefined && !!result.contentHash && contentHash(value) === result.contentHash
    const size = valid ? Buffer.byteLength(JSON.stringify({ question: effect.input, answer: value })) : 0
    const available = valid && size <= 16000 && bytes + size <= 32000
    if (available) bytes += size
    decisions.push({ question: effect.input, answer: available ? value! : null, resultRef: ref, ...(!available ? { answerUnavailable: valid ? 'DECISION_EVIDENCE_LIMIT' : 'DECISION_BODY_UNAVAILABLE_OR_CHANGED' } : {}) })
  }
  return decisions
}
