import { describe, expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { initialController, isReadOnlyInspectionCommand, nextTask, reviseController, stageRequiresFileChange, stageRequiresToolEvidence, validatePlan } from '../packages/server/src/task-controller/state.js'

const task = (id: string, dependsOn: string[] = []) => ({ id, goal: `Implement ${id}`, check: 'Read and verify result', dependsOn, criterionIds: [id.replace('task-', 'criterion-')] })
const initialGlobal = (count: number): JsonValue => ({ taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Complete the checklist', acceptanceCriteria: Array.from({ length: count }, (_, index) => ({ id: `criterion-${index + 1}`, description: `Requirement ${index + 1}` })), status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } })
function globalFor(runtime: PulseRuntime, agentId: string): any { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) }

function finalReview(runtime: PulseRuntime): { value: JsonValue } {
  const agent = [...runtime.state.agents.values()][0]!
  const global = globalFor(runtime, agent.id)
  return { value: { criteria: global.taskRecord.acceptanceCriteria.map((criterion: any) => ({ criterionId: criterion.id, status: 'passed', evidenceRefs: global.taskController.tasks.flatMap((task: any) => task.evidenceRefs), rationale: 'Verified original requirement' })) } }
}

describe('Host task controller', () => {
  it('checkpoints repeated validation despite changing test durations', async () => {
    let agentId = ''
    let checks = 0
    let checkpoints = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 24 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { code: 0, stdout: `All tests passed in ${++checks} ms` } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [
        { id: 'task-1', goal: 'Run tests', check: 'Tests pass', dependsOn: [], criterionIds: ['criterion-1'] },
        { id: 'task-2', goal: 'Summarize results', check: 'Response delivered', dependsOn: ['task-1'], criterionIds: ['criterion-2'] },
      ] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('progress-review-worker')) {
        checkpoints++
        return { value: { status: 'ready', evidenceRefs: (effect.input as any).inputs.results, note: 'Tests passed; stop rerunning them.' } }
      }
      if (effect.key?.startsWith('verify-stage')) {
        const active = state.tasks.find((t: any) => t.id === state.activeId)
        return { value: { status: 'passed', evidenceRefs: active.evidenceRefs.length ? active.evidenceRefs : [active.candidateRef], note: 'Verified' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      return { value: state.tasks[0].status === 'running' ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--test'] } }] } : { text: 'All tests passed', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Validate and summarize', program, initialGlobal: initialGlobal(2) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(globalFor(runtime, agentId).taskOutcome.status, JSON.stringify(globalFor(runtime, agentId).taskController)).toBe('accepted')
    expect(checks).toBe(2)
    expect(checkpoints).toBe(1)
  })

  it('requires a staged draft to be committed before accepting file creation', async () => {
    let agentId = ''
    let committed = false
    let reviews = 0
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.stage'], approvalMode: 'auto', maxTurns: 24 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        committed = (effect.input as any).arguments.operation === 'commit'
        return { value: { committed, bytes: 50 } }
      }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ ...task('task-1'), goal: 'Create src/config.js' }] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        reviews++
        return { value: { status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs, note: 'Created' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      if (workCalls === 1 || state.tasks[0].attempts > 1 && !committed) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.stage', input: { operation: workCalls === 1 ? 'begin' : 'commit', path: 'src/config.js' } }] } }
      return { value: { text: 'File ready', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Create file', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(reviews).toBe(2)
    expect(committed).toBe(true)
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('accepted')
  })

  it.each([0, 1])('retains accepted dependency negative checks without masking a new failed check (exit=%s)', async (exitCode) => {
    let agentId = ''
    const turns = new Map<string, number>()
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 16 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      const state = agentId ? globalFor(runtime, agentId).taskController : undefined
      if (effect.kind === 'tool') return { value: { code: (effect.input as any).arguments.args[0] === 'negative' ? 1 : exitCode, stdout: 'check result' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [
        { id: 'task-1', goal: 'Verify CLI negative test', check: 'Expected nonzero exit', dependsOn: [], criterionIds: ['criterion-1'] },
        { id: 'task-2', goal: 'Run unit tests', check: 'All tests pass', dependsOn: ['task-1'], criterionIds: ['criterion-2'] },
      ] } }
      if (effect.key?.startsWith('verify-stage')) {
        const active = state.tasks.find((t: any) => t.id === state.activeId)
        return { value: { status: 'passed', evidenceRefs: state.tasks.flatMap((t: any) => t.evidenceRefs), ...(active.id === 'task-1' ? { expectedFailureRefs: active.evidenceRefs } : {}), note: 'Checked' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      const active = state.tasks.find((t: any) => t.status === 'running')
      const count = (turns.get(effect.ownerLaneId) ?? 0) + 1
      turns.set(effect.ownerLaneId, count)
      return { value: count === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: [active.id === 'task-1' ? 'negative' : '--test'] } }] } : { text: 'Checks completed', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Verify feature', program, initialGlobal: initialGlobal(2) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe(exitCode === 0 ? 'accepted' : 'incomplete')
    if (exitCode === 0) expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBe(0)
  })

  it('supplies worker tool schemas and preserves writes across verification-only retries', async () => {
    const toolNames = ['fs.write', 'shell.exec']
    const program = buildTaskControllerProgram({ system: 'test', toolNames, approvalMode: 'auto', maxTurns: 32 })
    let agentId = ''
    let writes = 0
    let checks = 0
    let reviews = 0
    let finalReviews = 0
    const turns = new Map<string, number>()
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        if ((effect.input as any).name === 'fs.write') { writes++; return { value: { path: 'src/config.js', bytes: 30 } } }
        checks++
        return { value: { code: 0, stdout: 'checks passed' } }
      }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [
        { id: 'task-1', goal: 'Create src/config.js', check: 'Run the check', dependsOn: [], criterionIds: ['criterion-1'] },
        { id: 'task-2', goal: 'Report results', check: 'Summarize verification', dependsOn: ['task-1'], criterionIds: ['criterion-2'] },
      ] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        const active = state.tasks.find((item: any) => item.id === state.activeId)
        if (active.id === 'task-1' && reviews++ === 0) return { value: { status: 'needs_work', correctionKind: 'verify', evidenceRefs: active.evidenceRefs, note: 'File is correct; run its check.' } }
        return { value: { status: 'passed', evidenceRefs: active.evidenceRefs.length ? active.evidenceRefs : [active.candidateRef], note: 'Verified' } }
      }
      if (effect.key?.startsWith('verify-task')) {
        finalReviews++
        const review = finalReview(runtime) as any
        // These candidate refs were explicitly supplied for response verification.
        for (const criterion of review.value.criteria) criterion.evidenceRefs.push(state.tasks[0].candidateRef)
        return review
      }
      expect(effect.key).toMatch(/^work-stage-worker/)
      expect((effect.input as any).toolDiscovery).toEqual({ limit: toolNames.length })
      const active = state.tasks.find((item: any) => item.status === 'running')
      const n = (turns.get(effect.ownerLaneId) ?? 0) + 1
      turns.set(effect.ownerLaneId, n)
      if (active.id === 'task-1' && n === 1) return { value: { finishReason: 'tool_calls', toolCalls: [active.attempts === 1
        ? { name: 'fs.write', input: { path: 'src/config.js', content: 'exports.value = 1' } }
        : { name: 'shell.exec', input: { command: 'node', args: ['--test'] } }] } }
      return { value: { text: 'Deliverable verified', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Create and verify a feature', program, initialGlobal: initialGlobal(2) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const state = globalFor(runtime, agentId)
    expect(state.taskOutcome.status).toBe('accepted')
    expect(state.taskController.tasks[0].attempts).toBe(2)
    expect(state.taskController.tasks[0].evidenceRefs).toHaveLength(2)
    expect(writes).toBe(1)
    expect(checks).toBe(1)
    expect(finalReviews).toBe(1)
  })

  it.each([
    ['Review src/index.ts', 'Report bugs without modifying files'],
    ['审查 src/index.ts 的实现', '不要修改文件'],
    ['Read src/index.ts', 'Describe the implementation'],
    ['运行 tests/runtime.test.ts', '测试通过'],
    ['Inspect src/index.ts', 'Verify the patch'],
    ['审查 src/index.ts 的实现', '报告缺陷'],
    ['Review the create function', 'Report bugs'],
  ])('does not require an edit for a read-only stage: %s', (goal, check) => {
    expect(stageRequiresFileChange(goal, check)).toBe(false)
  })
  it.each([
    ['用内联 node 命令复现问题，不创建任何文件', '给出复现输出与修复建议'],
    ['汇总 code review 报告', '确认未修改任何文件'],
    ['用内联命令验证行为', '确认未创建任何文件'],
    ['输出代码审查报告', '报告完成且无文件改动'],
    ['读取 src/list.js 全文，记录分页参数约定与数组是否被就地修改，标注可疑行号。', '给出完整内容摘要与行号'],
    ['用临时内联 node 命令验证页码约定以及函数是否原地修改调用方传入的数组', 'node 命令输出显示行为'],
  ])('treats negated create and review requirements as read-only', (goal, check) => {
    expect(stageRequiresFileChange(goal, check)).toBe(false)
  })
  it.each(['Implement the feature', '修改 src/index.ts', 'Fix the regression', 'Inspect and fix src/index.ts', '定位并修复问题'])('requires explicit edits: %s', (goal) => {
    expect(stageRequiresFileChange(goal, 'Verify with tests')).toBe(true)
  })

  it('keeps a review read-only after verifier feedback with edit tools available', async () => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.read', 'fs.apply_patch'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    let workCalls = 0
    let reviews = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        expect((effect.input as { name: string }).name).toBe('fs.read')
        return { value: { path: 'src/index.ts', content: 'source' } }
      }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'task-1', goal: 'Review src/index.ts', check: 'Report bugs without modifying files', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      if (effect.key?.startsWith('verify-stage')) {
        reviews++
        return { value: { status: reviews === 1 ? 'needs_work' : 'passed', evidenceRefs: globalFor(runtime, agentId).taskController.tasks[0].evidenceRefs, note: 'Explain the source evidence.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      return { value: workCalls % 2 === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'src/index.ts' } }] } : { text: 'Review findings', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Review only', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('accepted')
    expect(workCalls).toBe(4)
    expect(reviews).toBe(2)
  })

  it('uses v9 for new controllers while retaining earlier program versions for restoration', () => {
    expect(buildTaskControllerProgram({ system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 8 }).version).toBe('9')
    expect(buildTaskControllerProgram({ system: 'test', version: '8', toolNames: [], approvalMode: 'auto', maxTurns: 8 }).version).toBe('8')
    expect(buildTaskControllerProgram({ system: 'test', version: '7', toolNames: [], approvalMode: 'auto', maxTurns: 8 }).version).toBe('7')
    expect(buildTaskControllerProgram({ system: 'test', version: '6', toolNames: [], approvalMode: 'auto', maxTurns: 8 }).version).toBe('6')
  })

  it('keeps restored v6 controllers on the legacy root-lane work path', async () => {
    const program = buildTaskControllerProgram({ system: 'test', version: '6', toolNames: [], approvalMode: 'auto', maxTurns: 16 })
    let agentId = ''
    let childWorkerCalls = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1'), task('task-2')] } }
      if (effect.key?.startsWith('work-stage-worker')) childWorkerCalls++
      if (effect.key?.startsWith('verify-stage')) {
        const state = globalFor(runtime, agentId).taskController
        return { value: { status: 'passed', evidenceRefs: [state.tasks.find((item: any) => item.id === state.activeId).candidateRef], note: 'Verified.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      return { value: { text: 'legacy stage finished', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Resume legacy work', program, initialGlobal: initialGlobal(2) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(childWorkerCalls).toBe(0)
    expect(globalFor(runtime, agentId).taskController.tasks.map((item: any) => item.status)).toEqual(['passed', 'passed'])
  })

  it('runs the ready dependency frontier as concurrent Runtime worker lanes', async () => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const workerGoals: string[] = []
    let releaseWorkers!: () => void
    const bothWorkers = new Promise<void>((resolve) => { releaseWorkers = resolve })
    let firstFrontier: string[] = []
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1'), task('task-2'), task('task-3', ['task-1'])] } }
      if (effect.key?.startsWith('work-stage-worker')) {
        const goal = runtime.state.lanes.get(effect.ownerLaneId)?.goal ?? ''
        workerGoals.push(goal)
        if (workerGoals.length === 2) { firstFrontier = [...workerGoals]; releaseWorkers() }
        await bothWorkers
        return { value: { text: `finished ${goal}`, finishReason: 'stop' } }
      }
      if (effect.key?.startsWith('verify-stage')) {
        const current = globalFor(runtime, agentId).taskController.tasks.find((item: any) => item.id === globalFor(runtime, agentId).taskController.activeId)
        return { value: { status: 'passed', evidenceRefs: [current.candidateRef], note: 'Candidate verified.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      return { value: { text: 'done', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Complete every stage', program, initialGlobal: initialGlobal(3) }).agentId
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(firstFrontier.sort()).toEqual(['Implement task-1', 'Implement task-2'])
    expect(workerGoals.sort()).toEqual(['Implement task-1', 'Implement task-2', 'Implement task-3'])
    expect(globalFor(runtime, agentId).taskController.tasks.map((item: any) => item.status)).toEqual(['passed', 'passed', 'passed'])
  })

  it('retains evidence and model usage from blocked parallel workers', async () => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let reads = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { reads++; return { value: { content: `evidence-${reads}` } } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1'), task('task-2')] } }
      if (effect.key?.startsWith('progress-review-worker')) {
        const results = ((effect.input as any)?.inputs?.results ?? []) as string[]
        return { value: { status: 'blocked', evidenceRefs: results, note: 'External information is unavailable.' } }
      }
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } }
    } })
    const { agentId } = runtime.createAgent({ goal: 'Inspect two independent areas', program, initialGlobal: initialGlobal(2) })
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    const state = globalFor(runtime, agentId).taskController
    expect(state.tasks.map((item: any) => item.status)).toEqual(['blocked', 'blocked'])
    expect(state.tasks.every((item: any) => item.evidenceRefs.length === 4)).toBe(true)
    expect(state.tasks.every((item: any) => item.modelCalls >= 5)).toBe(true)
    expect(state.usedTurns).toBeGreaterThanOrEqual(11)
  })

  it('keeps a pure writing task incomplete when final review cannot verify it', async () => {
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: {} }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ ...task('task-1'), goal: 'Write a commit message from the supplied changes', check: 'Return a title and concise bullets' }] } }
      if (effect.key?.startsWith('verify-stage')) {
        const candidateRef = globalFor(runtime, agentId).taskController.tasks[0].candidateRef
        return { value: { status: 'passed', evidenceRefs: [candidateRef], note: 'The requested commit message was produced.' } }
      }
      if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'unverifiable', evidenceRefs: [], rationale: 'Final review omitted its citation.' }] } }
      return { value: { text: 'feat: improve CLI\n\n- Make terminal output easier to copy', finishReason: 'stop' } }
    } })
    const program = buildTaskControllerProgram({ system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 12 })
    agentId = runtime.createAgent({ goal: 'Write a commit message', program, initialGlobal: initialGlobal(1) }).agentId
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(globalFor(runtime, agentId).taskOutcome).toMatchObject({ status: 'incomplete', criteria: [{ status: 'unverifiable', evidenceRefs: [expect.any(String)] }] })
  })

  it('rejects cycles, unknown dependencies and omitted original requirements', () => {
    expect(() => validatePlan([task('task-1', ['task-2']), task('task-2', ['task-1'])], ['criterion-1', 'criterion-2'])).toThrow('CYCLE')
    expect(() => validatePlan([task('task-1', ['missing'])], ['criterion-1'])).toThrow('UNKNOWN_DEPENDENCY')
    expect(() => validatePlan([task('task-1')], ['criterion-1', 'criterion-2'])).toThrow('CRITERIA_MISMATCH')
  })

  it('recognizes bounded shell inspection without treating mutating commands as investigation', () => {
    expect(isReadOnlyInspectionCommand('git status --short')).toBe(true)
    expect(isReadOnlyInspectionCommand('git status --short && git diff --stat')).toBe(true)
    expect(isReadOnlyInspectionCommand('git diff -- packages/cli/src/App.tsx')).toBe(true)
    expect(isReadOnlyInspectionCommand('git add .')).toBe(false)
    expect(isReadOnlyInspectionCommand('git diff > changes.patch')).toBe(false)
    expect(isReadOnlyInspectionCommand('git status; git reset --hard')).toBe(false)
  })

  it('blocks dependent tasks while selecting independent work and preserves revision budget', () => {
    const state = initialController(20)
    state.usedTurns = 8
    state.tasks = [task('task-1'), task('task-2', ['task-1']), task('task-3')].map((item) => ({ ...item, status: 'pending', attempts: 0, evidenceRefs: [] }))
    state.tasks[0]!.status = 'blocked'
    state.tasks[0]!.note = 'Requires permission'
    expect(nextTask(state)?.id).toBe('task-3')
    expect(state.tasks[1]!.status).toBe('blocked')
    expect(state.tasks[1]!.note).toBe('Requires permission')
    expect(JSON.stringify(state.tasks)).not.toContain('Required dependency is blocked')
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
    expect(globalFor(runtime, agentId).taskController.usedTurns).toBe(exitCode === 0 || expectedFailure ? 5 : 7)
    expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBe(exitCode === 0 || expectedFailure ? 0 : 1)
  })

  it('accepts an explicitly negative check when the verifier omits the auxiliary failure refs', async () => {
    let agentId = ''
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 16 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { code: 1, stdout: '', stderr: 'missing file' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'task-1', goal: '运行缺失文件负向测试', check: '命令应以非零退出码失败', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      if (effect.key?.startsWith('verify-stage')) {
        const refs = globalFor(runtime, agentId).taskController.tasks[0].evidenceRefs
        return { value: { status: 'passed', evidenceRefs: refs, note: '负向测试按预期返回非零退出码' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      return { value: workCalls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['missing.js'] } }] } : { text: 'negative test complete', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: '验证缺失文件必须失败', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(globalFor(runtime, agentId).taskOutcome, JSON.stringify(globalFor(runtime, agentId))).toMatchObject({ status: 'accepted' })
    expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBe(0)
  })

  it('does not accept a stage when an unknown ref is cited alongside valid tool evidence', async () => {
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 16 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { code: 0, stdout: 'pass 1\nfail 0' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'task-1', goal: '运行 node --test', check: 'node --test 退出码为 0', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.key?.startsWith('verify-stage')) {
        const refs = [...runtime.state.results.values()].filter((result) => result.producer?.kind === 'effect' && runtime.state.effects.get(result.producer.id)?.kind === 'tool').map((result) => result.id)
        return { value: { status: 'passed', evidenceRefs: [...refs, 'result-missing'], note: '测试已通过' } }
      }
      return { value: ++workCalls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--test'] } }] } : { text: 'done', finishReason: 'stop' } }
    } })
    const { agentId } = runtime.createAgent({ goal: '运行 node --test', program, initialGlobal: initialGlobal(1) })
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
    expect(globalFor(runtime, agentId).taskController.tasks[0].status).toBe('blocked')
  })

  it('requires tool evidence for files and commands, not for versions or abbreviations', () => {
    expect(stageRequiresToolEvidence('创建 src/greet.js', 'node --test 通过')).toBe(true)
    expect(stageRequiresToolEvidence('运行测试', 'pytest 必须通过')).toBe(true)
    expect(stageRequiresToolEvidence('检查构建', 'cargo test')).toBe(true)
    expect(stageRequiresToolEvidence('运行检查', 'go test ./...')).toBe(true)
    expect(stageRequiresToolEvidence('说明 1.2 节的设计', '概括 e.g. 架构取舍')).toBe(false)
    expect(stageRequiresToolEvidence('Write a commit message from the supplied changes', 'Return a title and concise bullets')).toBe(false)
  })

  it('does not pass a file stage from candidate text alone', async () => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.write'], approvalMode: 'auto', maxTurns: 12 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { path: 'src/greet.js' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'task-1', goal: '创建 src/greet.js', check: 'node --test 通过', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      if (effect.key?.startsWith('verify-stage')) {
        const state = globalFor(runtime, [...runtime.state.agents.keys()][0]!).taskController
        const active = state.tasks.find((item: { id: string }) => item.id === state.activeId)
        return { value: { status: 'passed', evidenceRefs: active?.candidateRef ? [active.candidateRef] : [], note: '文件已写好' } }
      }
      return { value: { text: '已写入 src/greet.js', finishReason: 'stop', toolCalls: [] } }
    } })
    const { agentId } = runtime.createAgent({ goal: '创建 src/greet.js', program, initialGlobal: initialGlobal(1) })
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(globalFor(runtime, agentId).taskController.tasks[0].status).toBe('blocked')
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
  })

  it('repairs one malformed stage verification instead of blocking completed work', async () => {
    let verify = 0
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.write'], approvalMode: 'auto', maxTurns: 16 })
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { path: 'src/greet.js', bytes: 10, hash: 'a'.repeat(64) } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.key?.startsWith('verify-stage')) {
        verify++
        if (verify === 1) return { value: '' }
        const refs = [...runtime.state.results.values()].filter((result) => result.producer?.kind === 'effect' && runtime.state.effects.get(result.producer.id)?.kind === 'tool').map((result) => result.id)
        return { value: { status: 'passed', evidenceRefs: refs, note: '文件已写入' } }
      }
      return { value: ++workCalls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'src/greet.js', content: 'ok' } }] } : { text: 'wrote greet.js', finishReason: 'stop' } }
    } })
    const { agentId } = runtime.createAgent({ goal: '创建 src/greet.js', program, initialGlobal: initialGlobal(1) })
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('accepted')
    expect(verify).toBe(2)
  })

  it('continues independent stages after a blocked stage and skips its dependent stage', async () => {
    const executed: string[] = []
    const stageByLane = new Map<string, string>()
    const callsByLane = new Map<string, number>()
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { executed.push(stageByLane.get(effect.ownerLaneId) ?? 'unknown'); return { value: { content: 'evidence' } } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1'), task('task-2', ['task-1']), task('task-3')] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.key?.startsWith('verify-stage')) return { value: { status: state.activeId === 'task-1' ? 'blocked' : 'passed', evidenceRefs: state.tasks.find((item: any) => item.id === state.activeId).evidenceRefs, note: state.activeId === 'task-1' ? 'Requires permission' : 'Verified' } }
      if (effect.key?.startsWith('work-stage-worker')) {
        const lane = runtime.state.lanes.get(effect.ownerLaneId)
        const taskId = String(lane?.goal.match(/task-\d+/)?.[0] ?? '')
        stageByLane.set(effect.ownerLaneId, taskId)
        const calls = (callsByLane.get(effect.ownerLaneId) ?? 0) + 1
        callsByLane.set(effect.ownerLaneId, calls)
        return { value: calls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } : { text: 'stage done', finishReason: 'stop' } }
      }
      return { value: { text: 'stage done', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Implement all tasks', program, initialGlobal: initialGlobal(3) }).agentId
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(executed).toEqual(['task-1', 'task-3'])
    const controller = globalFor(runtime, agentId).taskController
    expect(controller.tasks.map((item: any) => item.status)).toEqual(['blocked', 'blocked', 'passed'])
    expect(controller.tasks[1].note).toBe('Requires permission')
    const agent = runtime.state.agents.get(agentId)!
    const report = JSON.stringify(runtime.state.results.get(runtime.state.lanes.get(agent.rootLaneId)!.resultRef!)?.value)
    expect(report).not.toContain('Required dependency is blocked')
    expect(report).toContain('Requires permission')
    expect(report).toContain('These later stages did not start')
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
  })

  it('stops a stage that keeps requesting tools at the stage loop instead of the run-wide call count', async () => {
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 5 })
    let calls = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { changing: calls } }
      calls++
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      if (effect.key?.startsWith('verify')) return { value: { status: 'blocked', evidenceRefs: [], note: 'permission denied' } }
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: {} }] } }
    } })
    const { agentId } = runtime.createAgent({ goal: 'work', program, initialGlobal: initialGlobal(1) })
    const outcome = await runtime.start(agentId).outcome()
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome))
    expect(outcome).toMatchObject({ status: 'succeeded' })
    expect(calls).toBeGreaterThan(5)
    expect(calls).toBeLessThanOrEqual(12)
    const controller = globalFor(runtime, agentId).taskController
    expect(controller.usedTurns).toBeGreaterThan(controller.maxTurns)
    expect(controller.tasks.map((item: { note?: string }) => item.note ?? '').join('\n')).not.toContain('Total model budget exhausted')
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
  })

  it('keeps the shared model-call ceiling for a restored v7 controller', async () => {
    const program = buildTaskControllerProgram({ system: 'test', version: '7', toolNames: ['read'], approvalMode: 'auto', maxTurns: 5 })
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

  it('requests one structured progress review after four read-only rounds without requiring repeated file names', async () => {
    let workCalls = 0
    let reads = 0
    let progressReviews = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { reads++; return { value: { file: `file-${reads}`, content: 'evidence' } } }
      const key = effect.key ?? ''
      if (key.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      const state = globalFor(runtime, agentId).taskController
      if (key.startsWith('progress-review')) {
        progressReviews++
        const results = ((effect.input as any)?.inputs?.results ?? []) as string[]
        expect(results).toHaveLength(4)
        return { value: { status: 'ready', evidenceRefs: results, note: 'Evidence is sufficient.' } }
      }
      if (key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs, note: 'Verified evidence.' } }
      if (key.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: `file-${workCalls}` } }] } }
    } })
    agentId = runtime.createAgent({ goal: 'Inspect the relevant files and explain the issue', program, initialGlobal: initialGlobal(1) }).agentId
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome.status).toBe('succeeded')
    expect(reads).toBe(4)
    expect(progressReviews).toBe(1)
    expect(globalFor(runtime, agentId).taskController.tasks[0].investigationRounds).toBe(4)
  })

  it('bounds repeated read-only git shell inspections too', async () => {
    let reads = 0
    let progressReviews = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { reads++; return { value: { code: 0, stdout: 'working tree', stderr: '', truncated: false, timedOut: false, aborted: false } } }
      const key = effect.key ?? ''
      if (key.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      const active = globalFor(runtime, agentId).taskController.tasks[0]
      if (key.startsWith('progress-review')) {
        progressReviews++
        expect(active.investigationRounds).toBe(4)
        return { value: { status: 'ready', evidenceRefs: active.evidenceRefs, note: 'The current diff evidence is sufficient.' } }
      }
      if (key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: active.evidenceRefs, note: 'Verified.' } }
      if (key.startsWith('verify-task')) return finalReview(runtime)
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'git', args: ['status', '--short'] } }] } }
    } })
    agentId = runtime.createAgent({ goal: 'Inspect the git changes and summarize them', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(reads).toBe(4)
    expect(progressReviews).toBe(1)
  })

  it('keeps moving with a bounded read allowance when the progress review output is invalid', async () => {
    let reads = 0
    let workCalls = 0
    let progressReviews = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') { reads++; return { value: { content: `evidence-${reads}` } } }
      const key = effect.key ?? ''
      if (key.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      const active = globalFor(runtime, agentId).taskController.tasks[0]
      if (key.startsWith('progress-review')) { progressReviews++; return { value: { status: 'not-a-status', evidenceRefs: [], note: '' } } }
      if (key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: active.evidenceRefs, note: 'Evidence verified.' } }
      if (key.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      if (workCalls <= 6) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: `file-${workCalls}` } }] } }
      return { value: { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Inspect and resolve the issue', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(progressReviews).toBe(2) // One structured correction retry, then bounded fallback.
    expect(reads).toBe(5)
    expect(workCalls).toBe(5)
    const state = globalFor(runtime, agentId).taskController.tasks[0]
    expect(state.progressReviewed).toBe(true)
    expect(state.directedInvestigations).toBeLessThanOrEqual(2)
  })

  it('asks for another edit after a rejected patch instead of rereading the file', async () => {
    let reads = 0
    let patches = 0
    let workCalls = 0
    let stageReviews = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read', 'fs.apply_patch'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        const name = (effect.input as { name?: string }).name
        if (name === 'read') reads++
        if (name === 'fs.apply_patch') patches++
        return { value: { path: 'apps/server/src/runtime.ts', hash: 'a'.repeat(64) } }
      }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'task-1', goal: '修改 apps/server/src/runtime.ts', check: 'autoReviewCandidates 不写入', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        stageReviews++
        const refs = state.tasks[0].evidenceRefs
        return { value: stageReviews === 1 ? { status: 'needs_work', evidenceRefs: refs, note: 'The early return left the old loop in place.' } : { status: 'passed', evidenceRefs: refs, note: 'Edited.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      if (workCalls === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'apps/server/src/runtime.ts' } }] } }
      if (workCalls === 2) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.apply_patch', input: { path: 'apps/server/src/runtime.ts', find: 'return', replace: 'return' } }] } }
      if (workCalls === 3) return { value: { text: 'stage report', finishReason: 'stop' } }
      if (workCalls === 4) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'apps/server/src/runtime.ts' } }] } }
      if (workCalls === 5) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.apply_patch', input: { path: 'apps/server/src/runtime.ts', find: 'loop', replace: '' } }] } }
      return { value: { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Fix automatic approval', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(reads).toBe(1)
    expect(patches).toBe(2)
    expect(stageReviews).toBe(2)
  })

  it('turns a needs-work review into the next concrete stage action', async () => {
    let workCalls = 0
    let stageReviews = 0
    let retryConversation: any[] = []
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 16 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { content: 'source evidence' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        stageReviews++
        const refs = state.tasks[0].evidenceRefs
        return { value: stageReviews === 1 ? { status: 'needs_work', evidenceRefs: refs, note: 'Add a /copy command that copies the latest complete response.' } : { status: 'blocked', evidenceRefs: refs, note: 'The bounded retry did not complete the correction.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      if (workCalls === 3) retryConversation = (effect.input as any).inputs.conversation
      return { value: workCalls === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'source.ts' } }] } : { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Implement and verify the copy feature', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(workCalls).toBeGreaterThanOrEqual(3)
    expect(stageReviews).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(retryConversation)).toContain('NEXT: Implement the missing deliverable for this stage')
    expect(JSON.stringify(retryConversation)).toContain('Verifier finding: Add a /copy command')
    expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBeGreaterThan(0)
  })

  it('retries an achievable stage correction while turn budget remains', async () => {
    let stageReviews = 0
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 16 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { content: 'source evidence' } }
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task('task-1')] } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        stageReviews++
        const refs = state.tasks[0].evidenceRefs
        return { value: stageReviews < 3 ? { status: 'needs_work', evidenceRefs: refs, note: 'Read the status field before finishing.' } : { status: 'passed', evidenceRefs: refs, note: 'Status field is recorded.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      if (workCalls % 2 === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: `source-${workCalls}.ts` } }] } }
      return { value: { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Find the approval status field', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(stageReviews).toBe(3)
    expect(globalFor(runtime, agentId).taskController.tasks[0].status).toBe('passed')
  })

  it('replans a different approach when a tool failure leaves the goal unmet', async () => {
    let plans = 0
    let workCalls = 0
    let reusedPriorEvidence = false
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { content: 'memory status field' } }
      if (effect.key?.startsWith('plan')) {
        plans++
        const recovered = plans > 1
        return { value: { tasks: [{ id: 'task-1', goal: recovered ? 'Read the candidate type from packages/memory' : 'Search with an invalid fs.search pattern', check: 'Record the status field', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        const refs = state.tasks[0].evidenceRefs
        const failed = state.tasks[0].goal.includes('invalid')
        return { value: failed ? { status: 'blocked', evidenceRefs: refs, note: 'fs.search failed: INVALID_TOOL_INPUT pattern is not query.' } : { status: 'passed', evidenceRefs: refs, note: 'Status field recorded.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      if (effect.kind === 'llm' && plans > 1) {
        const supplied = ((effect.input as { inputs?: { results?: string[] } }).inputs?.results ?? [])
        const prior = globalFor(runtime, agentId).taskController.priorTasks.flatMap((task: { evidenceRefs?: string[] }) => task.evidenceRefs ?? [])
        if (prior.some((ref: string) => supplied.includes(ref))) reusedPriorEvidence = true
      }
      workCalls++
      return { value: workCalls % 2 === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'packages/memory/src/index.ts' } }] } : { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Add automatic approval', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(plans).toBe(2)
    expect(reusedPriorEvidence).toBe(true)
    expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBe(1)
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('accepted')
    expect(globalFor(runtime, agentId).taskController.updates[0]).toContain('fs.search failed')
  })

  it('does not replan when the unmet goal is an external permission block', async () => {
    let plans = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 16 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { content: 'evidence' } }
      if (effect.key?.startsWith('plan')) { plans++; return { value: { tasks: [task('task-1')] } } }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) return { value: { status: 'blocked', evidenceRefs: state.tasks[0].evidenceRefs, note: 'Requires permission' } }
      return { value: { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Implement task', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(plans).toBe(1)
    expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBe(0)
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('incomplete')
  })

  it('replans when the unmet step is a local Ollama path', async () => {
    let plans = 0
    let workCalls = 0
    const program = buildTaskControllerProgram({ system: 'test', toolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
    let agentId = ''
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { content: 'ollama review' } }
      if (effect.key?.startsWith('plan')) {
        plans++
        return { value: { tasks: [{ id: 'task-1', goal: plans > 1 ? 'Apply the review through local Ollama' : 'Locate the approval entry', check: 'Candidates are reviewed', dependsOn: [], criterionIds: ['criterion-1'] }] } }
      }
      const state = globalFor(runtime, agentId).taskController
      if (effect.key?.startsWith('verify-stage')) {
        const refs = state.tasks[0].evidenceRefs
        const locatedOnly = state.tasks[0].goal.includes('Locate')
        return { value: locatedOnly ? { status: 'blocked', evidenceRefs: refs, note: '外部接口不可用，自动审批应走本机 Ollama。' } : { status: 'passed', evidenceRefs: refs, note: 'Reviewed through local Ollama.' } }
      }
      if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
      workCalls++
      return { value: workCalls % 2 === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'runtime.ts' } }] } : { text: 'stage report', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Add automatic approval', program, initialGlobal: initialGlobal(1) }).agentId
    expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
    expect(plans).toBe(2)
    expect(globalFor(runtime, agentId).taskController.goalRecoveries).toBe(1)
    expect(globalFor(runtime, agentId).taskOutcome.status).toBe('accepted')
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
  it('finishes already-dispatched independent writes after steering, then replans within the same budget', async () => {
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
    expect(executed).toEqual(['write', 'write', 'read'])
    const state = globalFor(runtime, agentId).taskController
    expect(state.revision).toBe(2)
    expect(state.priorTasks[0].evidenceRefs).toHaveLength(2)
    expect(state.usedTurns).toBeGreaterThan(4)
    const restored = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program] })
    expect(globalFor(restored, agentId).taskController).toEqual(state)
  })

  it('cancels every write already dispatched in the current independent batch', async () => {
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
    expect(writes).toBe(2)
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
