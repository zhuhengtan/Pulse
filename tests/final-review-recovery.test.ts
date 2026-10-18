import { expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

async function runReview(options: { version?: '18' | '19'; verdict?: 'passed' | 'not_met' | 'unverifiable'; repeated?: boolean; changing?: boolean; reason?: string; exhausted?: boolean; frozen?: boolean } = {}) {
  let agentId = '', plans = 0, finals = 0, calls = 0
  const writes: string[] = [], turns = new Map<string, number>()
  const program = buildTaskControllerProgram({ version: options.version ?? '19', system: 'offline fixture', approvalMode: 'auto', maxTurns: 96, toolNames: ['fs.write', 'host.check'], modelBudgetView: () => ({ limit: 96, used: calls, workAllowed: !(options.exhausted && finals > 0), verificationAllowed: true, finalAllowed: true }) })
  const global = (): any => { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') {
      const input = effect.input as any
      if (input.name === 'host.check') return { value: { checks: [{ id: 'reject-invalid', passed: writes.includes('correction-2.mjs'), detail: 'Validation must reject invalid input' }] } }
      const path = input.arguments.path as string
      writes.push(path)
      return { value: { path, hash: `hash-${path}`, changed: true } }
    }
    calls++
    if (effect.key?.startsWith('plan')) {
      plans++
      return { value: { tasks: [{ id: `delivery-${plans}`, kind: 'edit', goal: `Create ${plans === 1 ? 'module.mjs' : `correction-${plans}.mjs`}`, check: 'File saved', dependsOn: [], criterionIds: ['c1'] }] } }
    }
    const lane = runtime.state.lanes.get(effect.ownerLaneId)!
    const state = (lane.context.state as any)?.taskControllerChain ?? global().taskController
    if (effect.key?.startsWith('verify-stage')) {
      const task = state.tasks.find((t: any) => t.id === state.activeId)
      return { value: { status: 'passed', evidenceRefs: task.evidenceRefs, note: 'Stage contribution verified' } }
    }
    if (effect.key?.startsWith('verify-task')) {
      finals++
      const status = options.verdict ?? (plans > 1 && !options.repeated && !options.changing ? 'passed' : 'not_met')
      return { value: { criteria: [{ criterionId: 'c1', status, evidenceRefs: state.tasks.flatMap((t: any) => t.evidenceRefs), rationale: options.reason ?? `Missing input validation${options.changing ? ` ${finals}` : ''}` }] } }
    }
    const taskId = (lane.resume.locals as any).taskControllerTaskId ?? state.activeId
    const turn = (turns.get(taskId) ?? 0) + 1; turns.set(taskId, turn)
    return { value: turn === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: plans === 1 ? 'module.mjs' : `correction-${plans}.mjs`, content: 'export const validation = true\n' } }] } : { text: 'Stage done', finishReason: 'stop' } }
  } })
  const record: JsonValue = { schemaVersion: 1, runId: 'review', objective: 'Create module and reject invalid input', acceptanceCriteria: [{ id: 'c1', description: 'Invalid input is rejected' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [], ...(options.frozen ? { acceptanceChecks: [{ id: 'validation', description: 'Caller-owned invalid-input check', criterionIds: ['c1'], toolName: 'host.check', input: {}, expectedChecks: ['reject-invalid'], covers: [] }] } : {}) }
  agentId = runtime.createAgent({ goal: 'Create module and reject invalid input', program, initialGlobal: { taskRecord: record } }).agentId
  try {
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded')
    return { plans, finals, calls, writes, controller: global().taskController, outcome: global().taskOutcome }
  } finally { await runtime.shutdown() }
}

it('repairs a final unmet requirement without replaying the passed delivery', async () => {
  const result = await runReview()
  expect(result.outcome.status, JSON.stringify(result)).toBe('accepted')
  expect(result.plans).toBe(2)
  expect(result.controller.goalRecoveries).toBe(1)
  expect(result.outcome.replanCount).toBe(1)
  expect(result.writes).toEqual(['module.mjs', 'correction-2.mjs'])
  expect(result.controller.tasks[0]).toMatchObject({ id: 'delivery-1', status: 'passed', attempts: 1 })
})

it('keeps v18 terminal behavior when restoring its historical program', async () => {
  const result = await runReview({ version: '18' })
  expect(result.outcome.status).toBe('incomplete')
  expect(result.plans).toBe(1)
})

it('stops a repeated final failure instead of indefinitely adding correction plans', async () => {
  const result = await runReview({ repeated: true })
  expect(result.outcome.status).toBe('incomplete')
  expect(result.plans).toBe(2)
})

it('bounds changing final failures by the existing goal recovery limit', async () => {
  const result = await runReview({ changing: true })
  expect(result.outcome.status).toBe('incomplete')
  expect(result.controller.goalRecoveries, JSON.stringify(result)).toBe(3)
  expect(result.plans).toBe(4)
  expect(result.writes.filter(path => path === 'module.mjs')).toHaveLength(1)
})

it.each([
  { verdict: 'unverifiable' as const },
  { reason: 'APPROVAL_DENIED: user must approve the operation' },
  { reason: 'EVIDENCE_CHANGED: original check is stale' },
  { exhausted: true },
])('retains uncertainty, refusal and budget stops: %j', async options => {
  const result = await runReview(options)
  expect(result.outcome.status).toBe('incomplete')
  expect(result.plans).toBe(1)
})

it('repairs a failed frozen assertion even when the final model optimistically passes it', async () => {
  const result = await runReview({ frozen: true, verdict: 'passed' })
  expect(result.outcome.status, JSON.stringify(result)).toBe('accepted')
  expect(result.plans).toBe(2)
  expect(result.controller.acceptanceResults[0].status).toBe('passed')
})
