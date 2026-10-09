import { z } from 'zod'
import type { JsonValue } from '@hunterzhu/pulse-runtime'

/** An achievable stage correction can be retried while turn budget remains. */
export const maxStageAttempts = 4
/** When the original goal is still unmet because a method or tool failed, try another plan while the failure changes. */
export const maxGoalRecoveries = 32
/** A reworded plan of the same failure should not restart the task indefinitely. */
const usefulGoalRecoveries = 3
export const plannedTaskSchema = z.object({
  id: z.string().min(1).max(64),
  goal: z.string().min(1).max(700),
  criterionIds: z.array(z.string()).min(1).max(32),
  dependsOn: z.array(z.string()).max(8),
  check: z.string().min(1).max(500),
})
export const planSchema = z.object({ tasks: z.array(plannedTaskSchema).min(1).max(8) })
export type PlannedTask = z.infer<typeof plannedTaskSchema>
export interface ControlledTask extends PlannedTask {
  status: 'pending' | 'running' | 'verifying' | 'passed' | 'blocked'
  attempts: number
  evidenceRefs: string[]
  candidateRef?: string
  correctionKind?: 'edit' | 'verify' | 'report'
  note?: string
  modelCalls?: number
  investigationRounds?: number
  directedInvestigations?: number
  progressReviewed?: boolean
  lastInvestigationBatch?: string
}
export interface TaskControllerState {
  schemaVersion: 1
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
  finalReviewErrors?: string[]
  finalReview?: Array<{ criterionId: string; status: 'passed' | 'not_met' | 'unverifiable'; evidenceRefs: string[]; rationale: string }>
  activeId?: string
  activeIds?: string[]
}
export function initialController(maxTurns: number): TaskControllerState {
  return { schemaVersion: 1, revision: 1, tasks: [], priorTasks: [], seenInputIds: [], updates: [], seenModelRefs: [], usedTurns: 0, maxTurns, goalRecoveries: 0 }
}
const controlledTaskSchema = plannedTaskSchema.extend({
  status: z.enum(['pending', 'running', 'verifying', 'passed', 'blocked']),
  attempts: z.number().int().min(0).max(maxStageAttempts), evidenceRefs: z.array(z.string()),
  candidateRef: z.string().optional(), note: z.string().optional(),
  correctionKind: z.enum(['edit', 'verify', 'report']).optional(),
  investigationRounds: z.number().int().min(0).default(0), directedInvestigations: z.number().int().min(0).default(0), progressReviewed: z.boolean().default(false), lastInvestigationBatch: z.string().optional(),
  modelCalls: z.number().int().min(0).default(0),
})
const controllerSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  tasks: z.array(controlledTaskSchema).max(8), priorTasks: z.array(controlledTaskSchema).max(32),
  seenInputIds: z.array(z.string()), updates: z.array(z.string()), seenModelRefs: z.array(z.string()),
  usedTurns: z.number().int().min(0), maxTurns: z.number().int().min(4).max(256), goalRecoveries: z.number().int().min(0).max(maxGoalRecoveries).default(0), lastRecoveryKey: z.string().max(800).optional(), activeId: z.string().optional(), activeIds: z.array(z.string()).max(8).optional(),
  planErrors: z.array(z.string()).max(2).optional(),
  finalReviewErrors: z.array(z.string()).max(1).optional(),
  finalReview: z.array(z.object({ criterionId: z.string(), status: z.enum(['passed', 'not_met', 'unverifiable']), evidenceRefs: z.array(z.string()), rationale: z.string() })).optional(),
})
export function controllerFromGlobal(global: Readonly<JsonValue>): TaskControllerState | undefined {
  if (!global || typeof global !== 'object' || Array.isArray(global)) return undefined
  const value = (global as Record<string, JsonValue>).taskController
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const parsed = controllerSchema.safeParse(value)
  if (!parsed.success) throw new Error('TASK_CONTROLLER_STATE_INVALID')
  return JSON.parse(JSON.stringify(parsed.data)) as TaskControllerState
}
export function validatePlan(tasks: PlannedTask[], criterionIds: string[]): void {
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
    if (!task) throw new Error('TASK_PLAN_UNKNOWN_DEPENDENCY')
    visiting.add(id)
    task.dependsOn.forEach(walk)
    visiting.delete(id)
    done.add(id)
  }
  tasks.forEach((task) => walk(task.id))
}
const TOOL_RUNNER = /\b(?:node|npm|pnpm|yarn|bun|pytest|cargo|vitest|jest|make|python3?|pip3?|ruby|gradle|mvn|dotnet|gcc|clang|tsc|eslint|ruff)\b|\bgo\s+test\b/i
const WORKSPACE_FILE = /(?:^|[\s`'"(])(?:\.{1,2}\/|[\w.-]+\/)[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b|\b(?!node\.js\b)[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|md|json|ya?ml|toml|css|html|vue|svelte|sh|sql|cpp|hpp|cs|rb|php|swift|kt|txt|lock|c|h)\b/i

/** A stage whose goal is to change code, not only to locate or inspect it. */
export function stageRequiresFileChange(goal: string, check: string): boolean {
  const text = `${goal}\n${check}`
  const readOnly = /只读|仅(?:审查|分析|检查)|(?:不要|不得|禁止|无需|不允许|不需要|不|未)(?:修改|改动|编辑|创建|新增|修复)|(?:不要|不得|禁止|无需|不允许|不需要|不|未)写入(?:文件|代码)|(?:无|没有)(?:需|须)?(?:修改|改动|编辑|创建|新增|修复|写入)|\bread[- ]only\b|\b(?:do not|don't|must not|never|without|no)\s+(?:(?:any|file|code)\s+)*(?:modif\w*|edit\w*|chang\w*|writ\w*|creat\w*|add\w*|fix\w*)/i
  if (readOnly.test(text)) return false
  const inspection = /^\s*(?:审查|检查|分析|阅读|读取|定位|查看|\b(?:review|inspect|analyze|read|locate)\b)/i.test(goal)
  const alsoEdit = /(?:并|然后|\b(?:and|then)\s+)(?:修改|修复|新增|创建|实现|(?:implement|modify|patch|create|edit|fix|refactor|add|update|write)\b)/i.test(goal)
  const validation = /(?:验证|复现|运行|测试|确认|输出|列出|记录|reproduce|verify|run|test|check|report|review)/i.test(goal)
  const directEdit = /^\s*(?:新增|修改|实现|创建|接入|改动|写入|修复|\b(?:implement|modify|patch|create|edit|fix|refactor|add|update|write)\b)/i.test(goal)
  if ((inspection || validation) && !directEdit && !alsoEdit) return false
  // A filename or a mention of an implementation is evidence scope, not edit intent.
  return /新增|修改|实现|创建|接入|改动|写入|修复|\b(?:implement|modify|patch|create|edit|fix|refactor|add|update|write)\b/i.test(goal)
}

/** Implementation, file, and command stages need settled tool evidence. Versions and abbreviations do not. */
export function stageRequiresToolEvidence(goal: string, check: string): boolean {
  const text = `${goal}\n${check}`
  return TOOL_RUNNER.test(text) || WORKSPACE_FILE.test(text)
}

/** Conservative allowlist for shell commands that inspect state without writing it. */
export function isReadOnlyInspectionCommand(command: string | undefined): boolean {
  if (!command || /[|<>;`$\n\r]/.test(command)) return false
  const segments = command.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean)
  if (!segments.length) return false
  return segments.every((segment) => /^(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|diff-tree)\b|(?:pwd|ls|rg|grep|find|cat|sed|head|tail|wc)\b)(?!.*(?:\s(?:--output|--exec|--delete|-exec|-delete)\b))/.test(segment))
}
/** A stage that never ran because one of its dependencies is already blocked. */
export function isCascadeBlocked(task: ControlledTask, tasks: readonly ControlledTask[]): boolean {
  return task.status === 'blocked' && task.attempts === 0 && task.dependsOn.some((id) => tasks.find((item) => item.id === id)?.status === 'blocked')
}

/** The stage that actually failed, walking past dependents that only inherited that failure. */
export function rootBlockedDependency(task: ControlledTask, tasks: readonly ControlledTask[]): ControlledTask | undefined {
  const direct = task.dependsOn.map((id) => tasks.find((item) => item.id === id)).find((item) => item?.status === 'blocked')
  if (!direct) return undefined
  return isCascadeBlocked(direct, tasks) ? rootBlockedDependency(direct, tasks) ?? direct : direct
}

function inheritedBlockNote(blocker: ControlledTask, tasks: readonly ControlledTask[]): string {
  const root = isCascadeBlocked(blocker, tasks) ? rootBlockedDependency(blocker, tasks) ?? blocker : blocker
  const reason = root.note?.trim()
  return (reason && reason.length > 0 ? reason : root.goal).slice(0, 700)
}

/** Permission, user, and environment limits are not fixed by repeating another plan. A local model such as Ollama is an authorized path. */
const EXTERNAL_GOAL_BLOCK = /permission|denied|not authorized|unauthorized|deferred|user must|awaiting user|external|sandbox|EPERM|审批被拒|权限|外部|用户必须|延期/i
const LOCAL_MODEL_PATH = /ollama|本机|本地模型/i
const HARD_AUTH_BLOCK = /permission|denied|not authorized|unauthorized|EPERM|审批被拒|权限/i

function isExternalGoalBlock(note: string): boolean {
  if (LOCAL_MODEL_PATH.test(note) && !HARD_AUTH_BLOCK.test(note)) return false
  return EXTERNAL_GOAL_BLOCK.test(note)
}

function recoveryKey(state: TaskControllerState): string {
  const roots = state.tasks.filter((task) => task.status !== 'passed').map((task) => {
    const root = isCascadeBlocked(task, state.tasks) ? rootBlockedDependency(task, state.tasks) ?? task : task
    return `${root.goal}\n${(root.note ?? '').replace(/\s+/g, ' ').trim()}`
  })
  const finalFailures = (state.finalReview ?? []).filter((item) => item.status === 'not_met').map((item) => `${item.criterionId}\n${item.rationale}`)
  return [...new Set([...roots, ...finalFailures])].sort().join('\n').slice(0, 800)
}

export function unmetGoalCanChangeApproach(state: TaskControllerState, options?: { enforceTurnBudget?: boolean }): boolean {
  if (state.goalRecoveries >= usefulGoalRecoveries) return false
  if (options?.enforceTurnBudget !== false && state.usedTurns >= state.maxTurns - 2) return false
  if (state.tasks.length === 0) return false
  const key = recoveryKey(state)
  if (!key || key === state.lastRecoveryKey) return false
  const finalFailures = (state.finalReview ?? []).filter((item) => item.status === 'not_met')
  if (finalFailures.length > 0 && state.tasks.every((task) => task.status === 'passed')) return true
  if (state.tasks.every((task) => task.status === 'passed')) return false
  const open = state.tasks.filter((task) => task.status !== 'passed')
  return open.some((task) => {
    const root = isCascadeBlocked(task, state.tasks) ? rootBlockedDependency(task, state.tasks) ?? task : task
    const note = root.note ?? ''
    if (note.includes('Total model budget exhausted')) return false
    return !isExternalGoalBlock(note)
  })
}

export function recoverUnmetGoal(state: TaskControllerState): void {
  const failed = state.tasks.filter((task) => task.status !== 'passed' && !isCascadeBlocked(task, state.tasks))
  const finalFailures = (state.finalReview ?? []).filter((item) => item.status === 'not_met').map((item) => `${item.criterionId}: ${item.rationale}`)
  const summary = [...failed.map((task) => `${task.id}: ${task.goal} — ${task.note ?? task.status}`), ...finalFailures].join('\n').slice(0, 1_500)
  state.lastRecoveryKey = recoveryKey(state)
  state.goalRecoveries += 1
  state.priorTasks = [...state.priorTasks, ...state.tasks].slice(-32)
  state.updates = [...state.updates, `Goal recovery ${state.goalRecoveries}: the original goal is not met. Keep every file already written. Fix only the failed check below. Do not locate the feature again and do not recreate a module that already exists. Earlier reads are already in the supplied results; do not read those files again.\n${summary}`].slice(-8)
  state.tasks = []
  delete state.activeId
  delete state.activeIds
  delete state.finalReview
  delete state.planErrors
  delete state.finalReviewErrors
}
export function nextTask(state: TaskControllerState): ControlledTask | undefined {
  let changed = true
  while (changed) {
    changed = false
    for (const task of state.tasks) {
      if (task.status !== 'pending') continue
      const blocker = task.dependsOn.map((id) => state.tasks.find((item) => item.id === id)).find((item) => item?.status === 'blocked')
      if (!blocker) continue
      task.status = 'blocked'
      task.note = inheritedBlockNote(blocker, state.tasks)
      changed = true
    }
  }
  return state.tasks.find((task) => task.status === 'pending' && task.dependsOn.every((id) => state.tasks.find((item) => item.id === id)?.status === 'passed'))
}
export function reviseController(state: TaskControllerState, inputs: Array<{ id: string; text: string }>): TaskControllerState {
  const fresh = inputs.filter((input) => !state.seenInputIds.includes(input.id))
  if (!fresh.length) return state
  const { activeId: _activeId, activeIds: _activeIds, finalReview: _review, planErrors: _planErrors, ...rest } = state
  return { ...rest, revision: state.revision + 1,
    priorTasks: [...state.priorTasks, ...state.tasks].slice(-32), tasks: [],
    seenInputIds: [...state.seenInputIds, ...fresh.map((input) => input.id)],
    updates: [...state.updates, ...fresh.map((input) => input.text)] }
}
