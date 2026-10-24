/** Explicit natural-language sequencing is a gate, even without a skill command. */
export function requiresExplicitPlanConfirmation(text: string): boolean {
  if (/无需确认|不用确认|不必确认|无需批准|\b(?:without approval|no confirmation needed)\b/i.test(text)) return false
  // 「确认计划后再实现」names the plan inside the confirmation phrase. A plan
  // word that only appears later, as in 「先确认阈值后写计划」, is not this gate.
  const confirmation = /(?:确认|批准|审批)(?:一下)?(?:(?:该|此)?(?:计划|方案))?后(?:再)?|\b(?:after|once)\b.{0,45}\b(?:approve\w*|confirm\w*|approval|confirmation)\b/i.exec(text)
  if (!confirmation || !/实现|实施|执行|修改|开发|\b(?:implement|execute|develop|edit)\b/i.test(text.slice(confirmation.index))) return false
  if (/计划|方案|\bplan\b/i.test(confirmation[0])) return true
  const plan = /计划|方案|\bplan\b/i.exec(text)
  return !!plan && plan.index < confirmation.index
}

/** Shared by the Host gate and the offline evaluator. Values are opaque IDs. */
export function planConfirmationOptions(input: unknown): { defer: string; execute: string } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const row = input as Record<string, unknown>
  if ((row.type !== undefined && row.type !== 'choice') || (row.toolName !== undefined && row.toolName !== 'ask.choice') || (row.kind !== undefined && row.kind !== 'ask')) return undefined
  if (!Array.isArray(row.options) || row.options.length !== 2) return undefined
  const options = row.options.map(option => {
    if (typeof option === 'string') return { label: option, value: option }
    if (!option || typeof option !== 'object' || Array.isArray(option)) return undefined
    const item = option as Record<string, unknown>
    return typeof item.label === 'string' && typeof item.value === 'string' ? { label: item.label, value: item.value } : undefined
  })
  const [first, second] = options
  // Only known affirmative annotations are accepted; contradictory promises cannot authorize implementation.
  if (!first || !second || !/^暂不执行(?:[（(](?:默认(?:[，,](?:保留|保持)计划)?|(?:保留|保持)计划)[）)])?$/.test(first.label.trim()) || !/^执行(?:[（(]开始(?:实施|执行|P\d+(?:[–—-]P?\d+)?)[）)])?$/.test(second.label.trim())) return undefined
  if (!first.value || !second.value || first.value === second.value) return undefined
  return { defer: first.value, execute: second.value }
}

/** Exact, unconditional human decisions only; a substring never grants authority. */
export function explicitPlanDecision(input: unknown, answer: unknown): 'approved' | 'deferred' | undefined {
  const choices = planConfirmationOptions(input)
  if (!choices || !answer || typeof answer !== 'object' || Array.isArray(answer)) return undefined
  const row = answer as Record<string, unknown>
  if (row.approved === false) return 'deferred'
  const selected = row.value === choices.execute ? 'approved' : row.value === choices.defer ? 'deferred' : undefined
  const text = typeof row.text === 'string' ? row.text.trim().replace(/[。！!.]+$/, '').trim() : undefined
  if (text !== undefined && text.length > 0) {
    const written = /^(?:同意执行|确认执行|批准执行|按此方案执行|approve execution|execute the plan)$/i.test(text) ? 'approved'
      : /^(?:暂不执行|不执行|不同意执行|取消执行|不要执行|do not execute|defer execution|cancel execution)$/i.test(text) ? 'deferred' : undefined
    // A conflicting selected option and free-text explanation is not consent.
    return written && (!selected || selected === written) ? written : undefined
  }
  return selected
}

/** Free-form feedback is data for plan repair, never an execution decision. */
export function planRevisionFeedback(input: unknown, answer: unknown, rejectConditionalDecision = false): string | undefined {
  if (!planConfirmationOptions(input) || !answer || typeof answer !== 'object' || Array.isArray(answer) || explicitPlanDecision(input, answer) !== undefined) return undefined
  const row = answer as Record<string, unknown>
  // Conflicting selected options/approval fields must stay pending.
  if (row.value !== undefined || row.values !== undefined || row.approved !== undefined || typeof row.text !== 'string') return undefined
  const text = row.text.trim()
  if (rejectConditionalDecision && /^(?:同意执行|确认执行|批准执行|按此方案执行|approve execution\b|execute the plan\b)/i.test(text)) return undefined
  return text.length > 0 && text.length <= 4000 ? text : undefined
}
