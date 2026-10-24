import { describe, expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
// Import the compiled lane program, not the sources under repair. This file must
// fail if the shipped gate reverts to classifying the display string
// meta.toolCommand (command plus args) instead of the structured
// { command, args } recorded in meta.toolArguments, and it must also fail if a
// real runner failure stops blocking a stage.
import { buildTaskControllerProgram } from '../packages/server/dist/task-controller/program.js'

type ToolResult = { code: number; stdout: string; stderr: string }
type Execution = { command: string; args: string[]; result: ToolResult }

const initialGlobal = (count: number): JsonValue => ({
  taskRecord: {
    schemaVersion: 1,
    runId: 'check-gate',
    objective: 'Verify the required-check gate',
    acceptanceCriteria: Array.from({ length: count }, (_, index) => ({ id: `criterion-${index + 1}`, description: `Requirement ${index + 1}` })),
    status: 'in_progress',
    replanCount: 0,
    attempts: [],
    evidenceRefs: [],
    excludedRefs: [],
  },
})

function globalFor(runtime: PulseRuntime, agentId: string): any {
  const agent = runtime.state.agents.get(agentId)!
  return agent.globalVersions.get(agent.latestGlobalVersion)
}

function finalReview(runtime: PulseRuntime): { value: JsonValue } {
  const agent = [...runtime.state.agents.values()][0]!
  const global = globalFor(runtime, agent.id)
  return {
    value: {
      criteria: global.taskRecord.acceptanceCriteria.map((criterion: any) => ({
        criterionId: criterion.id,
        status: 'passed',
        evidenceRefs: global.taskController.tasks.flatMap((task: any) => task.evidenceRefs),
        rationale: 'Verified the recorded evidence',
      })),
    },
  }
}

/**
 * Drives one real task-controller run through the compiled lane program with an
 * in-memory Runtime: no session database, no network, and the fake model only
 * replays the supplied shell.exec invocations. The executor answers each tool
 * call with the supplied receipt body, so the stage gate classifies exactly the
 * receipts a real run would have recorded (display string in meta.toolCommand,
 * structured arguments in meta.toolArguments).
 */
async function runGate(executions: Execution[]) {
  let runtime: PulseRuntime
  let agentId = ''
  let modelTurns = 0
  let stageReviews = 0
  const invoked: string[] = []
  const program = buildTaskControllerProgram({ version: '13', system: 'test', toolNames: ['shell.exec'], approvalMode: 'auto', maxTurns: 24 })
  runtime = new PulseRuntime({ effectExecutor: async (effect) => {
    if (effect.kind === 'tool') {
      const call = (effect.input as any)?.arguments ?? {}
      const command = String(call.command ?? '')
      const args = Array.isArray(call.args) ? call.args.map((arg: unknown) => String(arg)) : []
      invoked.push([command, ...args].join(' '))
      const next = executions[invoked.length - 1]
      return { value: next ? next.result : { code: 0, stdout: 'noop', stderr: '' } }
    }
    if (effect.key?.startsWith('plan')) {
      // Inventory-style goal/check so the stage gate asks for tool evidence
      // rather than a file edit; the receipts below are the only evidence.
      return { value: { tasks: [{ id: 'task-1', goal: 'Inspect current workspace state', check: 'Read enough evidence to report state', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    }
    if (effect.key?.startsWith('progress-review')) {
      const state = globalFor(runtime, agentId).taskController
      const active = state.tasks.find((task: any) => task.id === state.activeId) ?? state.tasks[0]
      const supplied = (effect.input as any)?.inputs?.results
      const evidenceRefs = active?.evidenceRefs?.length ? active.evidenceRefs : Array.isArray(supplied) ? supplied : []
      return { value: { status: 'ready', evidenceRefs, note: 'Recorded observations are sufficient.' } }
    }
    if (effect.key?.startsWith('verify-stage')) {
      stageReviews++
      const state = globalFor(runtime, agentId).taskController
      const active = state.tasks.find((task: any) => task.id === state.activeId) ?? state.tasks[0]
      // Cite only receipts that exited zero. A failed observation stays context,
      // and whether it also blocks the stage is exactly what the gate under test
      // decides, so this verifier must not pre-filter that decision away.
      const recorded: string[] = active?.evidenceRefs ?? []
      const succeeded = recorded.filter((ref) => Number((runtime.state.results.get(ref)?.value as any)?.code ?? 0) === 0)
      const evidenceRefs = succeeded.length > 0 ? succeeded : active?.candidateRef ? [active.candidateRef] : []
      return { value: { status: 'passed', evidenceRefs, note: 'Recorded evidence reviewed.' } }
    }
    if (effect.key?.startsWith('verify-task')) return finalReview(runtime)
    const next = executions[modelTurns++]
    if (next) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: next.command, args: next.args } }] } }
    return { value: { text: 'Inspection finished', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Inspect the delivered test file', program, initialGlobal: initialGlobal(1) }).agentId
  const outcome = await runtime.start(agentId).outcome()
  return { runtime, agentId, outcome, invoked, stageReviews }
}

describe('task controller required-check gate', () => {
  it('does not turn failed reads of test paths into required checks', async () => {
    const run = await runGate([
      // Both receipts describe files under tests/, so the old joined-argv regex
      // treated the failing `ls` as a required check and never let the later
      // successful read supersede it (different command, different key).
      { command: 'ls', args: ['tests/'], result: { code: 2, stdout: '', stderr: 'ls: tests: No such file or directory' } },
      { command: 'cat', args: ['tests/cli-parse-inline-equals.test.ts'], result: { code: 0, stdout: 'it("inline equals", () => {})', stderr: '' } },
    ])
    expect(run.invoked.slice(0, 2)).toEqual(['ls tests/', 'cat tests/cli-parse-inline-equals.test.ts'])
    expect(run.stageReviews).toBeGreaterThan(0)
    expect(run.outcome.status).toBe('succeeded')
    const state = globalFor(run.runtime, run.agentId)
    expect(state.taskOutcome.status, JSON.stringify(state.taskController)).toBe('accepted')
  })

  it('keeps a real node --test failure blocking', async () => {
    const run = await runGate([
      // Real metadata shape: toolCommand is "node --test tests/foo.test.mjs"
      // and toolArguments carries { command: 'node', args: [...] }.
      { command: 'node', args: ['--test', 'tests/foo.test.mjs'], result: { code: 1, stdout: '', stderr: '1 failing' } },
    ])
    expect(run.invoked[0]).toBe('node --test tests/foo.test.mjs')
    expect(run.stageReviews).toBeGreaterThan(0)
    const state = globalFor(run.runtime, run.agentId)
    expect(state.taskOutcome.status, JSON.stringify(state.taskController)).not.toBe('accepted')
  })

  it('does not let a successful read excuse a failing runner', async () => {
    const run = await runGate([
      { command: 'node', args: ['--test', 'tests/foo.test.mjs'], result: { code: 1, stdout: '', stderr: '1 failing' } },
      { command: 'cat', args: ['tests/foo.test.mjs'], result: { code: 0, stdout: 'ok', stderr: '' } },
    ])
    expect(run.invoked[0]).toBe('node --test tests/foo.test.mjs')
    const state = globalFor(run.runtime, run.agentId)
    expect(state.taskOutcome.status, JSON.stringify(state.taskController)).not.toBe('accepted')
  })
})
