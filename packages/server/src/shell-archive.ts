import type { PulseRuntime } from '@hunterzhu/pulse-runtime'

/** An archive is readable only wherever its original command result was visible. */
export function canReadShellArchive(runtime: PulseRuntime, laneId: string, id: unknown): boolean {
  const lane = runtime.state.lanes.get(laneId)
  if (!lane || typeof id !== 'string') return false
  for (const effect of runtime.state.effects.values()) {
    const input = effect.input
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.name !== 'shell.exec' || !effect.outcome?.resultRef) continue
    const result = runtime.state.results.get(effect.outcome.resultRef)
    if (!result || result.privacy !== 'public' || result.privacyTaints?.length || lane.visibleResultRefs && !lane.visibleResultRefs.has(result.id)) continue
    const value = result.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const archive = value.outputArchive
    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) continue
    if (Object.values(archive).some(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === id)) return true
  }
  return false
}
