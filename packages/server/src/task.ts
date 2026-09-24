import type { JsonValue, ResultRef } from '@hunterzhu/pulse-runtime'

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
  continuedFromRunId?: string
  assessments?: TaskCriterionAssessment[]
  acceptanceCriteria: Array<{ id: string; description: string }>
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
      ? [{ id: criterion.id, description: criterion.description }]
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
    ...(typeof value.continuedFromRunId === 'string' ? { continuedFromRunId: value.continuedFromRunId } : {}),
    ...(Array.isArray(value.assessments) ? { assessments: value.assessments.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.criterionId === 'string' && ['passed', 'not_met', 'unverifiable'].includes(String(item.status)) && typeof item.rationale === 'string' && Array.isArray(item.evidenceRefs)) as unknown as TaskCriterionAssessment[] } : {}),
    acceptanceCriteria: criteria,
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
export function acceptanceCriteriaFromObjective(objective: string): Array<{ id: string; description: string }> {
  const lines = objective.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const listItems = lines.flatMap((line) => {
    const match = line.match(/^(?:[-*•]\s+|\d+[.)、]\s*)(.+)$/)
    return match ? [match[1]!.trim()] : []
  })
  const clauses = (listItems.length > 1 ? listItems : [objective.replace(/\r?\n/g, ' ')])
    .flatMap((text) => text.split(/(?<=[.!?;])\s+|(?<=[。！？；])\s*/))
    .map((text) => text.trim())
    .filter(Boolean)
  // Sentence splitting must not turn inline list numbers into standalone goals.
  const merged: string[] = []
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index]!
    if (/^\d+[.)、]$/.test(clause) && clauses[index + 1]) merged.push(`${clause} ${clauses[++index]}`)
    else merged.push(clause)
  }
  const normalized = merged.length ? merged : [objective.trim()]
  const bounded = normalized.length <= 32
    ? normalized
    : [...normalized.slice(0, 31), `Additional requested conditions: ${normalized.slice(31).join('; ')}`]
  return bounded.map((description, index) => ({ id: `criterion-${index + 1}`, description }))
}

/** Deliberately narrow: unrelated new requests must not inherit authorization. */
export function isTaskContinuation(text: string): boolean {
  return /^(?:继续|接着|恢复(?:任务|执行)|continue(?:\b)|resume(?:\b))/i.test(text.trim())
}

export function continueTaskRecord(previous: TaskRecord, runId: string): TaskRecord {
  return { schemaVersion: 1, runId, objective: previous.objective,
    acceptanceCriteria: structuredClone(previous.acceptanceCriteria),
    continuedFromRunId: previous.runId, assessments: structuredClone(previous.assessments ?? []),
    status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] }
}
