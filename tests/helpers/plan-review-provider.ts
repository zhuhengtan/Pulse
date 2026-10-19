/** Decode only the isolated review request, never instructions retained in history. */
export function planReviewRequest(body: string): { path: string; hash: string; content: string } | undefined {
  const request = JSON.parse(body)
  if (!request.messages?.some((message: any) => message.role === 'system' && String(message.content).includes('Pulse whole-plan consistency reviewer'))) return undefined
  const find = (value: any, depth: number): any => {
    if (depth > 8 || !value) return undefined
    if (typeof value === 'string') { try { return find(JSON.parse(value), depth + 1) } catch { return undefined } }
    if (value.savedPlan?.content !== undefined) return value.savedPlan
    for (const child of Array.isArray(value) ? value : Object.values(value)) { const plan = find(child, depth + 1); if (plan) return plan }
  }
  return find(request.messages, 0)
}

const gateLine = /不得进入|才能|必须先|前置条件|depends on|only after|must not (?:start|proceed)|before\b.+\b(?:can|may)\b/i
/** Successful reviewer fixture for tests whose subject is an unrelated plan workflow. */
export function consistentPlanReview(body: string): object | undefined {
  const plan = planReviewRequest(body)
  if (!plan) return undefined
  const lines = plan.content.split('\n').map(line => line.trim()).filter(line => line.length >= 8 && gateLine.test(line))
  const neutral = plan.content.split('\n').map(line => line.trim()).find(line => line.length > 0 && !gateLine.test(line)) ?? plan.content.slice(0, 80)
  const nodes = [{ id: 'scope', requires: [], evidence: neutral }, ...lines.map((line, index) => ({ id: `step-${index + 1}`, requires: ['scope'], evidence: line }))]
  return { content: JSON.stringify({ checks: ['dependencies', 'prerequisites', 'state', 'scope', 'validation'].map(area => ({ area, status: 'passed', reason: 'Reviewed the complete fixture plan.', evidence: [plan.content.slice(0, 512)] })), nodes, issues: [] }) }
}
