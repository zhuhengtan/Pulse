import { describe, expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { initialController, nextTask, reviseController, validatePlan } from '../packages/server/src/task-controller/state.js'

const task = (id: string, dependsOn: string[] = []) => ({ id, goal: `Implement ${id}`, check: 'Read and verify result', dependsOn, criterionIds: [id.replace('task-', 'criterion-')] })
const initialGlobal = (count: number): JsonValue => ({ taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Complete the checklist', acceptanceCriteria: Array.from({ length: count }, (_, index) => ({ id: `criterion-${index + 1}`, description: `Requirement ${index + 1}` })), status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } })
function globalFor(runtime: PulseRuntime, agentId: string): any { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) }

function finalReview(runtime: PulseRuntime): { value: JsonValue } {
  const agent = [...runtime.state.agents.values()][0]!
  const global = globalFor(runtime, agent.id)
  return { value: { criteria: global.taskRecord.acceptanceCriteria.map((criterion: any) => ({ criterionId: criterion.id, status: 'passed', evidenceRefs: global.taskController.tasks.flatMap((task: any) => task.evidenceRefs), rationale: 'Verified original requirement' })) } }
}

describe('Host task controller', () => {
  it('rejects cycles, unknown dependencies and omitted original requirements', () => {
    expect(() => validatePlan([task('task-1', ['task-2']), task('task-2', ['task-1'])], ['criterion-1', 'criterion-2'])).toThrow('CYCLE')
    expect(() => validatePlan([task('task-1', ['missing'])], ['criterion-1'])).toThrow('UNKNOWN_DEPENDENCY')
    expect(() => validatePlan([task('task-1')], ['criterion-1', 'criterion-2'])).toThrow('CRITERIA_MISMATCH')
  })

  it('blocks dependent tasks while selecting independent work and preserves revision budget', () => {
    const state = initialController(20)
    state.usedTurns = 8
    state.tasks = [task('task-1'), task('task-2', ['task-1']), task('task-3')].map((item) => ({ ...item, status: 'pending', attempts: 0, evidenceRefs: [] }))
    state.tasks[0]!.status = 'blocked'
    expect(nextTask(state)?.id).toBe('task-3')
    expect(state.tasks[1]!.status).toBe('blocked')
    const revised = reviseController(state, [{ id: 'human-1', text: 'Do not modify file A' }])
    expect(revised.revision).toBe(2)
    expect(revised.usedTurns).toBe(8)
    expect(revised.priorTasks).toHaveLength(3)
    expect(reviseController(revised, [{ id: 'human-1', text: 'duplicate' }])).toEqual(revised)
  })

  it('retries an invalid criterion mapping once without dispatching tools', async () => {
    let plans = 0
    let tools = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 10 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { tools++; return { value: {} } }
      plans++
      return { value: { tasks: [task('task-99')] } }
    } })
    const { agentId } = runtime.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(1) })
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'INVALID_TASK_PLAN' } })
    expect(plans).toBe(2)
    expect(tools).toBe(0)
    expect(globalFor(runtime, agentId).taskController.usedTurns).toBe(2)
  })

  it.each([[0, false], [1, false], [1, true]] as const)('requires successful or explicitly expected failure evidence (exit=%s, expected=%s)', async (exitCode, expectedFailure) => {
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 16 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { code: exitCode, stdout: 'checked' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.key?.startsWith('verify-stage')) {
        const refs = [...runtime.state.results.values()].filter((result) => result.producer?.kind === 'effect' && runtime.state.effects.get(result.producer.id)?.kind === 'tool').map((result) => result.id)
        return { value: { status: 'passed', evidenceRefs: expectedFailure ? [] : refs, ...(expectedFailure ? { expectedFailureRefs: refs } : {}), note: 'check passed' } }
      }
      return { value: ++workCalls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: {} }] } : { text: 'done', finishReason: 'stop' } }
    } })
    const { agentId } = runtime.createAgent({ goal: '实现一个功能', program, initialGlobal: initialGlobal(1) })
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe(exitCode === 0 || expectedFailure ? 'accepted' : 'incomplete')
    expect(globalFor(runtime, agentId).taskController.usedTurns).toBe(exitCode === 0 || expectedFailure ? 5 : 4)
  })

  it('continues independent stages after a blocked stage and skips its dependent stage', async () => {
    const executed: string[] = []
    let modelStage = ''
    let calls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { executed.push(modelStage); return { value: { content: 'evidence' } } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1'), task('task-2', ['task-1']), task('task-3')] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.key?.startsWith('verify-stage')) return { value: { status: state.activeId === 'task-1' ? 'blocked' : 'passed', evidenceRefs: state.tasks.find((item: any) => item.id === state.activeId).evidenceRefs, note: state.activeId === 'task-1' ? 'Requires permission' : 'Verified' } }
      if (modelStage !== state.activeId) { modelStage = state.activeId; calls = 0 }
      return { value: ++calls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } : { text: 'stage done', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Implement all tasks', program, initialGlobal: initialGlobal(3) }).agentId
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(executed).toEqual(['task-1', 'task-3'])
    expect(globalFor(runtime, agentId).taskController.tasks.map((item: any) => item.status)).toEqual(['blocked', 'blocked', 'passed'])
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
  })

  it('bounds a stage that keeps requesting tools and does not declare completion', async () => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 5 })
    let calls = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { changing: calls } }
      calls++
      return { value: effect.key?.startsWith('plan') ? { tasks: [task('task-1')] } : { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } }
    } })
    const { agentId } = runtime.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(1) })
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(calls).toBeLessThanOrEqual(5)
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
  })

  it.each(['passed', 'not_met'])('verifies settled evidence at the stage limit and respects final review (%s)', async (finalStatus) => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 20 })
    let stageReviews = 0
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { content: effect.id } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: finalStatus, evidenceRefs: globalFor(runtime, agentId).taskController.tasks[0].evidenceRefs, rationale: 'Independent final review' }] } }
      if (effect.key?.startsWith('verify-stage')) {
        stageReviews++
        return { value: { status: 'passed', evidenceRefs: globalFor(runtime, agentId).taskController.tasks[0].evidenceRefs, note: 'Settled evidence proves stage output' } }
      }
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } }
    } })
    agentId = runtime.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(1) }).agentId
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(stageReviews, JSON.stringify(globalFor(runtime, agentId).taskController)).toBe(1)
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe(finalStatus === 'passed' ? 'accepted' : 'incomplete')
  })
})

describe('task controller interruption', () => {
  it('discards queued writes after steering, keeps completed evidence, and replans within the same budget', async () => {
    let entered!: () => void
    const toolEntered = new Promise<void>((resolve) => { entered = resolve })
    let finishTool!: () => void
    const toolRelease = new Promise<void>((resolve) => { finishTool = resolve })
    const executed: string[] = []
    let plans = 0
    let work = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['write', 'read'], approvalMode: 'auto', maxTurns: 20 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        const input = effect.input as any
        executed.push(input.name)
        if (input.name === 'write') { entered(); await toolRelease }
        return { value: { content: 'evidence' } }
      }
      if (effect.key?.startsWith('plan')) { plans++; work = 0; return { value: { tasks: [task('task-1')] } } }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.key?.startsWith('verify-stage')) {
        const state = globalFor(runtime, agentId).taskController
        return { value: { status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs, note: 'Verified' } }
      }
      if (++work === 1) return { value: { finishReason: 'tool_calls', toolCalls: plans === 1 ? [{ name: 'write', input: { id: 1 } }, { name: 'write', input: { id: 2 } }] : [{ name: 'read', input: {} }] } }
      return { value: { text: 'done', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(1) }).agentId
    const session = runtime.start(agentId)
    const outcome = session.outcome()
    await toolEntered
    await session.submitHumanInput('steer-1', { command: 'steer', text: 'Only read now; do not execute more writes.' })
    runtime.tick()
    finishTool()
    expect(await outcome).toMatchObject({ status: 'succeeded' })
    expect(executed).toEqual(['write', 'read'])
    const state = globalFor(runtime, agentId).taskController
    expect(state.revision).toBe(2)
    expect(state.priorTasks[0].evidenceRefs).toHaveLength(1)
    expect(state.usedTurns).toBeGreaterThan(4)
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program] })
    expect(globalFor(restored, agentId).taskController).toEqual(state)
  })

  it('cancels the task without dispatching queued writes', async () => {
    let entered!: () => void
    const toolEntered = new Promise<void>((resolve) => { entered = resolve })
    let writes = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['write'], approvalMode: 'auto', maxTurns: 20 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect, signal) => {
      if (effect.kind === 'tool') {
        writes++; entered()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { status: 'cancelled', executionState: 'cancelled' }
      }
      return { value: effect.key?.startsWith('plan') ? { tasks: [task('task-1')] } : { finishReason: 'tool_calls', toolCalls: [{ name: 'write', input: { id: 1 } }, { name: 'write', input: { id: 2 } }] } }
    } })
    const { agentId } = runtime.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(1) })
    const session = runtime.start(agentId)
    const outcome = session.outcome()
    await toolEntered
    await session.cancel('USER_REQUESTED')
    expect(await outcome).toMatchObject({ status: 'cancelled' })
    expect(writes).toBe(1)
  })
})

describe('task controller recovery', () => {
  it('restores an unfinished next stage without replaying a verified previous stage', async () => {
    let paused!: () => void
    const reachedSecond = new Promise<void>((resolve) => { paused = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let shouldPause = true
    let agentId = ''
    let activeRuntime: PulseRuntime
    const executed: string[] = []
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 20 })
    const executor: NonNullable<ConstructorParameters<typeof PulseRuntime>[0]>['effectExecutor'] = async (effect) => {
      const state = globalFor(activeRuntime, agentId).taskController
      if (effect.kind === 'tool') { executed.push(state.activeId); return { value: { content: 'checked' } } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1'), task('task-2', ['task-1'])] } }
      if (effect.key?.startsWith('verify-task')) return finalReview(activeRuntime)
      if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: state.tasks.find((item: any) => item.id === state.activeId).evidenceRefs, note: 'Verified' } }
      if (state.activeId === 'task-2' && shouldPause) { paused(); await gate }
      return { value: (effect.input as any).turn === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } : { text: 'done', finishReason: 'stop' } }
    }
    const first = new PulseRuntime({ effectExecutor: executor })
    activeRuntime = first
    agentId = first.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(2) }).agentId
    const session = first.start(agentId)
    const original = session.outcome()
    await reachedSecond
    const snapshot = first.exportPersistence()
    shouldPause = false
    const restored = new PulseRuntime({ persistence: snapshot, programs: [program], effectExecutor: executor })
    activeRuntime = restored
    try {
      const result = await restored.start(agentId).outcome()
      if (result.status === 'failed') throw new Error(JSON.stringify(result))
      expect(result.status).toBe('succeeded')
      expect(executed).toEqual(['task-1', 'task-2'])
      expect(globalFor(restored, agentId).taskController.tasks.every((item: any) => item.status === 'passed')).toBe(true)
      expect(globalFor(restored, agentId).taskOutcome.status).toBe('accepted')
    } finally { await session.cancel('TEST_CLEANUP'); release(); await original }
  })
})
