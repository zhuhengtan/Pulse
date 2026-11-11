import { z } from 'zod'
import { createHash } from 'node:crypto'
import { namedVitestCheck } from '../vitest-check.js'
import { failureSchema, recoveryAttemptSchema, failureFromNote, failureRecord, recoveryInstruction, type FailureRecord, type RecoveryAttempt } from './recovery.js'
import type { JsonValue } from '@hunterzhu/pulse-runtime'
import { deliverySchema, type StageDelivery } from './delivery.js'
import { sourceClaimAuditSchema, type SourceClaimAudit } from './source-claim-audit.js'
import type { AcceptanceResult } from './acceptance.js'
import type { ReliabilityState } from './reliability.js'

/** An achievable stage correction can be retried while turn budget remains. */
export const maxStageAttempts = 4
/** When the original goal is still unmet because a method or tool failed, try another plan while the failure changes. */
export const maxGoalRecoveries = 256
export const plannedTaskSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['edit', 'verify', 'analyze']).optional(),
  goal: z.string().min(1).max(700),
  criterionIds: z.array(z.string()).min(1),
  dependsOn: z.array(z.string()).max(8),
  settledDependencies: z.array(z.string()).max(8).optional(),
  /** Stable identity shared by successive versions of one deliverable. */
  deliverableId: z.string().min(1).max(64).optional(),
  /** Stage ids this stage explicitly replaces. Dependencies are not this list. */
  supersedes: z.array(z.string().min(1).max(64)).max(8).optional(),
  check: z.string().min(1).max(500),
})
export const planSchema = z.object({ tasks: z.array(plannedTaskSchema).min(1).max(8) })
export const INVALIDATED_CHECK_CAPACITY = 1024
export const CHECK_CAPACITY_KEY = 'CHECK_OBLIGATION_CAPACITY'
const CHECK_KEY_LIMIT = 1000
/** Short identities keep their exact text; only an over-long one becomes a stable hash. The full argv stays in toolArguments. */
type CheckDebt = NonNullable<TaskControllerState['invalidatedChecks']>[number]
/**
 * One merge rule for every boundary (stale recovery, carrier hand-off, child join): same check keeps every criterion and the
 * stricter time boundary (a defined afterOrder is stricter than none, the later one wins). Beyond the persisted capacity the
 * overflow, including any earlier sentinel, collapses into one obligation no real check can satisfy.
 */
export function mergeInvalidatedChecks(state: TaskControllerState, incoming: readonly CheckDebt[] | undefined): void {
  if (!incoming?.length) return
  const merged = new Map<string, CheckDebt>()
  for (const raw of [...(state.invalidatedChecks ?? []), ...incoming]) {
    const item = { ...raw, key: normalizeCheckKey(raw.key, raw.toolArguments) }
    const previous = merged.get(item.key)
    const afterOrder = previous && previous.afterOrder !== undefined && item.afterOrder !== undefined ? Math.max(previous.afterOrder, item.afterOrder) : previous?.afterOrder ?? item.afterOrder
    merged.set(item.key, { key: item.key, toolArguments: previous?.toolArguments ?? item.toolArguments, criterionIds: [...new Set([...(previous?.criterionIds ?? []), ...item.criterionIds])], ...(afterOrder !== undefined ? { afterOrder } : {}) })
  }
  const real = [...merged.values()].filter(item => item.key !== CHECK_CAPACITY_KEY), sentinel = merged.get(CHECK_CAPACITY_KEY)
  const all = sentinel ? [...real, sentinel] : real
  if (all.length <= INVALIDATED_CHECK_CAPACITY) { state.invalidatedChecks = all; return }
  const overflow = all.slice(INVALIDATED_CHECK_CAPACITY - 1)
  state.invalidatedChecks = [...all.slice(0, INVALIDATED_CHECK_CAPACITY - 1), { key: CHECK_CAPACITY_KEY, toolArguments: {}, criterionIds: [...new Set(overflow.flatMap(item => item.criterionIds))].slice(0, 64), ...(overflow.some(item => item.afterOrder === undefined) ? {} : { afterOrder: Math.max(...overflow.map(item => item.afterOrder!)) }) }]
}
export function boundedCheckKey(key: string): string {
  return key.length <= CHECK_KEY_LIMIT ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`
}
/** Identity of a check with no named-Vitest meaning: the structured command, argv array and cwd. A display string loses argv boundaries. */
export function argvCheckKey(command: string, args: readonly string[], cwd: string): string {
  return boundedCheckKey(JSON.stringify(['argv', command, [...args], cwd]))
}
/** The one identity rule: an explicit named Vitest run keeps its named key, every other check uses its structured argv. */
export function checkKeyFromInvocation(command: string, args: readonly string[], cwd: string): string {
  const named = namedVitestCheck(command, args, cwd)?.key
  return named ? boundedCheckKey(named) : argvCheckKey(command, args, cwd)
}
/**
 * Read-time normalization of a persisted debt key. Sentinel, argv and named-Vitest keys keep their identity (only an over-long
 * raw one is hashed). An older display-string key is rebuilt from the retained structured toolArguments; if the structure is
 * not recoverable the key is kept, so no new check can discharge it (fail closed).
 */
export function normalizeCheckKey(key: string, toolArguments: unknown): string {
  if (key === CHECK_CAPACITY_KEY || key.startsWith('["argv",') || key.startsWith('["vitest",') || key.startsWith('sha256:')) return boundedCheckKey(key)
  const recorded = toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments) ? toolArguments as { command?: unknown; args?: unknown; cwd?: unknown } : undefined
  if (recorded && typeof recorded.command === 'string' && recorded.command.length > 0 && Array.isArray(recorded.args) && recorded.args.every(arg => typeof arg === 'string'))
    return checkKeyFromInvocation(recorded.command, recorded.args as string[], typeof recorded.cwd === 'string' && recorded.cwd.length > 0 ? recorded.cwd : '.')
  return boundedCheckKey(key)
}
export type PlannedTask = z.infer<typeof plannedTaskSchema>
export interface ControlledTask extends PlannedTask {
  failure?: FailureRecord
  reviewStatus?: 'passed' | 'needs_work' | 'unavailable' | 'skipped'
  status: 'pending' | 'running' | 'verifying' | 'passed' | 'blocked'
  attempts: number
  executionSlices?: number
  nextAction?: string
  stopReason?: string
  evidenceRefs: string[]
  candidateRef?: string
  candidateAttempt?: number
  retainedArtifactVerification?: boolean
  correctionKind?: 'edit' | 'verify' | 'report'
  note?: string
  modelCalls?: number
  investigationRounds?: number
  directedInvestigations?: number
  progressReviewed?: boolean
  contextRefs?: string[]
  approvalContextRefs?: string[]
  citationRepairs?: number
  reasoningRecoveries?: number
  freshnessRecoveries?: number
  /** How many times a missing rerun of an invalidated check was requested from the worker. */
  checkRerunRequests?: number
  checkRerunOwed?: number
  reviewFallbackUsed?: boolean
  lastInvestigationBatch?: string
  ownerLaneId?: string
  delivery?: StageDelivery
  progress?: { hashes: string[]; processedCalls: number; noProgress: number; corrected?: boolean }
  hostCheckRefs?: Record<string, string>
}
export interface TaskControllerState {
  schemaVersion: 1
  reliability?: ReliabilityState
  recoveryMode?: 'work' | 'verify'
  evidenceIndex?: string[]
  evidenceKeys?: string[]
  recoveryAttempts?: RecoveryAttempt[]
  recoveryNoProgress?: number
  revision: number
  tasks: ControlledTask[]
  priorTasks: ControlledTask[]
  seenInputIds: string[]
  updates: string[]
  seenModelRefs: string[]
  usedTurns: number
  maxTurns: number
  goalRecoveries: number
  lastRecoveryKey?: string
  planErrors?: string[]
  verificationRetries?: Record<string, number>
  planReviewRepairs?: number
  planFeedbackRevisions?: number
  planFeedbackRefs?: string[]
  planFeedbackPending?: boolean
  sourceDelivery?: { round: number; paths: string[]; refs: string[]; offsets: Record<string, number | null>; hashes: Record<string, string>; pages: number }
  sourceClaimAudit?: SourceClaimAudit
  finalReviewStatus?: 'passed' | 'needs_work' | 'unavailable' | 'skipped'
  finalReviewErrors?: string[]
  /** Original checks whose evidence became stale. Only a real new check run (or proven superset) discharges each. */
  invalidatedChecks?: Array<{ key: string; toolArguments: JsonValue; criterionIds: string[]; afterOrder?: number }>
  finalEvidenceReadbackAttempted?: boolean
  finalReview?: Array<{ criterionId: string; status: 'passed' | 'not_met' | 'unverifiable'; evidenceRefs: string[]; rationale: string }>
  acceptanceResults?: AcceptanceResult[]
  recoveryCriterionIds?: string[]
  budgetStopped?: string
  actualBudget?: { limit: number; used: number; workAllowed: boolean; verificationAllowed: boolean; finalAllowed: boolean; reason?: string }
  activeId?: string
  activeIds?: string[]
  planConfirmation?: { path: string; hash: string; ref: string }
  planConfirmations?: { path: string; hash: string; ref: string }[]
}
export function initialController(maxTurns: number): TaskControllerState {
  return { schemaVersion: 1, revision: 1, tasks: [], priorTasks: [], seenInputIds: [], updates: [], seenModelRefs: [], usedTurns: 0, maxTurns, goalRecoveries: 0 }
}
const controlledTaskSchema = plannedTaskSchema.extend({
  failure: failureSchema.optional(),
  reviewStatus: z.enum(['passed', 'needs_work', 'unavailable', 'skipped']).optional(),
  status: z.enum(['pending', 'running', 'verifying', 'passed', 'blocked']),
  attempts: z.number().int().min(0).max(maxStageAttempts), evidenceRefs: z.array(z.string()),
  executionSlices: z.number().int().min(0).optional(), nextAction: z.string().optional(), stopReason: z.string().optional(),
  contextRefs: z.array(z.string()).max(128).optional(),
  approvalContextRefs: z.array(z.string()).max(128).optional(),
  candidateRef: z.string().optional(), candidateAttempt: z.number().int().min(1).max(maxStageAttempts).optional(), note: z.string().optional(),
  retainedArtifactVerification: z.boolean().optional(),
  correctionKind: z.enum(['edit', 'verify', 'report']).optional(),
  investigationRounds: z.number().int().min(0).default(0), directedInvestigations: z.number().int().min(0).default(0), progressReviewed: z.boolean().default(false), lastInvestigationBatch: z.string().optional(),
  reasoningRecoveries: z.number().int().min(0).max(2).optional(), freshnessRecoveries: z.number().int().min(0).max(2).optional(), checkRerunRequests: z.number().int().min(0).max(2).optional(), checkRerunOwed: z.number().int().min(0).max(1024).optional(),
  reviewFallbackUsed: z.boolean().optional(), citationRepairs: z.number().int().min(0).max(1).optional(),
  modelCalls: z.number().int().min(0).default(0),
  ownerLaneId: z.string().optional(), delivery: deliverySchema.optional(),
  progress: z.object({ hashes: z.array(z.string()).max(128), processedCalls: z.number().int().min(0), noProgress: z.number().int().min(0), corrected: z.boolean().optional() }).optional(),
  hostCheckRefs: z.record(z.string()).optional(),
})
const controllerSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  reliability: z.object({
    excludedRefs: z.array(z.string()),
    cycles: z.record(z.object({ seen: z.array(z.string()), processed: z.array(z.string()), noProgress: z.number().int().nonnegative(), phase: z.enum(['work', 'correct', 'alternative', 'blocked']) })),
    freshness: z.record(z.number().int().nonnegative()),
    invalidations: z.array(z.object({ key: z.string(), code: z.string(), refs: z.array(z.string()), targets: z.array(z.string()), files: z.array(z.object({ path: z.string(), hash: z.string() })) })).default([]),
    environments: z.record(z.object({ methods: z.array(z.string()), refs: z.array(z.string()), reason: z.string() })),
    processedChecks: z.array(z.string()).default([]),
  }).optional(),
  // Task history is bounded by the cumulative provider budget; each plan still has at most eight stages.
  tasks: z.array(controlledTaskSchema).max(256), priorTasks: z.array(controlledTaskSchema).max(256),
  recoveryMode: z.enum(['work', 'verify']).optional(),
  evidenceIndex: z.array(z.string()).optional(), evidenceKeys: z.array(z.string()).optional(),
  recoveryAttempts: z.array(recoveryAttemptSchema).max(256).optional(), recoveryNoProgress: z.number().int().nonnegative().optional(),
  seenInputIds: z.array(z.string()), updates: z.array(z.string()), seenModelRefs: z.array(z.string()),
  usedTurns: z.number().int().min(0), maxTurns: z.number().int().min(4).max(256), goalRecoveries: z.number().int().min(0).max(maxGoalRecoveries).default(0), lastRecoveryKey: z.string().max(800).optional(), activeId: z.string().optional(), activeIds: z.array(z.string()).max(8).optional(),
  planErrors: z.array(z.string()).max(2).optional(),
  verificationRetries: z.record(z.number().int().min(0).max(2)).optional(),
  planReviewRepairs: z.number().int().min(0).max(2).optional(),
  planFeedbackRevisions: z.number().int().min(0).max(2).optional(),
  planFeedbackRefs: z.array(z.string()).max(2).optional(),
  planFeedbackPending: z.boolean().optional(),
  sourceDelivery: z.object({ round: z.number().int().positive(), paths: z.array(z.string()).max(8), refs: z.array(z.string()).max(64), offsets: z.record(z.number().int().nonnegative().nullable()), hashes: z.record(z.string()), pages: z.number().int().nonnegative().max(64) }).optional(),
  sourceClaimAudit: sourceClaimAuditSchema.optional(),
  finalReviewStatus: z.enum(['passed', 'needs_work', 'unavailable', 'skipped']).optional(),
  finalReviewErrors: z.array(z.string()).max(1).optional(),
  invalidatedChecks: z.array(z.object({ key: z.string(), toolArguments: z.any(), criterionIds: z.array(z.string()).max(64), afterOrder: z.number().int().min(0).optional() }).transform(item => ({ ...item, key: normalizeCheckKey(item.key, item.toolArguments) })).pipe(z.object({ key: z.string().max(1200), toolArguments: z.any(), criterionIds: z.array(z.string()).max(64), afterOrder: z.number().int().min(0).optional() }))).max(1024).optional(),
  finalEvidenceReadbackAttempted: z.boolean().optional(),
  finalReview: z.array(z.object({ criterionId: z.string(), status: z.enum(['passed', 'not_met', 'unverifiable']), evidenceRefs: z.array(z.string()), rationale: z.string() })).optional(),
  acceptanceResults: z.array(z.object({ id: z.string(), ref: z.string().optional(), status: z.enum(['passed', 'failed', 'unverifiable']), reason: z.string(), checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string().optional() })).optional() })).optional(),
  recoveryCriterionIds: z.array(z.string()).optional(),
  budgetStopped: z.string().optional(),
  actualBudget: z.object({ limit: z.number().int().min(0), used: z.number().int().min(0), workAllowed: z.boolean(), verificationAllowed: z.boolean(), finalAllowed: z.boolean(), reason: z.string().optional() }).optional(),
  planConfirmation: z.object({ path: z.string(), hash: z.string(), ref: z.string() }).optional(),
  planConfirmations: z.array(z.object({ path: z.string(), hash: z.string(), ref: z.string() })).max(32).optional(),
})
export function controllerFromGlobal(global: Readonly<JsonValue>): TaskControllerState | undefined {
  if (!global || typeof global !== 'object' || Array.isArray(global)) return undefined
  const value = (global as Record<string, JsonValue>).taskController
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const parsed = controllerSchema.safeParse(value)
  if (!parsed.success) throw new Error('TASK_CONTROLLER_STATE_INVALID')
  return JSON.parse(JSON.stringify(parsed.data)) as TaskControllerState
}
export function normalizePlanCriterionIds(tasks: PlannedTask[], validCriterionIds: string[]): PlannedTask[] {
  if (!validCriterionIds.length || !tasks.length) return tasks
  const validSet = new Set(validCriterionIds)
  const lowerMap = new Map(validCriterionIds.map(id => [id.toLowerCase(), id]))

  const numMap = new Map<string, string>()
  for (const id of validCriterionIds) {
    const match = id.match(/(\d+)$/)
    if (match && match[1]) {
      if (numMap.has(match[1])) {
        numMap.set(match[1], '')
      } else {
        numMap.set(match[1], id)
      }
    }
  }

  const mapId = (raw: string): string => {
    if (validSet.has(raw)) return raw
    const trimmed = raw.trim()
    if (validSet.has(trimmed)) return trimmed
    const lower = lowerMap.get(trimmed.toLowerCase())
    if (lower) return lower

    if (validCriterionIds.length === 1 && (['all', '*', 'c1', 'crit-1', 'crit_1', 'criterion-1', 'criterion_1', '1', 'default'].includes(trimmed.toLowerCase()) || !trimmed.includes('-'))) {
      return validCriterionIds[0]!
    }

    const match = trimmed.match(/(\d+)$/)
    if (match && match[1]) {
      const candidate = numMap.get(match[1])
      if (candidate) return candidate
    }

    return raw
  }

  for (const task of tasks) {
    task.criterionIds = [...new Set(task.criterionIds.map(mapId))]
  }
  return tasks
}

export function validatePlan(tasks: PlannedTask[], criterionIds: string[], originalContract?: string): void {
  normalizePlanCriterionIds(tasks, criterionIds)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  if (byId.size !== tasks.length) throw new Error('TASK_PLAN_DUPLICATE_ID')
  const covered = new Set(tasks.flatMap((task) => task.criterionIds))
  if (criterionIds.some((id) => !covered.has(id)) || [...covered].some((id) => !criterionIds.includes(id))) throw new Error('TASK_PLAN_CRITERIA_MISMATCH')
  const done = new Set<string>()
  const visiting = new Set<string>()
  const walk = (id: string): void => {
    if (visiting.has(id)) throw new Error('TASK_PLAN_CYCLE')
    if (done.has(id)) return
    const task = byId.get(id)
    if (!task) throw new Error(`TASK_PLAN_UNKNOWN_DEPENDENCY: ${id}; available IDs: ${[...byId.keys()].join(', ')}`)
    visiting.add(id)
    task.dependsOn.forEach(walk)
    visiting.delete(id)
    done.add(id)
  }
  tasks.forEach((task) => walk(task.id))
  if (tasks.some(t => t.settledDependencies?.some(id => !t.dependsOn.includes(id)))) throw new Error('TASK_PLAN_INVALID_SETTLED_DEPENDENCY')
  const replaced = new Map<string, string>()
  const replacementEdges = new Map<string, string[]>()
  for (const task of tasks) {
    const targets = task.supersedes ?? []
    if (!targets.length) continue
    replacementEdges.set(task.id, targets)
    for (const target of targets) {
      if (target === task.id) throw new Error(`TASK_PLAN_SELF_SUPERSESSION: ${task.id}`)
      const prior = byId.get(target)
      if (!prior) throw new Error(`TASK_PLAN_UNKNOWN_SUPERSESSION: ${task.id}; ${target}`)
      if (!task.deliverableId || task.deliverableId !== prior.deliverableId) throw new Error(`TASK_PLAN_SUPERSESSION_IDENTITY: ${task.id}`)
      const claimer = replaced.get(target)
      if (claimer) throw new Error(`TASK_PLAN_AMBIGUOUS_SUPERSESSION: ${target}`)
      replaced.set(target, task.id)
    }
  }
  const visited = new Set<string>()
  const stacked = new Set<string>()
  const walkReplacement = (id: string): void => {
    if (stacked.has(id)) throw new Error(`TASK_PLAN_SUPERSESSION_CYCLE: ${id}`)
    if (visited.has(id)) return
    stacked.add(id)
    for (const target of replacementEdges.get(id) ?? []) walkReplacement(target)
    stacked.delete(id)
    visited.add(id)
  }
  for (const id of replacementEdges.keys()) walkReplacement(id)
  if (originalContract !== undefined) {
    // Plans are written before repository investigation. A calculated decimal
    // must not silently become a new business oracle. Defer derived constants
    // to evidence-backed tests; preserve explicitly requested values unchanged.
    const numbers = new Set([...originalContract.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?!\w|\.\d)/g)].map(match => Number(match[0])))
    for (const task of tasks) for (const match of task.check.matchAll(/(?<![\w.])-?\d+\.\d+(?!\w|\.\d)/g)) {
      if (!numbers.has(Number(match[0]))) throw new Error(`TASK_PLAN_UNGROUNDED_EXPECTATION: ${task.id}; decimal ${match[0]} is absent from the original contract. Describe the required behavior; derive expected values from repository evidence during execution.`)
    }
  }
}

/** A test failure need not prevent documenting current, actually implemented behavior. */
export function allowIndependentDocumentation(tasks: PlannedTask[], objective: string): PlannedTask[] {
  const requiresPass = /(?:只有|仅在|必须|须在).{0,50}(?:测试|检查|验收).{0,20}通过|(?:测试|检查|验收)通过(?:后|才能).{0,30}(?:文档|README)|only after.{0,50}(?:tests?|checks?).{0,20}pass/i
  if (requiresPass.test(objective)) return tasks.map(t => ({ ...t, settledDependencies: [] }))
  const testStage = (t: PlannedTask): boolean => t.kind === 'verify' || /(?:^|[/\\])[\w.-]+\.test\.[\w]+|\b(?:run|execute) (?:tests|checks)\b|运行.*(?:测试|检查)/i.test(t.goal)
  return tasks.map(t => {
    const firstFile = t.goal.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:md|rst|adoc|txt|[cm]?[jt]sx?|py|rs|go)\b/i)?.[0]
    const mixed = /(?:并|和|and)\s*(?:修改|更新|edit|update)?\s*[\w./-]+\.(?:[cm]?[jt]sx?|py|rs|go)\b/i.test(t.goal)
    const doc = t.kind === 'edit' && !!firstFile && /\.(?:md|rst|adoc)$/.test(firstFile) && !mixed && /(?:更新|编写|修改|写入|新增|update|write|edit|create).{0,80}(?:README|\.md\b|\.rst\b|\.adoc\b)/i.test(t.goal)
    const settled = t.dependsOn.filter(id => { const dep = tasks.find(d => d.id === id); return dep && testStage(dep) })
    // Model-supplied soft edges are only valid for this narrow independent
    // documentation case. Source implementation and explicit pass gates stay hard.
    return { ...t, settledDependencies: doc && !requiresPass.test(`${t.goal}\n${t.check}`) ? settled : [] }
  })
}

export function dependencySatisfied(task: PlannedTask, dependency: ControlledTask | undefined, tasks: readonly ControlledTask[]): boolean {
  if (dependency?.status === 'passed') return true
  if (dependency?.status !== 'blocked' || !task.settledDependencies?.includes(dependency.id)) return false
  // A missing source prerequisite still blocks documentation of that source.
  return !isCascadeBlocked(dependency, tasks) || dependency.dependsOn.every(id => tasks.find(t => t.id === id)?.status === 'passed')
}

function declaredDeliverableId(task: PlannedTask): string | undefined {
  return task.deliverableId ? task.deliverableId : undefined
}

/** A replacement merge is legal only when every member has the same explicit identity.
 * A missing identity is its own delivery, not a match for the one declared id in the group. */
function replacementBlocksMixedIdentity(group: readonly PlannedTask[], universe: readonly PlannedTask[]): boolean {
  const ids = new Set(group.map(item => item.id))
  const touches = group.some(item => (item.supersedes ?? []).length > 0) || universe.some(item => !ids.has(item.id) && (item.supersedes ?? []).some(id => ids.has(id)))
  if (!touches) return false
  const identities = group.map(declaredDeliverableId)
  const expected = identities[0]
  return !expected || identities.some(id => id !== expected)
}

/** Coalesce a validated DAG in topological order without losing checks or criteria.
 * Stages outside the fitted set keep their ids, so a merge must not absorb a
 * delivery those stages still replace. */
export function fitPlanToBudget(tasks: PlannedTask[], limit: number, anchored: readonly PlannedTask[] = []): PlannedTask[] {
  const maximum = Math.max(1, Math.min(8, Math.floor((limit - 4) / 5)))
  if (tasks.length <= maximum) return tasks
  const ordered: PlannedTask[] = [], seen = new Set<string>()
  const visit = (task: PlannedTask): void => {
    if (seen.has(task.id)) return
    seen.add(task.id)
    task.dependsOn.forEach(id => { const dependency = tasks.find(item => item.id === id); if (dependency) visit(dependency) })
    ordered.push(task)
  }
  tasks.forEach(visit)
  const groups: PlannedTask[][] = ordered.map(task => [task])
  // Merge adjacent groups until the budget floor fits, retaining schema bounds.
  for (let i = 0; groups.length > maximum && i < groups.length - 1;) {
    const merged = [...groups[i]!, ...groups[i + 1]!]
    const ids = new Set(merged.map(t => t.id))
    if (merged.some(t => (t as ControlledTask).retainedArtifactVerification || t.settledDependencies?.some(id => ids.has(id)))) { i++; continue }
    if (anchored.some(item => (item.supersedes ?? []).some(id => ids.has(id) && id !== merged[0]!.id)) || replacementBlocksMixedIdentity(merged, [...anchored, ...tasks])) { i++; continue }
    if (merged.map(item => item.goal).join('; ').length <= 700 && merged.map(item => item.check).join('; ').length <= 500 && new Set(merged.flatMap(item => item.criterionIds)).size <= 32) groups.splice(i, 2, merged)
    else i++
  }
  const owners = new Map(groups.flatMap(group => group.map(task => [task.id, group[0]!.id] as const)))
  return groups.map(group => {
    const identities = group.map(declaredDeliverableId)
    const identity = identities[0]
    const uniformIdentity = Boolean(identity) && identities.every(id => id === identity)
    const supersedes = [...new Set(group.flatMap(item => item.supersedes ?? []).map(id => owners.get(id) ?? id))].filter(id => id !== group[0]!.id)
    return { ...((group[0] as ControlledTask).retainedArtifactVerification ? { retainedArtifactVerification: true } : {}), id: group[0]!.id, ...(group.some(t => t.kind) ? { kind: group.some(t => t.kind === 'edit') ? 'edit' as const : group[0]!.kind } : {}), goal: group.map(item => item.goal).join('; '), check: group.map(item => item.check).join('; '), criterionIds: [...new Set(group.flatMap(item => item.criterionIds))], dependsOn: [...new Set(group.flatMap(item => item.dependsOn).map(id => owners.get(id) ?? id))].filter(id => id !== group[0]!.id), ...(group.some(t => t.settledDependencies?.length) ? { settledDependencies: [...new Set(group.flatMap(t => t.settledDependencies ?? []).map(id => owners.get(id) ?? id))].filter(id => id !== group[0]!.id && group.every(t => t.dependsOn.filter(d => (owners.get(d) ?? d) === id).every(d => t.settledDependencies?.includes(d)))) } : {}), ...(uniformIdentity ? { deliverableId: identity, ...(supersedes.length ? { supersedes } : {}) } : {}) }
  })
}
const TOOL_RUNNER = /\b(?:node|npm|pnpm|yarn|bun|pytest|cargo|vitest|jest|make|python3?|pip3?|ruby|gradle|mvn|dotnet|gcc|clang|tsc|eslint|ruff)\b|\bgo\s+test\b/i
const WORKSPACE_FILE = /(?:^|[\s`'"(])(?:\.{1,2}\/|[\w.-]+\/)[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b|\b(?!node\.js\b)[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|md|json|ya?ml|toml|css|html|vue|svelte|sh|sql|cpp|hpp|cs|rb|php|swift|kt|txt|lock|c|h)\b/i

/** A stage whose goal is to change code, not only to locate or inspect it. */
export function stageRequiresFileChange(goal: string, check: string, kind?: PlannedTask['kind'], strictIntent = false, generalActions = false, executionIntent = false, preciseInspection = false, metadataIntent = false): boolean {
  // Dependency/import restrictions do not make a requested implementation read-only.
  const text = metadataIntent ? `${goal}\n${check}`.replace(/(?:无新增|不(?:引入|新增|添加))(?:任何)?\s*(?:import\b|依赖)|\b(?:without|no)\s+(?:adding\s+|new\s+)?(?:dependencies|imports)\b/gi, '') : `${goal}\n${check}`
  // A planner's edit label can describe GUI state, not a filesystem mutation.
  // Keep file/code deliverables under the existing edit gate. Opt in only for
  // the new controller; restored historical programs retain their semantics.
  const subject = goal.replace(/https?:\/\/\S+|\b(?:browser|computer|automation)\.[\w]+/g, ' ')
  if (generalActions && /浏览器|界面|页面|窗口|鼠标|键盘|\b(?:browser|computer|automation|GUI|UI)\b/i.test(text) && !WORKSPACE_FILE.test(subject) && !/(?:创建|修改|修复|实现|写入|新增)[^。；\n]{0,30}(?:代码|文件|脚本|组件)|\b(?:create|modify|fix|implement|write|add)\b[^.;\n]{0,40}\b(?:code|file|script|component)s?\b/i.test(subject)) return false
  const readOnly = /只读|仅(?:审查|分析|检查)|(?:不要|不得|禁止|无需|不允许|不需要|不|未)(?:修改|改动|编辑|创建|新增|修复)|(?:不要|不得|禁止|无需|不允许|不需要|不|未)写入(?:文件|代码)|(?:无|没有)(?:需|须)?(?:修改|改动|编辑|创建|新增|修复|写入)|\bread[- ]only\b|\b(?:do not|don't|must not|never|without|no)\s+(?:(?:any|file|code)\s+)*(?:modif\w*|edit\w*|chang\w*|writ\w*|creat\w*|add\w*|fix\w*)/i
  if (readOnly.test(text)) return false
  // Paths and identifiers are evidence scope, never verbs (run.mjs, test_helpers).
  const prose = goal.replace(/(?:[\w.@-]+[\/\\])*[\w.@-]+\.[\w.-]+|\b\w*[_$]\w*\b/g, ' ')
  // A verifier can mention "the edit" or "创建路径" as the object of its
  // inspection. Those nouns do not request a second mutation. Keep explicit
  // additional edit clauses under the existing write gate.
  if (preciseInspection && /^\s*(?:读回|回读|复核|核对|核验|审查|检查|分析|阅读|读取|定位|查看|验证|确认|\b(?:read(?:\s+back)?|review|inspect|analyze|locate|verify|confirm|check)\b)/i.test(prose)
    && !/(?:并且|并|然后|随后|以及|同时|\b(?:and(?:\s+then)?|then|also)\b)\s*(?:再|直接)?\s*(?:新增|修改|实现|创建|更新|改动|写入|写出|修复|接入|集成|(?:implement|modify|patch|create|edit|fix|refactor|add|update|write|integrate)\b)/i.test(prose)) return false
  if (metadataIntent && /^\s*(?:重写|重新实现|\b(?:rewrite|reimplement)\b)/i.test(prose)) return true
  const edit = /新增|修改|实现|创建|接入|集成|更新|改动|写入|写出|修复|\b(?:implement|modify|patch|create|edit|fix|refactor|add|update|write|integrate)\b/i
  const inspection = /^\s*(?:审查|检查|分析|阅读|读取|定位|查看|\b(?:review|inspect|analyze|read|locate)\b)/i.test(prose)
  const alsoEdit = /(?:并|然后|\b(?:and|then)\s+)(?:修改|修复|新增|创建|实现|更新|接入|集成|写入|写出|(?:implement|modify|patch|create|edit|fix|refactor|add|update|write|integrate)\b)/i.test(prose)
  // Executing an existing generator can create its own artifacts. Requiring an
  // additional filesystem edit here forces pointless rewrites or repeated runs.
  if (strictIntent && /^\s*(?:运行|执行|重跑|重新运行|\b(?:run|execute)\b)/i.test(prose) && (executionIntent || TOOL_RUNNER.test(goal)) && !edit.test(prose)) return false
  const validation = /验证|复现|运行|测试|确认|输出|列出|记录|\b(?:reproduce|verify|run|test|check|report|review)\b/i.test(prose)
  const directEdit = /^\s*(?:新增|修改|实现|创建|接入|集成|更新|改动|写入|写出|修复|(?:将|把).*(?:接入|集成|修改|更新)|\b(?:implement|modify|patch|create|edit|fix|refactor|add|update|write|integrate)\b)/i.test(prose)
  // Named output files are real deliverables even when the verb is 'record'.
  const explicitFileDelivery = WORKSPACE_FILE.test(goal) && /(?:记录|生成|输出|汇总|保存)(?:到|至|为|成)|(?:在|向|到|至)\s*[^，。；\n]+(?:记录|写入)|\b(?:write|record|save|generate)\b/i.test(goal)
  if (strictIntent && explicitFileDelivery) return true
  // A report about write/edit receipts is analysis, not another write request.
  // Explicitly named output files and an additional edit clause still win.
  if (strictIntent && /^\s*(?:汇总|总结|说明|解读|\b(?:summarize|explain|describe)\b)/i.test(prose) && !alsoEdit) return false
  // The label supplied by the planner cannot turn an inspection into a write.
  const verificationProse = prose.replace(/^(?:集成(?:核查|验证|检查)|确认(?:接入|集成|修复)(?:结果|状态))/, '验证')
  const explicitWrite = alsoEdit || /新增|修改|创建|更新|写入|写出|保存|修复|\b(?:implement|modify|patch|create|edit|fix|refactor|add|update|write|save|integrate)\b/i.test(verificationProse.replace(/(?:修复|接入)(?:结果|状态)/g, '验证'))
  if (strictIntent && !explicitWrite && (inspection || /验证|核查|检查|测试|确认|复现|\b(?:verify|verification|check|test|review|inspect)\b/i.test(verificationProse))) return false
  if (kind === 'edit') return true
  if ((inspection || validation) && !directEdit && !alsoEdit) return false
  // A filename or a mention of an implementation is evidence scope, not edit intent.
  return edit.test(prose)
}

/** Inventory observes existing state; it must not create the state it reports. */
export function isReadOnlyInventoryStage(goal: string, check: string, kind?: PlannedTask['kind'], metadataIntent = false): boolean {
  if (stageRequiresFileChange(goal, check, kind, true, true, true, true, metadataIntent)) return false
  const prose = goal.replace(/(?:[\w.@-]+[\/\\])*[\w.@-]+\.[\w.-]+/g, ' ')
  if (!/^\s*(?:(?:先|首先|仅|只|只读)\s*)?(?:盘点|读回|回读|复核|核对|核验|审查|检查|分析|阅读|读取|查看|确认|\b(?:read(?:\s+back)?|review|inspect|analyze|inventory|confirm|check)\b)/i.test(prose)) return false
  // A requested executable check remains available in verification stages.
  const actionText = metadataIntent ? `${goal}\n${check}`.replace(/测试(?:脚本)?(?:运行|执行)命令|\btest\s+(?:execution|runner)\s+commands?\b/gi, 'runner metadata') : `${goal}\n${check}`
  return !/(?:运行|执行|重跑|shell\.exec|\b(?:run|execute|npm|pnpm|pytest|node|python3?)\b)/i.test(actionText)
}

/** New plans have durable intent; legacy snapshots may omit it. */
export function normalizeStageKinds(tasks: PlannedTask[], strictIntent = false, generalActions = false, executionIntent = false, preciseInspection = false, metadataIntent = false): PlannedTask[] {
  return tasks.map(task => {
    const verify = /验证|核查|检查|测试|确认|运行|执行|重跑|\b(?:verify|verification|test|check|review|run|execute)\b/i.test(task.goal.replace(/\S+\.[\w.-]+/g, ''))
    const kind = stageRequiresFileChange(task.goal, task.check, task.kind, strictIntent, generalActions, executionIntent, preciseInspection, metadataIntent) ? 'edit' : strictIntent && verify ? 'verify' : task.kind === 'edit' ? 'analyze' : task.kind ?? (verify ? 'verify' : 'analyze')
    return { ...task, kind }
  })
}

/** Merge pure discovery with dependent repairs, preserving checks and the DAG. */
export function mergePreparatoryStages(tasks: PlannedTask[], options: { preserveParallel?: boolean; allowFailureBaseline?: boolean } = {}): PlannedTask[] {
  let result = tasks.map(t => ({ ...t, dependsOn: [...t.dependsOn] }))
  for (const prep of [...result]) {
    if ((prep as ControlledTask).retainedArtifactVerification || prep.kind === 'edit' || !/^\s*(?:读取|阅读|调查|检查|确认范围|read\b|inspect\b|investigate\b)/i.test(prep.goal)) continue
    const text = prep.goal + '\n' + prep.check
    const failureBaseline = options.allowFailureBaseline && /复现.{0,30}(?:失败|崩溃|错误)|(?:baseline|reproduce).{0,40}(?:fail|crash|error)/i.test(text)
    if (/报告|文档|审批|批准|用户确认|必须.{0,10}通过|report|document|approval|approve|ask|human|user|must.{0,10}pass/i.test(text) || TOOL_RUNNER.test(text) && !failureBaseline) continue
    if (failureBaseline && /退出码\s*(?:[:=]|必须为)?\s*0|exit(?: code)?\s*(?:[:=]|must be)?\s*0|all tests pass/i.test(text)) continue
    const users = result.filter(t => t.dependsOn.includes(prep.id))
    if (!users.length || options.preserveParallel && users.length > 1 || users.some(t => t.kind !== 'edit' || t.dependsOn.length !== 1)) continue
    const combined = [prep, ...users], ids = new Set(combined.map(t => t.id))
    if (result.some(t => t.settledDependencies?.some(id => ids.has(id)))) continue
    const goal = combined.map(t => t.goal).join('; '), check = combined.map(t => t.check).join('; ')
    if (goal.length > 700 || check.length > 500 || new Set(combined.flatMap(t => t.criterionIds)).size > 32 || prep.dependsOn.some(id => ids.has(id)) || replacementBlocksMixedIdentity(combined, result)) continue
    const owner = users[0]!
    owner.goal = goal; owner.check = check
    owner.criterionIds = [...new Set(combined.flatMap(t => t.criterionIds))]
    owner.dependsOn = [...prep.dependsOn]
    if (prep.deliverableId && prep.deliverableId === owner.deliverableId) owner.supersedes = [...new Set([...(owner.supersedes ?? []), ...(prep.supersedes ?? [])])].filter(id => id !== owner.id)
    result = result.filter(t => t.id === owner.id || !ids.has(t.id)).map(t => ({ ...t, dependsOn: [...new Set(t.dependsOn.map(id => ids.has(id) ? owner.id : id))], ...(t.supersedes ? { supersedes: [...new Set(t.supersedes.map(id => ids.has(id) ? owner.id : id))].filter(id => id !== t.id) } : {}) }))
  }
  return result
}

/** Keep routine checks with their implementing stage instead of asking a new
 * worker to rerun the same settled operation. All checks and criteria survive. */
export function mergeRoutineVerificationStages(tasks: PlannedTask[]): PlannedTask[] {
  let result = tasks.map(t => ({ ...t, dependsOn: [...t.dependsOn] }))
  for (const verify of tasks) {
    if (verify.kind !== 'verify' || verify.dependsOn.length !== 1 || /审批|批准|用户确认|approval|approve|ask|human|user/i.test(verify.goal + '\n' + verify.check)) continue
    // Keep explicit suites and pass gates as separate checks. Routine focused
    // tests for the same deliverable can use the implementing stage's receipts.
    const text = verify.goal + '\n' + verify.check
    if (/测试|--test|\b(?:tests?|suite|vitest|jest|pytest)\b/i.test(text)
      && (!/定向|相关|\b(?:focused|targeted|relevant)\b/i.test(text) || /--test|\.(?:[cm]?[jt]sx?|py)\b|全量|全部|\b(?:full|entire|all)\b/i.test(text))) continue
    const current = result.find(t => t.id === verify.id)
    const owner = current && result.find(t => t.id === current.dependsOn[0])
    if (!current || !owner || (current as ControlledTask).retainedArtifactVerification || (owner as ControlledTask).retainedArtifactVerification || owner.kind !== 'edit' || !verify.criterionIds.length || !verify.criterionIds.every(id => owner.criterionIds.includes(id))) continue
    const ids = new Set([owner.id, verify.id])
    if (result.some(t => t.settledDependencies?.some(id => ids.has(id)))) continue
    const goal = `${owner.goal}; ${verify.goal}`, check = `${owner.check}; ${verify.check}`
    if (goal.length > 700 || check.length > 500 || replacementBlocksMixedIdentity([owner, verify], result)) continue
    owner.goal = goal; owner.check = check
    if (verify.deliverableId && verify.deliverableId === owner.deliverableId) owner.supersedes = [...new Set([...(owner.supersedes ?? []), ...(verify.supersedes ?? [])])].filter(id => id !== owner.id)
    result = result.filter(t => t.id !== verify.id).map(t => ({ ...t, dependsOn: [...new Set(t.dependsOn.map(id => id === verify.id ? owner.id : id))], ...(t.supersedes ? { supersedes: [...new Set(t.supersedes.map(id => id === verify.id ? owner.id : id))].filter(id => id !== t.id) } : {}) }))
  }
  return result
}

/** Host final review already checks all original criteria. Keep real final
 * commands, human gates and deliverables; omit only a duplicate terminal review
 * whose criteria are all covered by other planned stages. */
export function omitRedundantFinalReviews(tasks: PlannedTask[]): PlannedTask[] {
  let retained = [...tasks]
  for (const task of tasks) {
    const text = `${task.goal}\n${task.check}`
    if (task.kind !== 'verify' || TOOL_RUNNER.test(text) || WORKSPACE_FILE.test(text)) continue
    if (/运行|执行|复跑|测试|询问|批准|审批|摘要|报告|\b(?:run|execute|rerun|test|ask|approve|approval|summary|report)\b/i.test(text)) continue
    if (!/最终|整体|全面|\b(?:final|overall|entire)\b/i.test(text) || !/全部交付物|原始.{0,20}(?:标准|要求)|(?:所有|全部).{0,20}(?:标准|要求)|\b(?:criteria|requirements)\b/i.test(text)) continue
    if (retained.some(other => other.dependsOn.includes(task.id) || other.supersedes?.includes(task.id))) continue
    const covered = new Set(retained.filter(other => other.id !== task.id).flatMap(other => other.criterionIds))
    if (task.criterionIds.length > 0 && task.criterionIds.every(id => covered.has(id))) retained = retained.filter(other => other.id !== task.id).map(other => other.supersedes?.includes(task.id) ? { ...other, supersedes: other.supersedes.filter(id => id !== task.id) } : other)
  }
  return retained
}

/** Implementation, file, and command stages need settled tool evidence. Versions and abbreviations do not. */
export function stageRequiresToolEvidence(goal: string, check: string): boolean {
  const text = `${goal}\n${check}`
  return TOOL_RUNNER.test(text) || WORKSPACE_FILE.test(text) || /(?:运行|执行|通过|验证).{0,24}(?:测试|检查|回归)|\b(?:run|execute|pass|verify)\b.{0,40}\b(?:tests?|checks?|regression|suite)\b/i.test(text)
}

/** Conservative allowlist for shell commands that inspect state without writing it. */
export function isReadOnlyInspectionCommand(command: string | undefined): boolean {
  if (!command || /[|<>;`$\n\r]/.test(command)) return false
  const segments = command.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean)
  if (!segments.length) return false
  return segments.every(isReadOnlyInspectionSegment)
}
const READ_ONLY_GIT = /^git\s+(?:status|diff|log|show|rev-parse|ls-files|diff-tree)\b/
const READ_ONLY_SIMPLE = /^(?:pwd|ls|rg|grep|find|cat|head|tail|wc)\b/
const MUTATING_FLAGS = /(?:^|\s)(?:--output|--exec|--delete|--move|--copy|--set-upstream|-exec|-delete)\b/
const MUTATING_BRANCH_FLAGS = /(?:^|\s)(?:-[dDmMcC]|--delete|--move|--copy|--force)\b/
/** A segment is read-only only when it inspects state and carries no flag that mutates it (`sed -i`, `git branch -D`). */
function isReadOnlyInspectionSegment(segment: string): boolean {
  if (MUTATING_FLAGS.test(segment)) return false
  if (READ_ONLY_GIT.test(segment)) return true
  if (/^git\s+branch\b/.test(segment)) return !/^git\s+branch\s+[^-\s]/.test(segment) && !MUTATING_BRANCH_FLAGS.test(segment)
  if (/^sed\b/.test(segment)) return !/(?:^|\s)(?:-i|--in-place)/.test(segment)
  return READ_ONLY_SIMPLE.test(segment)
}
/** Before plan confirmation only a strict read-only status check may run; `sed -i` and `git branch -D` stay denied. */
const PRE_CONFIRMATION_INSPECTION = /^git\s+status\s+--short(?:\s+--branch)?$|^git\s+status\s+--branch\s+--short$/
export function isPreConfirmationInspectionCommand(command: string | undefined): boolean {
  if (!command || /[|<>;`$\n\r]/.test(command)) return false
  return PRE_CONFIRMATION_INSPECTION.test(command.trim())
}
/** A stage that never ran because one of its dependencies is already blocked. */
export function isCascadeBlocked(task: ControlledTask, tasks: readonly ControlledTask[]): boolean {
  return task.status === 'blocked' && task.attempts === 0 && task.dependsOn.some((id) => { const dependency = tasks.find((item) => item.id === id); return dependency?.status === 'blocked' && !dependencySatisfied(task, dependency, tasks) })
}

/** The stage that actually failed, walking past dependents that only inherited that failure. */
export function rootBlockedDependency(task: ControlledTask, tasks: readonly ControlledTask[]): ControlledTask | undefined {
  const direct = task.dependsOn.map((id) => tasks.find((item) => item.id === id)).find((item) => item?.status === 'blocked' && !dependencySatisfied(task, item, tasks))
  if (!direct) return undefined
  return isCascadeBlocked(direct, tasks) ? rootBlockedDependency(direct, tasks) ?? direct : direct
}

function inheritedBlockNote(blocker: ControlledTask, tasks: readonly ControlledTask[]): string {
  const root = isCascadeBlocked(blocker, tasks) ? rootBlockedDependency(blocker, tasks) ?? blocker : blocker
  const reason = root.note?.trim()
  return (reason && reason.length > 0 ? reason : root.goal).slice(0, 700)
}

/** A changed description is not progress; only settled evidence changes count. */
function recoveryFailures(state: TaskControllerState): FailureRecord[] {
  const failures = state.tasks.filter(t => t.status !== 'passed' && !isCascadeBlocked(t, state.tasks)).map(t => t.failure ?? failureFromNote(t.note ?? t.goal, t.evidenceRefs))
  const reviews = (state.finalReview ?? []).filter(r => r.status === 'not_met' || state.tasks.every(task => task.status === 'passed') && r.status === 'unverifiable').map(r => ({ ...failureFromNote(r.rationale, r.evidenceRefs), ...(r.status === 'unverifiable' ? { phase: 'verification' as const } : {}) }))
  return [...failures, ...reviews, ...(state.finalReviewErrors ?? []).map(error => ({ ...(/^SOURCE_(?:VERIFICATION|CLAIM_AUDIT)_UNAVAILABLE: MODEL_BUDGET_CHECKPOINT\./.test(error) ? failureRecord('MODEL_BUDGET_CHECKPOINT', error) : failureRecord(error.match(NATIVE_FRESHNESS_FAILURE)?.[1] ?? failureFromNote(error).code, error)), phase: 'verification' as const }))]
}
const NATIVE_FRESHNESS_FAILURE = /^SOURCE_(?:VERIFICATION|CLAIM_AUDIT)_UNAVAILABLE: (EVIDENCE_CHANGED|VERIFICATION_TARGET_MISMATCH)\b/
const FRESHNESS_CODES = new Set(['EVIDENCE_CHANGED', 'VERIFICATION_TARGET_MISMATCH'])
/** The native freshness failure of the trailing recovery chain in which no replan changed any settled evidence. */
export function unrepairedEvidenceFailure(state: TaskControllerState | undefined): FailureRecord | undefined {
  if (!state) return undefined
  const attempts = state.recoveryAttempts ?? []
  let start = attempts.length
  while (start > 0 && attempts[start - 1]!.result !== 'progress') start--
  for (const attempt of attempts.slice(start)) { const found = attempt.failures.find(failure => FRESHNESS_CODES.has(failure.code)); if (found) return found }
  const current = recoveryFailures(state).find(failure => FRESHNESS_CODES.has(failure.code))
  return current
}
function recoveryProgressKey(state: TaskControllerState): string {
  return JSON.stringify([...new Set(state.evidenceKeys ?? [])].sort())
}
export function unmetGoalCanChangeApproach(state: TaskControllerState, options?: { enforceTurnBudget?: boolean; recoverFinalReview?: boolean }): boolean {
  if (state.reliability && (Object.values(state.reliability.cycles).some(cycle => cycle.phase === 'blocked') || Object.values(state.reliability.environments).some(block => block.refs.length >= 2))) return false
  if (state.budgetStopped || state.actualBudget?.workAllowed === false || state.actualBudget && state.actualBudget.used >= state.actualBudget.limit - 2) return false
  if (options?.enforceTurnBudget !== false && state.usedTurns >= state.maxTurns - 2) return false
  const previous = state.recoveryAttempts?.at(-1)
  const stagnant = previous && previous.progressKey === recoveryProgressKey(state) ? (state.recoveryNoProgress ?? 0) + 1 : 0
  if (stagnant >= 8 || state.goalRecoveries >= maxGoalRecoveries) return false
  const failures = recoveryFailures(state)
  if (!failures.length || failures.some(f => !f.recoverable)) return false
  return state.tasks.some(t => t.status !== 'passed') || options?.recoverFinalReview === true
}

export function recoverUnmetGoal(state: TaskControllerState, options?: { recoverFinalReview?: boolean }): void {
  const failed = state.tasks.filter((task) => task.status !== 'passed' && !isCascadeBlocked(task, state.tasks))
  const reviews = (state.finalReview ?? []).filter(item => item.status === 'not_met' || state.tasks.every(task => task.status === 'passed') && item.status === 'unverifiable')
  const finalFailures = reviews.map((item) => `${item.criterionId}: ${item.rationale}`)
  const summary = [...failed.map((task) => `${task.id}: ${task.goal} — ${task.note ?? task.status}`), ...finalFailures].join('\n').slice(0, 1_500)
  const failures = recoveryFailures(state)
  state.recoveryMode = failures.length > 0 && failures.every(failure => failure.phase === 'verification' || failure.category === 'verification') ? 'verify' : 'work'
  const progressKey = recoveryProgressKey(state)
  const previous = state.recoveryAttempts?.at(-1)
  const changed = !previous || previous.progressKey !== progressKey
  if (previous) previous.result = changed ? 'progress' : 'no-progress'
  state.recoveryNoProgress = changed ? 0 : (state.recoveryNoProgress ?? 0) + 1
  state.goalRecoveries += 1
  if (state.planFeedbackPending) state.planReviewRepairs = 0
  state.recoveryAttempts = [...(state.recoveryAttempts ?? []), { id: state.goalRecoveries, failures, progressKey, result: 'pending' }]
  state.lastRecoveryKey = JSON.stringify(failures.map(f => f.code)).slice(0, 800)
  const passed = state.tasks.filter((task) => task.status === 'passed')
  const unmet = state.tasks.filter((task) => task.status !== 'passed')
  state.priorTasks = [...state.priorTasks, ...unmet].slice(-256)
  state.updates = [...state.updates, recoveryInstruction(failures) + '\n' + summary].slice(-8)
  state.tasks = passed
  state.recoveryCriterionIds = [...new Set([
    ...unmet.flatMap((task) => task.criterionIds),
    ...reviews.map((item) => item.criterionId),
    ...(state.finalReviewErrors?.length ? state.tasks.flatMap(task => task.criterionIds) : []),
  ])]
  delete state.activeId
  delete state.activeIds
  delete state.finalReview
  delete state.planErrors
  delete state.finalReviewErrors
  delete state.finalReviewStatus
  state.verificationRetries = {}
  // New work invalidates the current independent verdict. Original receipts
  // remain in Runtime history; the frozen checks must run again after correction.
  if (options?.recoverFinalReview) delete state.acceptanceResults
}
export function nextTask(state: TaskControllerState): ControlledTask | undefined {
  let changed = true
  while (changed) {
    changed = false
    for (const task of state.tasks) {
      if (task.status !== 'pending') continue
      const blocker = task.dependsOn.map((id) => state.tasks.find((item) => item.id === id)).find((item) => item?.status === 'blocked' && !dependencySatisfied(task, item, state.tasks))
      if (!blocker) continue
      task.status = 'blocked'
      task.note = inheritedBlockNote(blocker, state.tasks)
      changed = true
    }
  }
  return state.tasks.find((task) => task.status === 'pending' && task.dependsOn.every((id) => dependencySatisfied(task, state.tasks.find((item) => item.id === id), state.tasks)))
}
export function reviseController(state: TaskControllerState, inputs: Array<{ id: string; text: string }>): TaskControllerState {
  const fresh = inputs.filter((input) => !state.seenInputIds.includes(input.id))
  if (!fresh.length) return state
  const { activeId: _activeId, activeIds: _activeIds, finalReview: _review, planErrors: _planErrors, recoveryCriterionIds: _recovery, ...rest } = state
  return { ...rest, revision: state.revision + 1,
    priorTasks: [...state.priorTasks, ...state.tasks].slice(-32), tasks: [],
    seenInputIds: [...state.seenInputIds, ...fresh.map((input) => input.id)],
    updates: [...state.updates, ...fresh.map((input) => input.text)] }
}
