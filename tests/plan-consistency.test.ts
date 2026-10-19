import { describe, expect, it } from 'vitest'
import { assessPlanReview, isReadyPlanReview, planReviewAreas } from '../packages/server/src/plan-consistency.js'

const path = 'docs/plans/revised.md', hash = 'version-3'
const content = '# V3\n步骤5：P1未解决前不得进入步骤6。\nP1：步骤6完成并取得旧测试失败证据后才能更新基线。\n卡片始终保留，处理中两按钮互斥禁用。\n'
const good = () => ({ checks: planReviewAreas.map(area => ({ area, status: 'passed', reason: 'Whole-document check completed', evidence: ['# V3'] })), nodes: [] as Array<{ id: string; requires: string[]; evidence: string; unresolved?: boolean }>, issues: [] as Array<{ code: string; message: string; evidence: string[] }> })
const assess = (value: unknown, document = content) => assessPlanReview(path, hash, document, typeof value === 'string' ? value : JSON.stringify(value))
const simple = '# V3\n范围只包括现有文档。\n验证方式是对照原文。\n'

describe('whole-plan consistency assessment', () => {
  it('overrides an affirmative reviewer when a gate depends on the step it gates (V3 regression)', () => {
    const review = good()
    review.nodes = [{ id: 'step6', requires: ['P1'], evidence: '步骤5：P1未解决前不得进入步骤6。' }, { id: 'P1', requires: ['step6'], evidence: 'P1：步骤6完成并取得旧测试失败证据后才能更新基线。' }]
    expect(assess(review)).toMatchObject({ status: 'blocked', issues: [expect.objectContaining({ code: 'PLAN_DEPENDENCY_CYCLE' })] })
  })

  it('detects self-dependencies as well as cycles through external gates', () => {
    const review = good(); review.nodes = [{ id: 'handoff', requires: ['handoff'], evidence: '# V3' }]
    expect(assess(review).issues[0]?.code).toBe('PLAN_DEPENDENCY_CYCLE')
  })

  it('does not treat a genuinely unresolved prerequisite as executable', () => {
    const review = good(); review.nodes = [{ id: 'P1', requires: [], unresolved: true, evidence: '# V3' }]
    const assessed = assess(review)
    expect(assessed.status).toBe('blocked')
    expect(assessed.issues.map(issue => issue.code)).toContain('PLAN_PREREQUISITE_UNRESOLVED')
  })

  it('preserves semantic contradictions even when the dependency graph is acyclic', () => {
    const review = good(); review.issues = [{ code: 'PENDING_VISIBILITY_CONFLICT', message: 'One section hides the card while another keeps its buttons visible.', evidence: ['卡片始终保留，处理中两按钮互斥禁用。'] }]
    expect(assess(review).status).toBe('blocked')
  })

  it.each(['dependencies', 'prerequisites', 'state', 'scope', 'validation'] as const)('requires the %s check even after a narrowly requested revision', area => {
    const review = good(); review.checks = review.checks.filter(check => check.area !== area)
    expect(assess(review).status).toBe('unavailable')
  })

  it('rejects duplicate checks, fabricated quotations and dangling/duplicate node IDs', () => {
    const duplicate = good(); duplicate.checks[1] = duplicate.checks[0]!
    expect(assess(duplicate).status).toBe('unavailable')
    const invented = good(); invented.checks[0]!.evidence = ['This quotation is not in the plan.']
    expect(assess(invented).issues[0]?.code).toBe('PLAN_REVIEW_UNGROUNDED')
    const dangling = good(); dangling.nodes = [{ id: 's1', requires: ['missing'], evidence: '# V3' }]
    expect(assess(dangling).issues[0]?.code).toBe('PLAN_REVIEW_GRAPH_INVALID')
    dangling.nodes = [{ id: 's1', requires: [], evidence: '# V3' }, { id: 's1', requires: [], evidence: '# V3' }]
    expect(assess(dangling).issues[0]?.code).toBe('PLAN_REVIEW_GRAPH_INVALID')
  })

  it('fails closed on unavailable/unknown/malformed reviews, including approval-shaped prose', () => {
    for (const value of ['APPROVE', 'ready', '{}', '```json\n{}\n```']) expect(assess(value).status).toBe('unavailable')
    const review = good(); (review.checks[0] as { status: string }).status = 'unknown'
    expect(assess(review).status).toBe('blocked')
  })

  it('rejects a ready verdict that leaves a stated hard dependency out of the graph', () => {
    expect(assess(good()).issues.map(issue => issue.code)).toContain('PLAN_DEPENDENCY_UNDECLARED')
    const quoted = good()
    quoted.nodes = [{ id: 'step6', requires: [], evidence: '步骤5：P1未解决前不得进入步骤6。' }]
    expect(assess(quoted).issues.map(issue => issue.code)).toContain('PLAN_DEPENDENCY_UNDECLARED')
  })

  it('accepts sub-clause quotations covering gate lines without false-positive undeclared dependency', () => {
    const doc = '# V3\n- 步骤5：在P1解决前不得进入步骤6。\nP1：环境准备完毕。\n'
    const review = good()
    review.checks.forEach(check => { check.evidence = ['- 步骤5：在P1解决前不得进入步骤6。'] })
    review.nodes = [{ id: 'step6', requires: ['P1'], evidence: '在P1解决前不得进入步骤6' }, { id: 'P1', requires: [], evidence: 'P1：环境准备完毕。' }]
    const assessed = assess(review, doc)
    expect(assessed.issues.some(issue => issue.code === 'PLAN_DEPENDENCY_UNDECLARED')).toBe(false)
  })

  it('binds a valid review to exactly one saved plan version', () => {
    const review = assess(good(), simple)
    expect(review.status).toBe('ready')
    expect(isReadyPlanReview(review, path, hash)).toBe(true)
    expect(isReadyPlanReview(review, path, 'version-4')).toBe(false)
    expect(isReadyPlanReview(review, 'docs/plans/other.md', hash)).toBe(false)
    expect(isReadyPlanReview({ ...review, checks: [] }, path, hash)).toBe(false)
    expect(isReadyPlanReview({ ...review, nodes: [{ id: 'a', requires: ['b'], evidence: '# V3' }, { id: 'b', requires: ['a'], evidence: '# V3' }] }, path, hash)).toBe(false)
    expect(isReadyPlanReview({ ...review, nodes: [{ id: 'p', requires: [], unresolved: true, evidence: '# V3' }] }, path, hash)).toBe(false)
  })
})
