import { contentHash } from '../context/builder.js'
import type { JsonValue, LaneRecord, LaneStepOutput, ProgressWatchdogState, RuntimeState } from '../core/types.js'

export interface ProgressWatchdogOptions {
  windowSize?: number
  noProgressThreshold?: number
}

export interface ProgressObservation {
  state: ProgressWatchdogState
  fingerprint: string
  progressed: boolean
}

function withoutSdk(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutSdk)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$sdk').map(([key, item]) => [key, withoutSdk(item)]))
}

export function progressFingerprint(lane: LaneRecord, output: LaneStepOutput, state: RuntimeState): string {
  const resultRefs = output.actions.flatMap((action) => action.type === 'complete' && action.derivedFrom ? action.derivedFrom : [])
  return contentHash({ goal: lane.goal, contextVersion: lane.context.version, context: lane.context.state, actions: output.actions, resultRefs, next: { ...output.next, locals: withoutSdk(output.next.locals) }, sourceResults: resultRefs.map((ref) => state.results.get(ref)?.id ?? ref) })
}

export function observeProgress(lane: LaneRecord, output: LaneStepOutput, state: RuntimeState, previous?: ProgressWatchdogState, options: ProgressWatchdogOptions = {}): ProgressObservation {
  const fingerprint = progressFingerprint(lane, output, state)
  const windowSize = options.windowSize ?? 8
  const threshold = Math.max(1, options.noProgressThreshold ?? 3)
  const prior = previous ?? { window: [], noProgressCount: 0, interventionLevel: 0 as const }
  const progressed = prior.lastFingerprint === undefined || prior.lastFingerprint !== fingerprint
  const noProgressCount = progressed ? 0 : prior.noProgressCount + 1
  const interventionLevel = progressed ? 0 : Math.min(3, Math.floor(noProgressCount / threshold)) as 0 | 1 | 2 | 3
  const window = [...prior.window, fingerprint].slice(-windowSize)
  return { fingerprint, progressed, state: { window, noProgressCount, interventionLevel, lastFingerprint: fingerprint, ...(interventionLevel === 0 ? {} : { lastReason: 'NO_PROGRESS_DETECTED' }) } }
}
