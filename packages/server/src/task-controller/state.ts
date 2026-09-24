import { z } from 'zod'
import type { JsonValue } from '@hunterzhu/pulse-runtime'

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
  planErrors?: string[]
  finalReviewErrors?: string[]
  finalReview?: Array<{ criterionId: string; status: 'passed' | 'not_met' | 'unverifiable'; evidenceRefs: string[]; rationale: string }>
  activeId?: string
}
export function initialController(maxTurns: number): TaskControllerState {
  return { schemaVersion: 1, revision: 1, tasks: [], priorTasks: [], seenInputIds: [], updates: [], seenModelRefs: [], usedTurns: 0, maxTurns, }
}
const controlledTaskSchema = plannedTaskSchema.extend({
  status: z.enum(['pending', 'running', 'verifying', 'passed', 'blocked']),
  attempts: z.number().int().min(0).max(2), evidenceRefs: z.array(z.string()),
  candidateRef: z.string().optional(), note: z.string().optional(),
  investigationRounds: z.number().int().min(0).default(0), directedInvestigations: z.number().int().min(0).default(0), progressReviewed: z.boolean().default(false), lastInvestigationBatch: z.string().optional(),
  modelCalls: z.number().int().min(0).default(0),
})
const controllerSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  tasks: z.array(controlledTaskSchema).max(8), priorTasks: z.array(controlledTaskSchema).max(32),
  seenInputIds: z.array(z.string()), updates: z.array(z.string()), seenModelRefs: z.array(z.string()),
  usedTurns: z.number().int().min(0), maxTurns: z.number().int().min(4).max(256), activeId: z.string().optional(),
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
/** Conservative allowlist for shell commands that inspect state without writing it. */
export function isReadOnlyInspectionCommand(command: string | undefined): boolean {
  if (!command || /[|<>;`$\n\r]/.test(command)) return false
  const segments = command.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean)
  if (!segments.length) return false
  return segments.every((segment) => /^(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|diff-tree)\b|(?:pwd|ls|rg|grep|find|cat|sed|head|tail|wc)\b)(?!.*(?:\s(?:--output|--exec|--delete|-exec|-delete)\b))/.test(segment))
}
/** Block dependent tasks, but keep unrelated tasks eligible. */
export function nextTask(state: TaskControllerState): ControlledTask | undefined {
  let changed = true
  while (changed) {
    changed = false
    for (const task of state.tasks) {
      if (task.status === 'pending' && task.dependsOn.some((id) => state.tasks.find((item) => item.id === id)?.status === 'blocked')) {
        task.status = 'blocked'; task.note = 'Required dependency is blocked.'; changed = true
      }
    }
  }
  return state.tasks.find((task) => task.status === 'pending' && task.dependsOn.every((id) => state.tasks.find((item) => item.id === id)?.status === 'passed'))
}
export function reviseController(state: TaskControllerState, inputs: Array<{ id: string; text: string }>): TaskControllerState {
  const fresh = inputs.filter((input) => !state.seenInputIds.includes(input.id))
  if (!fresh.length) return state
  const { activeId: _activeId, finalReview: _review, planErrors: _planErrors, ...rest } = state
  return { ...rest, revision: state.revision + 1,
    priorTasks: [...state.priorTasks, ...state.tasks].slice(-32), tasks: [],
    seenInputIds: [...state.seenInputIds, ...fresh.map((input) => input.id)],
    updates: [...state.updates, ...fresh.map((input) => input.text)] }
}
