import { z } from 'zod'
import type { JsonValue, StepContext } from '@hunterzhu/pulse-runtime'
import type { AcceptanceCriterion, TaskRecord } from '../task.js'

const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]))

/** Supplied by the Host caller, never by a planner or a candidate tool result. */
export const acceptanceCheckSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  criterionIds: z.array(z.string()).min(1),
  toolName: z.string().min(1),
  input: z.record(jsonValue),
  expectedChecks: z.array(z.string().min(1)).min(1).max(64),
  assertionCriterionIds: z.record(z.array(z.string()).min(1)).optional(),
  covers: z.array(z.enum(['valid-entry', 'invalid-value', 'conflicting-options', 'duplicate-option', 'missing-value'])).default([]),
})
export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>
export interface AcceptanceResult { checks?: Array<{ id: string; passed: boolean; detail?: string }>; id: string; ref?: string; status: 'passed' | 'failed' | 'unverifiable'; reason: string }

/** Conservative scope: a request to reject invalid CLI budgets/parameters. */
export function requiredArgumentChecks(record: Pick<TaskRecord, 'objective' | 'acceptanceCriteria'>): AcceptanceCriterion[] {
  if (!/--[a-z][a-z-]+|\bCLI\b|命令行/i.test(record.objective) || /(?:只|仅)(?:做|需|要)?(?:分析|阅读)|^\s*只读(?:[，,:\s]|$)|不要(?:运行|执行)测试|do not (?:run|execute) (?:any )?(?:tests|checks)\b|read[- ]only (?:analysis|review)/i.test(record.objective)) return []
  const cliObjective = /\bCLI\b|命令行|--(?!(?:test|check)(?:\b|=))[a-z][a-z-]+/i.test(record.objective)
  return record.acceptanceCriteria.filter(c => {
    const httpCriterion = /\b(?:GET|POST|PUT|PATCH|DELETE|HTTP|URL)\b|\/api\/|查询参数/i.test(c.description)
    const cliCriterion = /\bCLI\b|命令行|--(?!(?:test|check)(?:\b|=))[a-z][a-z-]+/i.test(c.description)
    return (cliCriterion || cliObjective && !httpCriterion) && /非法|无效|invalid|malformed/i.test(c.description) && /预算|参数|budget|argument|option/i.test(c.description) && /失败|拒绝|报错|fail|reject|error/i.test(c.description)
  })
}
export const argumentCheckKinds = ['valid-entry', 'invalid-value', 'conflicting-options', 'duplicate-option', 'missing-value'] as const

export function validateAcceptanceChecks(value: unknown, criteria: AcceptanceCriterion[], tools: readonly string[]): AcceptanceCheck[] {
  const checks = z.array(acceptanceCheckSchema).max(16).parse(value ?? [])
  const ids = new Set(criteria.map(c => c.id))
  if (new Set(checks.map(c => c.id)).size !== checks.length || checks.some(c => !tools.includes(c.toolName) || c.criterionIds.some(id => !ids.has(id)) || new Set(c.expectedChecks).size !== c.expectedChecks.length || c.assertionCriterionIds !== undefined && (Object.keys(c.assertionCriterionIds).length !== c.expectedChecks.length || c.expectedChecks.some(key => !c.assertionCriterionIds?.[key]?.length) || Object.entries(c.assertionCriterionIds).some(([key, values]) => !c.expectedChecks.includes(key) || values.some(id => !c.criterionIds.includes(id)))))) throw new Error('ACCEPTANCE_CONTRACT_INVALID')
  return structuredClone(checks)
}

export function assessAcceptanceResult(ctx: Pick<StepContext<JsonValue>, 'results'>, check: AcceptanceCheck, ref?: string): AcceptanceResult {
  const meta = ref ? ctx.results.meta(ref) : undefined, body = ref ? ctx.results.read(ref) : undefined
  const base = { id: check.id, ...(ref ? { ref } : {}) }
  if (!meta || meta.effectKind !== 'tool' || meta.toolName !== check.toolName || meta.outcomeStatus !== 'succeeded' || !body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.checks)) return { ...base, status: 'unverifiable', reason: 'Independent check unavailable, denied, or returned an invalid receipt.' }
  return { ...assessAcceptanceValue(check, body), ...base }
}

/** Validate an actual Host terminal execution without inventing a Runtime ResultRef. */
export function assessAcceptanceValue(check: AcceptanceCheck, body: JsonValue | undefined): AcceptanceResult {
  const base = { id: check.id }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.checks)) return { ...base, status: 'unverifiable', reason: 'Independent check returned an invalid receipt.' }
  const rows = body.checks.filter((r): r is Record<string, JsonValue> => !!r && typeof r === 'object' && !Array.isArray(r))
  if (rows.length !== body.checks.length || rows.length !== check.expectedChecks.length || check.expectedChecks.some(id => rows.filter(r => r.id === id).length !== 1) || rows.some(r => typeof r.passed !== 'boolean')) return { ...base, status: 'unverifiable', reason: 'Independent check omitted, duplicated, or changed a frozen assertion.' }
  const checks = rows.map(r => ({ id: String(r.id), passed: r.passed === true, ...(typeof r.detail === 'string' ? { detail: r.detail } : {}) }))
  const failed = rows.filter(r => r.passed !== true)
  return failed.length ? { ...base, checks, status: 'failed', reason: failed.map(r => `${r.id}: ${String(r.detail ?? 'failed').slice(0, 180)}`).join('; ').slice(0, 1500) } : { ...base, checks, status: 'passed', reason: 'Every frozen independent assertion passed.' }
}

export function acceptanceFailure(record: TaskRecord, results: AcceptanceResult[], criterionId: string): { status: 'not_met' | 'unverifiable'; reason: string } | undefined {
  const checks = (record.acceptanceChecks ?? []).filter(c => c.criterionIds.includes(criterionId))
  for (const check of checks) {
    const result = results.find(r => r.id === check.id)
    if (result?.status === 'failed' && check.assertionCriterionIds && result.checks) {
      const relevant = result.checks.filter(r => !r.passed && check.assertionCriterionIds?.[r.id]?.includes(criterionId))
      if (!relevant.length) continue
      return { status: 'not_met', reason: `INDEPENDENT_ACCEPTANCE_FAILED: ${check.id}: ${relevant.map(r => `${r.id}: ${r.detail ?? 'failed'}`).join('; ')}` }
    }
    if (!result || result.status !== 'passed') return { status: result?.status === 'failed' ? 'not_met' : 'unverifiable', reason: `INDEPENDENT_ACCEPTANCE_${result?.status === 'failed' ? 'FAILED' : 'UNAVAILABLE'}: ${check.id}: ${result?.reason ?? 'not executed'}` }
  }
  if (requiredArgumentChecks(record).some(c => c.id === criterionId)) {
    const covers = new Set(checks.flatMap(c => c.covers))
    const missing = argumentCheckKinds.filter(k => !covers.has(k))
    if (missing.length) return { status: 'unverifiable', reason: `INDEPENDENT_ACCEPTANCE_REQUIRED: missing ${missing.join(', ')}. Candidate unit tests and source-text assertions cannot prove CLI rejection before side effects.` }
  }
  return undefined
}
