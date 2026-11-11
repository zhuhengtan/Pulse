import type { RuntimeState, JsonValue } from '@hunterzhu/pulse-runtime'
import type { TaskOutcome } from '../task.js'

export function outcomeDiagnostics(state: RuntimeState, stages: Array<Record<string, JsonValue>>, errorCode?: string, native?: { code: string; reason: string }): Pick<TaskOutcome, 'blockers' | 'interventions'> {
  const humans = [...state.effects.values()].filter(e => e.kind === 'human')
  const approvals = humans.filter(e => {
    const input = e.input as Record<string, JsonValue> | undefined
    return Array.isArray(input?.tools) || typeof input?.digest === 'string' || String(input?.decisionId ?? '').startsWith('plan-execution:')
  })
  const blocked = stages.filter(s => s.status === 'blocked' && Number(s.attempts) > 0).map(s => ({ stageId: String(s.id), reason: String(s.note ?? 'Unverified stage').slice(0, 1000) }))
  if (!blocked.length && errorCode) blocked.push({ stageId: '', reason: errorCode })
  // A later generic stage failure must not hide the original native freshness failure that nothing repaired.
  if (native && !blocked.some(item => item.reason.includes(native.code))) blocked.unshift({ stageId: '', reason: native.reason.slice(0, 1000) })
  return {
    interventions: { approvalRequests: approvals.length, clarificationRequests: humans.length - approvals.length },
    blockers: blocked.map(({ stageId, reason }) => {
      const code = native && reason === native.reason.slice(0, 1000) ? native.code : reason.match(/\b(?:[A-Z][A-Z0-9]*_)+[A-Z0-9_]+\b/)?.[0] ?? errorCode ?? 'TASK_UNVERIFIED'
      const recovery = /BUDGET/.test(code) ? 'request-budget' : /APPROVAL|DENIED|PERMISSION/.test(code) ? 'request-authorization' : /EVIDENCE_CHANGED/.test(code) ? 'reverify-current-inputs' : /INVALID_TOOL_INPUT|CONTROL_ERROR/.test(code) ? 'correct-arguments' : /UNKNOWN|IN_DOUBT/.test(code) ? 'reconcile-before-retry' : /PROVIDER|CAPABILITY|BROWSER|SANDBOX|CHECK_ENVIRONMENT_BLOCKED|AUTOMATION_RECONNECT_REQUIRED/.test(code) ? 'restore-environment' : 'inspect-checkpoint'
      return { ...(stageId ? { stageId } : {}), code, reason, recovery }
    }),
  }
}
