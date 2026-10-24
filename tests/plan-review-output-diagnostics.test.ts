import { expect, it } from 'vitest'
import { assessPlanReview, planReviewOutputDiagnostics } from '../packages/server/src/plan-consistency.js'

const content = '# Plan\nRead `input.txt` before implementing the requested change.\n'
const review = () => ({ checks: ['dependencies', 'prerequisites', 'state', 'scope', 'validation'].map(area => ({ area, status: 'passed', reason: 'Checked', evidence: [content] })), nodes: [{ id: 'read', requires: [] as string[], evidence: '# Plan' }], issues: [] })

it('identifies invalid JSON and exact schema fields without accepting the output', () => {
  expect(planReviewOutputDiagnostics(content, '```json\n{}\n```')[0]).toMatchObject({ field: '$', code: 'INVALID_JSON' })
  const value = review(); value.checks.push(value.checks[0]!)
  expect(planReviewOutputDiagnostics(content, JSON.stringify(value))[0]?.field).toBe('checks')
  expect(assessPlanReview('p', 'h', content, JSON.stringify(value)).status).toBe('unavailable')
})

it('pinpoints altered Markdown quotations while exact source quotations remain valid', () => {
  const value = review(); value.checks[0]!.evidence = ['Read input.txt before implementing the requested change.']
  expect(planReviewOutputDiagnostics(content, JSON.stringify(value))).toContainEqual(expect.objectContaining({ field: 'checks.0.evidence.0', code: 'QUOTE_NOT_FOUND' }))
  expect(assessPlanReview('p', 'h', content, JSON.stringify(value)).status).toBe('unavailable')
  expect(planReviewOutputDiagnostics(content, JSON.stringify(review()))).toEqual([])
})

it('explains invalid graph references and keeps repair feedback within the instruction budget', () => {
  const value = review(); value.nodes[0]!.requires = ['absent']
  expect(planReviewOutputDiagnostics(content, JSON.stringify(value))).toContainEqual(expect.objectContaining({ code: 'INVALID_DEPENDENCY' }))
  for (const check of value.checks) check.evidence = Array(8).fill('不存在的引文'.repeat(100))
  const details = planReviewOutputDiagnostics(content, JSON.stringify(value))
  expect(details.length).toBeGreaterThan(0)
  expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThanOrEqual(850)
})
