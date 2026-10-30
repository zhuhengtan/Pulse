import { estimateHistoryTokens, type PulseRuntime } from '@hunterzhu/pulse-runtime'

export const MIN_READ_BYTES = 3 * 1024
export const MAX_READ_BYTES = 32 * 1024
// JSON can escape each input byte as six bytes. Only fs.read opts into this cap.
export const READ_SUMMARY_BYTES = MAX_READ_BYTES * 6 + 4096

/** Host-owned context estimates only. The model may request a smaller window, never more budget. */
export function adaptiveReadBytes(runtime: PulseRuntime | undefined, laneId: string, requested?: number): number {
  const fallback = Math.min(requested ?? MIN_READ_BYTES, MIN_READ_BYTES)
  const lane = runtime?.state.lanes.get(laneId)
  if (!runtime || !lane) return fallback
  const models = runtime.models.list()
  if (!models.length || models.some(model => !Number.isFinite(model.capabilities.maxContextTokens) || model.capabilities.maxContextTokens <= 0)) return fallback
  const hard = runtime.state.historyHardTokens
  if (!Number.isFinite(hard) || hard <= 0) return fallback
  const history = estimateHistoryTokens(lane.context.history)
  let visibleTokens = 0
  for (const ref of lane.visibleResultRefs ?? []) {
    const result = runtime.state.results.get(ref)
    if (result) visibleTokens += Math.ceil(Buffer.byteLength(JSON.stringify(result.summary ?? result.value ?? null), 'utf8') / 4)
  }
  const modelRoom = Math.min(...models.map(model => model.capabilities.maxContextTokens - (model.capabilities.maxOutputTokens ?? 4096)))
  // Leave room for instructions/tools and the next model response; share room with concurrent reads.
  const remaining = Math.max(0, Math.min(hard, modelRoom - 8192) - history - visibleTokens - 2048)
  const concurrent = [...runtime.state.effects.values()].filter(effect => effect.ownerLaneId === laneId && !effect.outcome && effect.kind === 'tool').length
  const window = Math.max(MIN_READ_BYTES, Math.min(MAX_READ_BYTES, Math.floor(remaining / Math.max(2, concurrent * 2))))
  return Math.min(requested ?? window, window)
}
