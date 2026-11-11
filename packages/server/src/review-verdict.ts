import type { JsonValue } from '@hunterzhu/pulse-runtime'
import type { ResultMeta } from '@hunterzhu/pulse-runtime'
import type { PlanReview } from './plan-consistency.js'

export interface ReviewVerdict {
  status: 'passed' | 'needs_work' | 'unavailable'
  findings: Array<{ code: string; reason: string; evidenceRefs?: string[] }>
}
export function planVerdict(review: PlanReview): ReviewVerdict {
  return { status: review.status === 'ready' ? 'passed' : review.status === 'blocked' ? 'needs_work' : 'unavailable', findings: review.issues.map(issue => ({ code: issue.code, reason: issue.message })) }
}
/** A process start snapshot is historical after the same handle has settled. */
export function currentProcessEvidence(refs: string[], read: (ref: string) => JsonValue | undefined): string[] {
  const latest = new Map<string, string>()
  const identity = (ref: string) => {
    const value = read(ref)
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.processId === 'string'
      ? JSON.stringify([value.processId, value.agentId ?? null, value.laneId ?? null]) : undefined
  }
  for (const ref of refs) { const key = identity(ref); if (key) latest.set(key, ref) }
  return refs.filter(ref => { const key = identity(ref); return !key || latest.get(key) === ref })
}
/** A successful tool invocation is not necessarily a successful check. */
function boundedReadPage(meta: ResultMeta, value: Record<string, JsonValue>): boolean {
  const { offset, nextOffset } = value
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof nextOffset !== 'number' || !Number.isSafeInteger(nextOffset) || nextOffset <= offset) return false
  if (meta.toolName === 'fs.read') return typeof value.path === 'string' && typeof value.hash === 'string' && typeof value.content === 'string' && nextOffset === offset + Buffer.byteLength(value.content, 'utf8')
  if (meta.toolName === 'web.fetch') return value.sourceTruncated === false && typeof value.url === 'string' && typeof value.text === 'string' && nextOffset === offset + value.text.length && typeof value.totalChars === 'number' && Number.isSafeInteger(value.totalChars) && nextOffset < value.totalChars
  return false
}

const sha256 = /^[a-f0-9]{64}$/
function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}
/** A finished file write. Successful fs.write/plan.write receipts have path, bytes and hash; overwrite also has a different beforeHash. Patches count only when changed. An uncommitted stage does not. */
export function durableFileWrite(meta: ResultMeta | undefined, value: JsonValue | undefined): boolean {
  if (!meta || meta.outcomeStatus !== 'succeeded' || meta.effectKind !== 'tool' && meta.effectKind !== 'human') return false
  const body = record(value)
  if (!body || body.changed === false) return false
  const name = meta.toolName
  const pathOk = typeof body.path === 'string' && body.path.length > 0
  const bytesOk = typeof body.bytes === 'number' && Number.isSafeInteger(body.bytes) && body.bytes >= 0
  const hashOk = typeof body.hash === 'string' && sha256.test(body.hash)
  if (name === 'fs.stage') return body.committed === true
  if (name === 'fs.apply_patch' || name === 'fs.apply_patches') return body.changed === true
  if (name === 'fs.write' || name === 'plan.write') return pathOk && bytesOk && hashOk
  if (name === 'fs.overwrite') return pathOk && bytesOk && hashOk && typeof body.beforeHash === 'string' && sha256.test(body.beforeHash) && body.beforeHash !== body.hash
  return body.changed === true || body.committed === true
}

export function successfulReviewEvidence(meta: ResultMeta | undefined, value: JsonValue | undefined, options: { allowText?: boolean; expectedFailure?: boolean } = {}): boolean {
  if (!meta || meta.outcomeStatus !== 'succeeded' || value === undefined) return false
  if (meta.effectKind === 'llm' || !meta.effectKind) return options.allowText === true
  if (meta.effectKind !== 'tool' && meta.effectKind !== 'human') return false
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Native read windows prove only their returned content. Pagination is not
    // lost process output; full-source/claim coverage remains a separate gate.
    if (value.timedOut === true || value.aborted === true || value.sourceTruncated === true || value.truncated === true && !boundedReadPage(meta, value) || value.status === 'running' || value.status === 'unknown') return false
    if (typeof value.code === 'number' && value.code !== 0 && !options.expectedFailure) return false
    if (value.planReview && typeof value.planReview === 'object' && !Array.isArray(value.planReview) && value.planReview.status !== 'ready') return false
  }
  return options.expectedFailure === true || (meta.toolExitCode ?? 0) === 0
}
