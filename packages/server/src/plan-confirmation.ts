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
