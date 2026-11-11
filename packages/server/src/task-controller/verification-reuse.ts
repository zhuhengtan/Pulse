import { contentHash, type EffectRecord, type JsonValue, type PulseRuntime } from '@hunterzhu/pulse-runtime'

const row = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const counters = new Set(['usedTurns', 'maxTurns', 'actualBudget', 'controllerTurns', 'modelCalls', 'investigationRounds', 'directedInvestigations', 'executionSlices'])
function hostCounters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hostCounters)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !counters.has(key)).map(([key, item]) => [key, hostCounters(item)]))
  return value
}
function verificationInputs(inputs: Record<string, any>): Record<string, any> {
  return { ...inputs, ...(Array.isArray(inputs.conversation) ? { conversation: inputs.conversation.map((message: any) => {
    if (typeof message.content !== 'string') return message
    try {
      const content = JSON.parse(message.content)
      // Only Host-authored controller envelopes have accounting counters.
      // Arbitrary user JSON and tool evidence must retain their exact meaning.
      if (!content || typeof content !== 'object' || Array.isArray(content) || !('activeStage' in content) && !('stages' in content)) return message
      return { ...message, content: JSON.stringify(hostCounters(content)) }
    } catch { return message }
  }) } : {}) }
}

/** A reuse identity, never a freshness proof. The Host checks freshness before and after reuse. */
export function verificationFingerprint(effect: EffectRecord, runtime: PulseRuntime, efficiency = false): string | undefined {
  if (!(efficiency ? /^verify-(?:stage|task|sources|claims)(?:-llm|-correct-\d+|:submit)?$/ : /^verify-(?:stage|task)(?:-llm|-correct-\d+|:submit)?$/).test(effect.key ?? '') || !efficiency && !['57', '58'].includes(String(runtime.state.lanes.get(effect.ownerLaneId)?.resume.programVersion))) return undefined
  const input = row(effect.input), inputs = row(input.inputs)
  if (!Array.isArray(inputs.results) || inputs.results.some((ref: unknown) => typeof ref !== 'string' || !runtime.state.results.has(ref))) return undefined
  return contentHash({
    lane: effect.ownerLaneId, key: efficiency ? effect.key.replace(/-correct-\d+$/, '-llm') : effect.key, ...(efficiency ? { efficiencyVersion: 1 } : {}), instruction: input.instruction, schema: input.outputSchema,
    system: row(input.request).blocks?.filter((b: any) => b.kind === 'system'), inputs: verificationInputs(inputs),
    evidence: inputs.results.map((ref: string) => { const r = runtime.state.results.get(ref)!; return { ref, value: r.value ?? r.summary, privacy: r.privacy, taints: r.privacyTaints } }),
  })
}

export function reusableVerification(runtime: PulseRuntime, fingerprint: string): { ref: string; value: JsonValue; privacy: 'public' | 'cloud_allowed' | 'local_only' } | undefined {
  for (const event of [...runtime.state.events].reverse()) {
    if (event.type !== 'effect.execution_metadata' || row(event.data).verificationFingerprint !== fingerprint || !event.effectId) continue
    const effect = runtime.state.effects.get(event.effectId), ref = effect?.outcome?.resultRef
    const result = ref ? runtime.state.results.get(ref) : undefined
    const value = row(result?.value), verdict = row(value.structured)
    const passed = (verdict.status === 'passed' || Array.isArray(verdict.criteria) && verdict.criteria.length > 0 && verdict.criteria.every((c: any) => c.status === 'passed') || Array.isArray(verdict.assessments) && verdict.assessments.length > 0 && verdict.assessments.every((c: any) => c.status === 'supported' || c.status === 'structural')) && (!Array.isArray(verdict.findings) || verdict.findings.length === 0)
    if (effect?.outcome?.status !== 'succeeded' || !result || !ref || !passed || value.finishReason !== 'stop' || value.toolCalls?.length) continue
    const { usage: _usage, providerContinuation: _continuation, ...retained } = value
    return { ref, value: retained as JsonValue, privacy: result.privacy }
  }
  return undefined
}
