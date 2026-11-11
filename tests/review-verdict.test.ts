import { expect, it } from 'vitest'
import type { ResultMeta } from '@hunterzhu/pulse-runtime'
import { currentProcessEvidence, successfulReviewEvidence, planVerdict } from '../packages/server/src/review-verdict.js'
import { retainPlanFindings, unavailablePlanReview, type PlanReview } from '../packages/server/src/plan-consistency.js'
import { presentRun, runCompletion } from '../packages/server/src/run-presentation.js'

const meta: ResultMeta = { ref: 'r', privacy: 'public', sizeBytes: 1, hash: 'hash', producer: { kind: 'effect', id: 'e' }, effectKind: 'tool', outcomeStatus: 'succeeded', toolName: 'shell.exec' }
it.each(['fs.read', 'web.fetch'])('accepts a bounded %s page as evidence of its own contents, not a complete source', toolName => {
  const page = toolName === 'fs.read'
    ? { path: 'report.md', hash: 'v1', content: 'page', offset: 0, nextOffset: 4, truncated: true }
    : { url: 'https://example.com/docs', text: 'page', offset: 0, nextOffset: 4, totalChars: 8, sourceTruncated: false, truncated: true }
  expect(successfulReviewEvidence({ ...meta, toolName }, page)).toBe(true)
  for (const broken of [{ ...page, nextOffset: null }, { ...page, nextOffset: 0 }, { ...page, nextOffset: 99 }, { ...page, timedOut: true }, { ...page, sourceTruncated: true }]) {
    expect(successfulReviewEvidence({ ...meta, toolName }, broken)).toBe(false)
  }
  expect(successfulReviewEvidence(meta, page)).toBe(false)
})
it('uses the latest native process receipt without confusing other handles or lanes', () => {
  const values: Record<string, any> = { start: { processId: 'p', laneId: 'a', status: 'running' }, exited: { processId: 'p', laneId: 'a', status: 'exited', code: 1 }, other: { processId: 'p', laneId: 'b', status: 'running' }, read: { content: 'file' } }
  expect(currentProcessEvidence(['start', 'other', 'read', 'exited'], ref => values[ref])).toEqual(['other', 'read', 'exited'])
  expect(successfulReviewEvidence(meta, values.exited)).toBe(false)
})
it('never presents an explicitly skipped review as accepted and preserves real failure precedence', () => {
  expect(presentRun({ state: 'succeeded', completion: { status: 'succeeded', taskOutcome: { status: 'accepted', reviewStatus: 'skipped' } } }).label).toBe('已结束，未复核')
  expect(presentRun({ state: 'failed', completion: { status: 'failed', taskOutcome: { status: 'unverifiable', reviewStatus: 'skipped' } } }).state).toBe('failed')
})
it('distinguishes tool completion from a passing check or settled edit', () => {
  expect(successfulReviewEvidence(meta, { code: 0 })).toBe(true)
  for (const body of [{ code: 1 }, { code: 0, timedOut: true }, { code: 0, truncated: true }, { status: 'running' }, { status: 'unknown' }, { planReview: { status: 'blocked' } }]) expect(successfulReviewEvidence(meta, body)).toBe(false)
  expect(successfulReviewEvidence(meta, { code: 1 }, { expectedFailure: true })).toBe(true)
  expect(successfulReviewEvidence({ ...meta, outcomeStatus: 'failed' }, { code: 0 })).toBe(false)
  expect(successfulReviewEvidence({ ...meta, effectKind: 'llm' }, { text: 'all tests passed' })).toBe(false)
  expect(successfulReviewEvidence({ ...meta, effectKind: 'llm' }, { text: 'requested prose' }, { allowText: true })).toBe(true)
})
it('retains known defects after an unavailable attempt only for the same product and evidence versions', () => {
  const previous: PlanReview = { schemaVersion: 1, path: 'docs/plans/a.md', hash: 'a', inputHash: 'input', status: 'blocked', checks: [], nodes: [], issues: [{ code: 'FAILED_TEST', message: 'The required test failed.', evidence: ['test'] }] }
  const next = { ...unavailablePlanReview(previous.path, previous.hash, 'UNAVAILABLE', 'REVIEW_REQUEST_TIMEOUT'), inputHash: 'input' }
  const retained = retainPlanFindings(previous, next)
  expect(retained.status).toBe('blocked'); expect(retained.issues).toEqual(previous.issues)
  expect(retained.lastAttempt?.diagnostic?.code).toBe('REVIEW_REQUEST_TIMEOUT')
  expect(planVerdict(retained).status).toBe('needs_work')
  expect(retainPlanFindings(previous, { ...next, inputHash: 'new-evidence' }).status).toBe('unavailable')
  expect(retainPlanFindings(previous, { ...next, hash: 'changed' }).status).toBe('unavailable')
})
it('shows unavailable verification separately from failed code and never accepts runtime completion alone', () => {
  const completion = runCompletion({ status: 'succeeded', taskOutcome: { status: 'unverifiable', reviewStatus: 'unavailable' } })
  expect(presentRun({ state: 'succeeded', completion }).label).toContain('复核暂不可用')
  expect(presentRun({ state: 'succeeded', completion: runCompletion({ status: 'succeeded', taskOutcome: { status: 'incomplete', reviewStatus: 'needs_work' } }) }).state).toBe('incomplete')
  expect(presentRun({ state: 'succeeded' }).state).toBe('unverifiable')
})
