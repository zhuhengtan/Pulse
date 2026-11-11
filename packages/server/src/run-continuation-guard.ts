import { contentHash, type EffectRecord, type JsonValue, type PulseRuntime } from '@hunterzhu/pulse-runtime'

type Runtime = Pick<PulseRuntime, 'state'>
function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}
function sameOperation(proposed: Readonly<EffectRecord>, name: unknown, input: unknown): boolean {
  const call = record(proposed.input)
  return typeof name === 'string' && call?.name === name && contentHash(call.arguments ?? {}) === contentHash(input ?? {})
}
/** A refused operation stays refused. Unrelated work still goes through normal approval. */
export function assertRunCanContinue(runtime: Runtime | undefined, proposed?: Readonly<EffectRecord>): void {
  // Provider admission and the durable budget ledger govern model attempts.
  // A past tool denial must not prevent the model from selecting an alternative.
  if (!runtime || !proposed || proposed.kind !== 'tool') return
  for (const effect of runtime.state.effects.values()) {
    const error = effect.outcome?.error
    const call = record(effect.input)
    if (effect.kind === 'tool' && sameOperation(proposed, call?.name, call?.arguments)) {
      const manualGrant = error?.code.startsWith('AI_APPROVAL_') && record(error.details)?.manualApproval === true && [...runtime.state.effects.values()].some(human => {
        const answer = human.kind === 'human' && human.outcome?.resultRef ? record(runtime.state.results.get(human.outcome.resultRef)?.value) : undefined
        const tools = record(human.input)?.tools
        const originId = record(error.details)?.originalEffectId
        const origin = typeof originId === 'string' ? runtime.state.effects.get(originId) : effect
        const operation = record(origin?.input)
        return origin?.outcome?.error?.code === error.code && record(origin.outcome.error.details)?.manualApproval === true && answer?.approved === true && Array.isArray(tools) && tools.some(value => { const tool = record(value); return tool?.toolCallId === `manual:${origin?.id}` && tool?.toolName === operation?.name && contentHash(tool?.input ?? {}) === contentHash(operation?.arguments ?? {}) })
      })
      if (manualGrant) continue
      if (error && ['APPROVAL_DENIED', 'AI_APPROVAL_DENIED'].includes(error.code)) throw Object.assign(new Error(error.message), error)
      if (effect.outcome?.status === 'cancelled' && effect.outcome.reason !== 'CONTROLLER_TAKEOVER_PENDING_OPERATION') throw Object.assign(new Error('This operation was cancelled; choose another authorized method.'), { code: 'TOOL_CANCELLED', retryable: false })
    }
    if (effect.kind === 'human' && effect.outcome?.resultRef) {
      const reply = record(runtime.state.results.get(effect.outcome.resultRef)?.value)
      const tools = record(effect.input)?.tools
      if (reply?.approved === false && Array.isArray(tools) && tools.some(value => { const tool = record(value); return sameOperation(proposed, tool?.toolName, tool?.input) })) throw Object.assign(new Error(typeof reply.reason === 'string' ? reply.reason : 'User denied this operation.'), { code: 'APPROVAL_DENIED', retryable: false })
    }
  }
}
