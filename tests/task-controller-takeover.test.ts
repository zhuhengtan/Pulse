import { expect, it } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

const globalFor = (runtime: PulseRuntime, id: string): any => {
  const agent = runtime.state.agents.get(id)!
  return agent.globalVersions.get(agent.latestGlobalVersion)
}
const record = (objective: string): JsonValue => ({ taskRecord: { schemaVersion: 1, runId: 'fixture', objective, acceptanceCriteria: [{ id: 'criterion-1', description: objective }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } })

it('supplies the current request explicitly even when a continuation retains an older objective', async () => {
  const current = 'Finish candidate workspace checks; authentication is already complete.'
  let plannedRequest = ''
  const program = buildTaskControllerProgram({ system: 'fixture', toolNames: [], conversation: [{ role: 'user', content: 'Old authentication task' }], approvalMode: 'auto', maxTurns: 24 })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.key?.startsWith('plan')) {
      plannedRequest = JSON.stringify((effect.input as any).inputs.conversation)
      return { value: { tasks: [{ id: 'stage', kind: 'analyze', goal: 'Explain candidate verification', check: 'Explanation delivered', criterionIds: ['criterion-1'], dependsOn: [] }] } }
    }
    return { value: { text: 'fixture', finishReason: 'stop' } }
  } })
  const { agentId } = runtime.createAgent({ goal: current, program, initialGlobal: record('Old authentication task') })
  await runtime.start(agentId).outcome()
  const messages = JSON.parse(plannedRequest)
  const contract = messages.flatMap((message: { content: string }) => { try { return [JSON.parse(message.content)] } catch { return [] } })
  expect(contract).toContainEqual(expect.objectContaining({ currentRequest: current }))
})

it('replanning the same stage ID starts a fresh stage turn counter and retains total usage and settled reads', async () => {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let agentId = '', plans = 0, reads = 0
  const turns: Array<{ revision: number; turn: number }> = []
  const program = buildTaskControllerProgram({ system: 'fixture', toolNames: ['fs.read'], readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 40 })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') {
      if (++reads === 2) { entered(); await gate }
      return { value: { path: `page-${reads}.txt`, content: `evidence-${reads}`, hash: `hash-${reads}` } }
    }
    const state = globalFor(runtime, agentId).taskController
    if (effect.key?.startsWith('plan')) {
      plans++
      return { value: { tasks: [{ id: 'same-id', kind: 'verify', goal: 'Read the current fixture state', check: 'Current state read', criterionIds: globalFor(runtime, agentId).taskRecord.acceptanceCriteria.map((c: any) => c.id), dependsOn: [] }] } }
    }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs, note: 'Current reads verified' } }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: globalFor(runtime, agentId).taskRecord.acceptanceCriteria.map((c: any) => ({ criterionId: c.id, status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs, rationale: 'Read current fixture' })) } }
    turns.push({ revision: state.revision, turn: (effect.input as any).turn })
    return { value: plans === 1 || turns.filter(t => t.revision === 2).length === 1
      ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `page-${reads + 1}.txt` } }] }
      : { text: 'Current state read.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Read fixture state', program, initialGlobal: record('Read fixture state') }).agentId
  const session = runtime.start(agentId)
  const outcome = session.outcome()
  await waiting
  await session.submitHumanInput('steer', { command: 'steer', text: 'Read the remaining fixture state.' })
  runtime.tick(); release()
  expect((await outcome).status).toBe('succeeded')
  const final = globalFor(runtime, agentId)
  expect(turns.filter(t => t.revision === 1).map(t => t.turn)).toEqual([1, 2])
  expect(turns.find(t => t.revision === 2)?.turn).toBe(1)
  expect(final.taskController.usedTurns).toBeGreaterThan(4)
  expect(final.taskController.priorTasks[0].evidenceRefs).toHaveLength(2)
  expect(final.taskOutcome.status).toBe('accepted')
})
