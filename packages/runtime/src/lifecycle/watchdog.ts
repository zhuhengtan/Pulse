import { contentHash } from '../context/builder.js'
import { provenanceRefId } from '../core/types.js'
import type { JsonValue, LaneRecord, LaneStepOutput, ProgressWatchdogState, RuntimeError, RuntimeState } from '../core/types.js'

export interface ProgressWatchdogOptions {
  windowSize?: number
  noProgressThreshold?: number
  repeatedActionThreshold?: number
  admission?: boolean
}

export interface ProgressObservation {
  state: ProgressWatchdogState
  fingerprint: string
  progressed: boolean
  repeatedActionCount: number
  rejected?: RuntimeError
}

function withoutSdk(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutSdk)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$sdk').map(([key, item]) => [key, withoutSdk(item)]))
}

function canonical(value: JsonValue, key?: string): JsonValue {
  if (key === 'id' || key === 'effectId' || key === 'attemptId' || key === 'toolCallId' || key === 'requestId' || key === 'providerId' || key === 'timestamp' || key === 'seq' || key === 'telemetry') return null
  if (Array.isArray(value)) return value.map((item) => canonical(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== 'derivedFrom').sort(([left], [right]) => left.localeCompare(right)).map(([entryKey, item]) => [entryKey, canonical(item, entryKey)]))
}

function actionSignature(output: LaneStepOutput): string {
  return contentHash(output.actions.map((action) => canonical(action as unknown as JsonValue)))
}

function resultSignature(output: LaneStepOutput, state: RuntimeState): string | undefined {
  const refs = output.actions.flatMap((action) => 'derivedFrom' in action && action.derivedFrom ? action.derivedFrom : [])
  const results = refs.map((ref) => state.results.get(provenanceRefId(ref))?.value).filter((value): value is JsonValue => value !== undefined)
  const terminalResults = output.actions.filter((action) => action.type === 'complete').map((action) => action.result)
  const all = [...results, ...terminalResults]
  return all.length ? contentHash(all.map((value) => canonical(value))) : undefined
}

function progressKey(lane: LaneRecord, output: LaneStepOutput): string {
  return contentHash({ goal: canonical(lane.goal), contextVersion: lane.context.version, context: canonical(lane.context.state), resumeStep: output.next.step, localsHash: contentHash(withoutSdk(output.next.locals)) })
}

export function progressFingerprint(lane: LaneRecord, output: LaneStepOutput, state: RuntimeState): string {
  const action = actionSignature(output)
  const result = resultSignature(output, state)
  return contentHash({ goalStateHash: contentHash({ goal: canonical(lane.goal), context: canonical(lane.context.state) }), contextVersion: lane.context.version, actionSignature: action, ...(result === undefined ? {} : { resultSignature: result }), resumeStep: output.next.step, localsHash: contentHash(withoutSdk(output.next.locals)) })
}

export function observeProgress(lane: LaneRecord, output: LaneStepOutput, state: RuntimeState, previous?: ProgressWatchdogState, options: ProgressWatchdogOptions = {}): ProgressObservation {
  const fingerprint = progressFingerprint(lane, output, state)
  const windowSize = options.windowSize ?? 8
  const threshold = Math.max(1, options.noProgressThreshold ?? 3)
  const repeatedThreshold = Math.max(1, options.repeatedActionThreshold ?? 3)
  const prior = previous ?? { window: [], noProgressCount: 0, interventionLevel: 0 as const }
  const action = actionSignature(output)
  const progress = progressKey(lane, output)
  const priorActions = prior.actionSignatures ?? []
  const priorProgress = prior.progressKeys ?? []
  const repeatedActionCount = priorActions.filter((candidate) => candidate === action).length + 1
  const sameProgress = priorProgress.at(-1) === progress
  const progressed = prior.lastFingerprint === undefined || !sameProgress
  const qualifies = sameProgress && repeatedActionCount >= repeatedThreshold
  const noProgressCount = qualifies ? prior.noProgressCount + 1 : sameProgress ? prior.noProgressCount : 0
  const reached = qualifies && noProgressCount >= threshold
  if (reached && options.admission) {
    const interventionLevel = Math.min(3, prior.interventionLevel + 1) as 0 | 1 | 2 | 3
    const rejection: RuntimeError = { code: interventionLevel >= 3 ? 'NO_PROGRESS_DETECTED' : 'WATCHDOG_REPLAN_REQUIRED', message: interventionLevel >= 3 ? 'Lane made no observable progress within the watchdog threshold.' : 'Lane repeated an action without material progress; change strategy before retrying.', details: { repeatedActionCount, noProgressCount, interventionLevel } }
    return { fingerprint, progressed: false, repeatedActionCount, rejected: rejection, state: { ...prior, noProgressCount: 0, interventionLevel, lastReason: rejection.code } }
  }
  const interventionLevel = progressed ? 0 : Math.max(prior.interventionLevel, Math.min(3, Math.floor(noProgressCount / threshold))) as 0 | 1 | 2 | 3
  const window = [...prior.window, fingerprint].slice(-windowSize)
  const actionSignatures = [...priorActions, action].slice(-windowSize)
  const progressKeys = [...priorProgress, progress].slice(-windowSize)
  return { fingerprint, progressed, repeatedActionCount, state: { window, actionSignatures, progressKeys, noProgressCount, interventionLevel, lastFingerprint: fingerprint, ...(interventionLevel === 0 ? {} : { lastReason: 'NO_PROGRESS_DETECTED' }) } }
}
