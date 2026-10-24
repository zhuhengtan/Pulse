import type { PulseRuntime, EffectExecutor, JsonValue } from '@hunterzhu/pulse-runtime'
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
/** Read only this lane's settled observations. UI text is evidence, never authority. */
export function automationApprovalEvidence(runtime: PulseRuntime | undefined, effect: Parameters<EffectExecutor>[0]): JsonValue | undefined {
  const input = record(effect.input), args = record(input?.arguments)
  if (!runtime || !/^(browser|computer)\./.test(input?.name ?? '') || typeof args?.sessionId !== 'string') return undefined
  let observed: Record<string, any> | undefined
  const actions: JsonValue[] = []
  for (const previous of runtime.state.effects.values()) {
    if (previous.ownerLaneId !== effect.ownerLaneId || previous.kind !== 'tool') continue
    const call = record(previous.input), priorArgs = record(call?.arguments)
    if (priorArgs?.sessionId !== args.sessionId) continue
    if (/^(browser|computer)\.observe$/.test(call?.name ?? '') && previous.outcome?.status === 'succeeded' && previous.outcome.resultRef) {
      const value = record(runtime.state.results.get(previous.outcome.resultRef)?.value)
      if (value && (!args.frameId || value.frameId === args.frameId)) observed = value
    }
    if (/^(browser|computer)\.act$/.test(call?.name ?? '') && previous.outcome) actions.push({ tool: call!.name, action: priorArgs.action ?? null, status: previous.outcome.status })
  }
  return { observedTarget: observed ? { sessionId: args.sessionId, frameId: observed.frameId ?? null, title: observed.title ?? '', url: observed.url ?? '', text: String(observed.text ?? '').slice(0, 12000), truncated: String(observed.text ?? '').length > 12000 } : null, priorActions: actions.slice(-12), priorActionsTruncated: actions.length > 12 }
}
