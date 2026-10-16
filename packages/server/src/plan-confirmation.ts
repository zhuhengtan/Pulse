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
