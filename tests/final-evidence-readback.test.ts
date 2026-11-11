import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it.each(['recover', 'repeated', 'legacy', 'refusal', 'budget'] as const)('bounds missing local verification evidence without redoing work: %s', async mode => {
  let writes = 0, reads = 0, globs = 0, finals = 0, work = 0, plans = 0, agentId = ''
  const goal = 'Implement src/retry.js with the documented defaults. Do not add dependencies.'
  const program = buildTaskControllerProgram({ version: '56', ...(mode === 'legacy' ? {} : { executionEfficiencyVersion: 1 }), reviewExecution: true,
    system: 'fixture', toolNames: ['fs.write', 'fs.read', 'fs.glob'], readOnlyToolNames: ['fs.read', 'fs.glob'], approvalMode: 'auto', maxTurns: 32,
    modelBudgetView: () => ({ limit: 32, used: 6, workAllowed: mode !== 'budget' || finals === 0, verificationAllowed: true, finalAllowed: true }) })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    const input = effect.input as any
    if (effect.kind === 'tool') {
      if (input.name === 'fs.write') { writes++; return { value: { path: 'src/retry.js', hash: 'v1', bytes: 40 } } }
      if (input.name === 'fs.read') { reads++; expect(input.arguments.path).toBe('src/retry.js'); return { value: { path: 'src/retry.js', hash: 'v1', offset: 0, nextOffset: null, truncated: false, content: 'export const retry = (maxAttempts = 3) => maxAttempts' } } }
      if (input.name === 'fs.glob') { globs++; expect(input.arguments).toMatchObject({ path: '.', pattern: 'package*.json' }); return { value: { matches: [], total: 0, truncated: false } } }
      throw new Error('UNEXPECTED_TOOL')
    }
    if (effect.key.startsWith('plan')) { plans++; return { value: { tasks: [{ id: 'code', kind: 'edit', goal: 'Create src/retry.js', check: 'File saved', criterionIds: ['c'], dependsOn: [] }] } } }
    const refs = input.inputs?.results ?? []
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Code saved' } }
    if (effect.key.startsWith('verify-task')) {
      finals++
      return { value: { criteria: [{ criterionId: 'c', status: mode === 'recover' && reads && globs ? 'passed' : 'unverifiable', evidenceRefs: refs,
        rationale: mode === 'refusal' ? 'APPROVAL_DENIED: permission required' : 'Missing source readback for defaults and dependency manifest inspection.' }] } }
    }
    work++
    return { value: work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'src/retry.js', content: 'code' } }] } : { text: 'Code saved', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal, program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'readback', objective: goal, acceptanceCriteria: [{ id: 'c', description: goal }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  try {
    await runtime.start(agentId).outcome()
    const agent = runtime.state.agents.get(agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
    const collects = mode === 'recover' || mode === 'repeated'
    expect(reads).toBe(collects ? 1 : 0); expect(globs).toBe(collects ? 1 : 0)
    // Recovery may choose another verification method, but never redo delivery.
    expect(writes).toBe(1); expect(plans).toBeGreaterThanOrEqual(1); expect(plans).toBeLessThanOrEqual(9)
    expect(finals).toBeGreaterThanOrEqual(collects ? 2 : 1); expect(finals).toBeLessThanOrEqual(18)
    expect(global.taskOutcome.status).toBe(mode === 'recover' ? 'accepted' : 'incomplete')
    if (collects) expect(global.taskController.finalEvidenceReadbackAttempted).toBe(true)
  } finally { await runtime.shutdown() }
})
