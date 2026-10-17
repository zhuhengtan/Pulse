import { describe, expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { validatePlan } from '../packages/server/src/task-controller/state.js'

const stage = (check: string) => ({ id: 'response', kind: 'analyze' as const, goal: 'Explain the computed result', check, criterionIds: ['original'], dependsOn: [] })

describe('plan check provenance', () => {
  it('rejects a derived decimal oracle before execution but preserves explicit original values', () => {
    expect(() => validatePlan([stage('Return exactly 12.375')], ['original'], 'Compute the total using the documented rules.')).toThrow('TASK_PLAN_UNGROUNDED_EXPECTATION')
    expect(() => validatePlan([stage('Return exactly 12.375')], ['original'], 'The total must equal 12.375.')).not.toThrow()
    expect(() => validatePlan([stage('返回 12.375')], ['original'], '结果必须等于 12.375')).not.toThrow()
    expect(() => validatePlan([stage('Tests exit with code 0 and no floating point tail')], ['original'], 'Fix precision and run tests.')).not.toThrow()
  })

  it('replans an invented check before doing work and supplies the original contract to stage review', async () => {
    const objective = 'Explain how the total follows the documented rounding rules.'
    const initialGlobal: JsonValue = { taskRecord: { schemaVersion: 1, runId: 'test', objective, acceptanceCriteria: [{ id: 'original', description: objective }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } }
    let agentId = '', plans = 0, work = 0, reviewed = false
    const global = (): any => { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) }
    const program = buildTaskControllerProgram({ version: '13', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 24 })
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.key?.startsWith('plan')) {
        plans++
        if (plans === 2) {
          expect(work).toBe(0)
          expect(JSON.stringify(effect.input)).toContain('TASK_PLAN_UNGROUNDED_EXPECTATION')
        }
        return { value: { tasks: [stage(plans === 1 ? 'Return exactly 12.375' : 'Explain the documented calculation')] } }
      }
      const task = global().taskController.tasks[0]
      if (effect.key?.startsWith('verify-stage')) {
        expect((effect.input as any).inputs.originalContract).toMatchObject({ objective, acceptanceCriteria: [{ id: 'original', description: objective }] })
        reviewed = true
        return { value: { status: 'passed', evidenceRefs: [task.candidateRef], note: 'Requested explanation delivered' } }
      }
      if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'original', status: 'passed', evidenceRefs: task.evidenceRefs, rationale: 'Explanation delivered' }] } }
      work++
      return { value: { text: 'The total follows the documented rounding rules.', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: objective, program, initialGlobal }).agentId
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(global().taskOutcome.status).toBe('accepted')
    expect(plans).toBe(2)
    expect(work).toBe(1)
    expect(reviewed).toBe(true)
  })
})
