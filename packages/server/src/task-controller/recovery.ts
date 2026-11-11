import { z } from 'zod'

export const failureSchema = z.object({
  code: z.string(),
  phase: z.enum(['execution', 'verification']).optional(),
  category: z.enum(['input', 'verification', 'environment', 'provider', 'capacity', 'permission', 'uncertain', 'implementation', 'budget', 'cancelled']),
  reason: z.string(),
  evidenceRefs: z.array(z.string()),
  action: z.enum(['correct-input', 'verify-current', 'repair-environment', 'alternate-provider', 'reduce-request', 'authorized-alternative', 'reconcile', 'repair-delivery', 'request-budget', 'wait-user']),
  recoverable: z.boolean(),
})
export type FailureRecord = z.infer<typeof failureSchema>
export const recoveryAttemptSchema = z.object({
  id: z.number().int().positive(),
  failures: z.array(failureSchema),
  progressKey: z.string(),
  method: z.string().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  result: z.enum(['pending', 'progress', 'no-progress']),
})
export type RecoveryAttempt = z.infer<typeof recoveryAttemptSchema>

/**
 * Budget stop authority comes only from the failure's own identity: an explicit controller code, or an
 * unprefixed controller note that is exactly the controller phrase. Text quoted inside another failure
 * (test output, tool bodies, an explicit CHECK_FAILED reason) never grants it.
 */
const BUDGET_IDENTITY = /^(?:TASK_MODEL_CALL_BUDGET_[A-Z_]+|MODEL_BUDGET_CHECKPOINT|STAGE_BUDGET_EXHAUSTED)$/
function controlledBudgetStop(code: string, reason: string): boolean {
  if (BUDGET_IDENTITY.test(code)) return true
  return code === 'DELIVERY_UNMET' && /^Total model budget exhausted\.?$/.test(reason.trim())
}

/** Normalize at the error boundary. Decisions after this point use typed facts. */
export function failureRecord(code: string, reason: string, evidenceRefs: string[] = []): FailureRecord {
  const base = { code, reason: reason.slice(0, 2000), evidenceRefs: [...new Set(evidenceRefs)] }
  if (controlledBudgetStop(code, reason)) return { ...base, category: 'budget', action: 'request-budget', recoverable: false }
  if (/USER_REQUESTED|USER_CANCELLED|USER_DEFERRED|PLAN_EXECUTION_DEFERRED|PLAN_CONFIRMATION_PENDING|HISTORY_CONTINUATION_DECLINED/.test(code)) return { ...base, category: 'cancelled', action: 'wait-user', recoverable: false }
  if (/(?:SIDE_EFFECT|OPERATION|REMOTE)_UNKNOWN|IN_DOUBT|RECONCILE_REQUIRED|^UNKNOWN$/.test(code)) return { ...base, category: 'uncertain', action: 'reconcile', recoverable: true }
  if (/APPROVAL|DENIED|PERMISSION|EACCES|EPERM|PATH_OUTSIDE_SANDBOX|UNAUTHORIZED/.test(code) || /not authorized|permission denied|operation not permitted|access denied|审批被拒|权限不足|隐私授权|拒绝访问/i.test(reason)) return { ...base, category: 'permission', action: 'authorized-alternative', recoverable: true }
  if (/INVALID_TOOL_INPUT|CONTROL_ERROR|SCHEMA|ARGUMENT/.test(code)) return { ...base, category: 'input', action: 'correct-input', recoverable: true }
  if (/OUTPUT_TRUNCATED|REASONING_OUTPUT_EXHAUSTED|CONTEXT|SOURCE_DELIVERY_COVERAGE/.test(code)) return { ...base, category: 'capacity', action: 'reduce-request', recoverable: true }
  if (/PROVIDER|NO_ELIGIBLE_MODEL|MODEL_ATTEMPT_LIMIT_REACHED|UNKNOWN_MODEL|ENOTFOUND|EAI_AGAIN|NETWORK/.test(code)) return { ...base, category: 'provider', action: 'alternate-provider', recoverable: true }
  if (/ENVIRONMENT|SANDBOX|BROWSER|AUTOMATION|CAPABILITY|SERVICE|UNKNOWN_TOOL|TOOL_NOT_FOUND|ENOENT/.test(code)) return { ...base, category: 'environment', action: 'repair-environment', recoverable: true }
  if (/VERIF|EVIDENCE|CITATION|SOURCE_CLAIM|PROGRESS_REVIEW/.test(code)) return { ...base, category: 'verification', action: 'verify-current', recoverable: true }
  return { ...base, category: 'implementation', action: 'repair-delivery', recoverable: true }
}
export function failureFromNote(note: string, refs: string[] = []): FailureRecord {
  const tokens = note.match(/\b(?:[A-Z][A-Z0-9]*_)+[A-Z0-9_]+\b/g) ?? []
  // A budget identity counts only as the note's own leading identity, never when quoted in the body.
  const lead = note.trimStart()
  const code = tokens.find(token => !BUDGET_IDENTITY.test(token) || lead.startsWith(`${token}:`) || lead === token) ?? 'DELIVERY_UNMET'
  return failureRecord(code, note, refs)
}
export function recoveryInstruction(failures: FailureRecord[]): string {
  return `Continue the ORIGINAL objective from existing artifacts and settled evidence. Diagnose the failed method and choose a materially different authorized approach. Do not restart completed implementation. Verification failures require fresh or repaired verification, not speculative rewrites. Preserve original requirements and frozen checks. A denied operation may have an authorized alternative; never repeat or bypass the denial. Reconcile uncertain side effects before any replay. Record the method and its actual result. Failure facts: ${JSON.stringify(failures.map(failure => ({ ...failure, reason: failure.reason.slice(0, 500), evidenceRefs: failure.evidenceRefs.slice(-4), evidenceCount: failure.evidenceRefs.length })))}`
}
