import { createHash } from 'node:crypto'
import type { JsonValue, ResultRef } from '@hunterzhu/pulse-runtime'
import { acceptanceCheckSchema, type AcceptanceCheck } from './task-controller/acceptance.js'

export type TaskRecordStatus = 'in_progress' | 'verifying' | 'replanning' | 'accepted' | 'incomplete' | 'unverifiable'

export interface TaskAttempt {
  candidateResultRef: ResultRef
  evidenceRefs: ResultRef[]
  candidateHash?: string
}

/** Durable task state is stored in the Runtime's versioned Global Context. */
export interface TaskRecord {
  schemaVersion: 1
  runId: string
  objective: string
  criteriaParsingVersion?: 2
  continuedFromRunId?: string
  assessments?: TaskCriterionAssessment[]
  acceptanceCriteria: AcceptanceCriterion[]
  acceptanceChecks?: AcceptanceCheck[]
  supersededCriteria?: AcceptanceCriterion[]
  status: TaskRecordStatus
  replanCount: number
  attempts: TaskAttempt[]
  candidateResultRef?: ResultRef
  evidenceRefs: ResultRef[]
  excludedRefs: ResultRef[]
  replanInstruction?: string
}

export interface TaskCriterionAssessment {
  criterionId: string
  status: 'passed' | 'not_met' | 'unverifiable'
  evidenceRefs: ResultRef[]
  rationale: string
}

export interface TaskOutcome {
  blockers?: Array<{ stageId?: string; code: string; reason: string; recovery: string }>
  interventions?: { approvalRequests: number; clarificationRequests: number }
  schemaVersion: 1
  status: 'accepted' | 'incomplete' | 'unverifiable' | 'failed' | 'cancelled'
  verifier: 'llm' | 'host'
  criteria: TaskCriterionAssessment[]
  candidateResultRef?: ResultRef
  evidenceRefs: ResultRef[]
  replanCount: number
  note?: string
  completedAt: string
}

export interface AcceptanceCriterion {
  id: string
  description: string
  kind?: 'requirement' | 'constraint' | 'environment'
  source?: { hash: string; start: number; end: number; document?: string }
}

export const maxTaskReplans = 2

export function taskRecordFromGlobal(global: JsonValue): TaskRecord | undefined {
  if (!global || typeof global !== 'object' || Array.isArray(global)) return undefined
  const record = (global as Record<string, JsonValue>).taskRecord
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const value = record as Record<string, JsonValue>
  if (value.schemaVersion !== 1 || typeof value.runId !== 'string' || typeof value.objective !== 'string') return undefined
  const criteria = Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const criterion = item as Record<string, JsonValue>
    return typeof criterion.id === 'string' && typeof criterion.description === 'string'
      ? [{ id: criterion.id, description: criterion.description, ...(criterion.source && typeof criterion.source === 'object' && !Array.isArray(criterion.source) ? { source: criterion.source as unknown as NonNullable<AcceptanceCriterion['source']> } : {}), ...(['requirement', 'constraint', 'environment'].includes(String(criterion.kind)) ? { kind: criterion.kind as NonNullable<AcceptanceCriterion['kind']> } : {}) }]
      : []
  }) : []
  const attempts = Array.isArray(value.attempts) ? value.attempts.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const attempt = item as Record<string, JsonValue>
    return typeof attempt.candidateResultRef === 'string'
      ? [{ candidateResultRef: attempt.candidateResultRef, evidenceRefs: stringArray(attempt.evidenceRefs), ...(typeof attempt.candidateHash === 'string' ? { candidateHash: attempt.candidateHash } : {}) }]
      : []
  }) : []
  const status = value.status
  if (status !== 'in_progress' && status !== 'verifying' && status !== 'replanning' && status !== 'accepted' && status !== 'incomplete' && status !== 'unverifiable') return undefined
  return {
    schemaVersion: 1,
    runId: value.runId,
    objective: value.objective,
    ...(value.criteriaParsingVersion === 2 ? { criteriaParsingVersion: 2 as const } : {}),
    ...(typeof value.continuedFromRunId === 'string' ? { continuedFromRunId: value.continuedFromRunId } : {}),
    ...(Array.isArray(value.assessments) ? { assessments: value.assessments.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.criterionId === 'string' && ['passed', 'not_met', 'unverifiable'].includes(String(item.status)) && typeof item.rationale === 'string' && Array.isArray(item.evidenceRefs)) as unknown as TaskCriterionAssessment[] } : {}),
    acceptanceCriteria: criteria,
    ...(value.acceptanceChecks !== undefined ? { acceptanceChecks: acceptanceCheckSchema.array().parse(value.acceptanceChecks) } : {}),
    ...(Array.isArray(value.supersededCriteria) ? { supersededCriteria: structuredClone(value.supersededCriteria) as unknown as AcceptanceCriterion[] } : {}),
    status,
    replanCount: typeof value.replanCount === 'number' && Number.isInteger(value.replanCount) ? Math.max(0, value.replanCount) : 0,
    attempts,
    ...(typeof value.candidateResultRef === 'string' ? { candidateResultRef: value.candidateResultRef } : {}),
    evidenceRefs: stringArray(value.evidenceRefs),
    excludedRefs: stringArray(value.excludedRefs),
    ...(typeof value.replanInstruction === 'string' ? { replanInstruction: value.replanInstruction } : {}),
  }
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function taskRecordJson(record: TaskRecord): JsonValue {
  return structuredClone(record) as unknown as JsonValue
}

export function hasTaskProgress(previous: TaskAttempt | undefined, current: TaskAttempt | undefined, attempts: TaskAttempt[]): boolean {
  if (!previous || !current || previous.candidateHash === undefined || current.candidateHash === undefined) return true
  const candidateRefs = new Set(attempts.map((attempt) => attempt.candidateResultRef))
  const evidenceSet = (attempt: TaskAttempt): string => [...new Set(attempt.evidenceRefs.filter((ref) => !candidateRefs.has(ref)))].sort().join('\n')
  return previous.candidateHash !== current.candidateHash || evidenceSet(previous) !== evidenceSet(current)
}

/** Preserve explicit checklist lines and sentence boundaries in the user request. */
export function acceptanceCriteriaFromObjective(objective: string, document?: string, version?: 2): AcceptanceCriterion[] {
  const sourceHash = createHash('sha256').update(objective).digest('hex')
  const clauses: Array<{ description: string; start: number; end: number }> = []
  let cursor = 0
  let fence: string | undefined
  for (const line of objective.split(/\r?\n/)) {
    const fenceMarker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    const literalLine = !!fence || !!fenceMarker
    if (fenceMarker) fence = fence && fence[0] === fenceMarker[0] && fenceMarker.length >= fence.length ? undefined : fence ?? fenceMarker
    const prefix = line.match(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/)?.[0] ?? ''
    const body = line.slice(prefix.length)
    let offset = 0
    const lineClauseStart = clauses.length
    for (const part of body.split(/(?<=[.!?;])\s+|(?<=[。！？；])\s*/)) {
      const description = part.trim()
      // A Markdown hard break after sentence punctuation can otherwise become
      // its own "deliverable". Ignore only that formatting-only continuation;
      // preserve literal lines, fenced/inline code, paths and escaped slashes.
      const formattingOnly = version === 2 && !literalLine && description === '\\' && clauses.length > lineClauseStart && line.endsWith('\\') && !line.endsWith('\\\\') && cursor + line.length < objective.length && (body.slice(0, offset).match(/`/g)?.length ?? 0) % 2 === 0
      if (description && !formattingOnly) {
        const start = cursor + prefix.length + offset + part.indexOf(description)
        clauses.push({ description, start, end: start + description.length })
      }
      offset = body.indexOf(part, offset) + part.length
      while (/\s/.test(body[offset] ?? '') && offset < body.length) offset++
    }
    cursor += line.length + (objective.slice(cursor + line.length).startsWith('\r\n') ? 2 : 1)
  }
  const merged: typeof clauses = []
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (/^\d+[.)、]$/.test(clause.description) && clauses[i + 1]) {
      const next = clauses[++i]!; merged.push({ ...clause, description: `${clause.description} ${next.description}`, end: next.end })
    } else merged.push(clause)
  }
  return merged.map(({ description, start, end }, index) => ({ id: `criterion-${index + 1}`, description,
    kind: /禁止|不得|不能|必须|不要|must|never|without|do not/i.test(description) ? 'constraint' : /环境|版本|platform|environment/i.test(description) ? 'environment' : 'requirement',
    source: { hash: sourceHash, start, end, ...(document ? { document } : {}) } }))
}

/** Deliberately narrow: unrelated new requests must not inherit authorization. */
export function isExplicitNewTask(text: string): boolean {
  return /^(?:新任务|换个话题|另一个问题|重新开始|new task\b|start over\b)/i.test(text.trim())
}

export function isTaskContinuation(text: string): boolean {
  const request = text.trim()
  if (isExplicitNewTask(request)) return false
  return /^(?:继续|接着|恢复(?:任务|执行)|continue(?:\b)|resume(?:\b))/i.test(request) || /^(?:(?:你|这|这个|刚才|之前|还是|仍然|怎么|为什么|为啥)[，,\s]*){0,3}(?:没有|没看到|找不到|缺少|遗漏|漏了)[^。！？!?\n]{0,30}(?:计划|文件|产物|报告|测试|功能|修改|结果)|^(?:这个|刚才的|之前的).{0,16}(?:不对|有问题|没修好)|^(?:the |that )?(?:plan|file|artifact|report|test|fix).{0,20}(?:missing|not found|still broken)/i.test(request)
}

/** Explicit interruption followed by an instruction to resume the same work. */
export function isInterruptedTaskContinuation(text: string): boolean {
  const request = text.trim()
  if (isExplicitNewTask(request) || /(?:不要|别|不用|do not|don't)\s*(?:继续|恢复|resume|continue)/i.test(request)) return false
  return /^(?:刚才|上次|之前|(?:the |my )?previous)[\s\S]{0,120}(?:中断|打断|interrupted|crashed)/i.test(request) && /(?:继续.{0,16}(?:剩余|未完成|迁移|任务|工作)|恢复(?:原|上次|之前)?(?:任务|执行)|(?:resume|continue).{0,30}(?:remaining|unfinished|task|work))/i.test(request)
}

/** A follow-up that asks for the previous run's factual work log rather than new mutations. */
export function isExecutionSummaryFollowup(text: string): boolean {
  return /(?:上一轮|上一次|刚才|之前|已完成|刚完成|改了什么|修改了什么|哪些文件|根因|验证(?:命令|结果)?|运行了什么|操作记录|执行记录|what did (?:you|we) change|previous run|work log|verification)/i.test(text.trim())
}

export function continueTaskRecord(previous: TaskRecord, runId: string): TaskRecord {
  return { schemaVersion: 1, runId, objective: previous.objective,
    ...(previous.criteriaParsingVersion === 2 ? { criteriaParsingVersion: 2 as const } : {}),
    acceptanceCriteria: structuredClone(previous.acceptanceCriteria),
    ...(previous.acceptanceChecks ? { acceptanceChecks: structuredClone(previous.acceptanceChecks) } : {}),
    ...(previous.supersededCriteria ? { supersededCriteria: structuredClone(previous.supersededCriteria) } : {}),
    continuedFromRunId: previous.runId, assessments: structuredClone(previous.assessments ?? []),
    status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] }
}
