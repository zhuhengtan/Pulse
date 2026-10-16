import { describe, it, expect } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

const global = (runtime: PulseRuntime, id: string): any => { const a = runtime.state.agents.get(id)!; return a.globalVersions.get(a.latestGlobalVersion) }
describe('required-check enforcement against a mistaken verifier', () => {
  it.each(['normal', 'omit-failure', 'invent-negative-stage', 'other-criterion-negative', 'negative', 'environment-denial', 'timeout', 'null-exit', 'successful-rerun', 'zero'])('keeps immutable criteria and actual exit evidence (%s)', async mode => {
    const legitimateNegative = ['negative', 'environment-denial', 'timeout', 'null-exit'].includes(mode)
    let agentId = '', work = 0, checks = 0
    const program = buildTaskControllerProgram({ system: 'offline', toolNames: ['shell.exec'], maxTurns: 32, approvalMode: 'auto' })
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'tool') { checks++; return { value: { code: mode === 'null-exit' ? null : mode === 'zero' || mode === 'successful-rerun' && checks === 2 ? 0 : 1, stdout: 'actual fixture output', stderr: mode === 'environment-denial' ? 'EPERM: sandbox denied' : '', timedOut: mode === 'timeout', aborted: false } } }
      if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: 's', goal: legitimateNegative || ['invent-negative-stage', 'other-criterion-negative'].includes(mode) ? 'Run negative test' : 'Run regression tests', check: legitimateNegative || ['invent-negative-stage', 'other-criterion-negative'].includes(mode) ? 'Expected nonzero exit' : 'Post-fix regression must exit code 0', criterionIds: ['c'], dependsOn: [] }] } }
      const task = global(runtime, agentId).taskController.tasks[0]
      if (effect.key.startsWith('verify-stage')) {
        const refs = mode === 'successful-rerun' ? task.evidenceRefs.slice(-1) : task.evidenceRefs
        return { value: { status: 'passed', evidenceRefs: mode === 'omit-failure' ? [task.candidateRef] : refs, expectedFailureRefs: mode === 'omit-failure' || mode === 'successful-rerun' || mode === 'zero' ? [] : refs, note: 'Model claims passed.' } }
      }
      if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: task.evidenceRefs, rationale: 'Claimed passed' }] } }
      work++
      return { value: work <= (mode === 'successful-rerun' ? 2 : 1) ? { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['tests/check.mjs'] } }] } : { text: 'completed', finishReason: 'stop' } }
    } })
    agentId = runtime.createAgent({ goal: 'Follow the immutable contract', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'offline', objective: legitimateNegative || mode === 'other-criterion-negative' ? 'Verify CLI negative test, then make post-fix regression pass' : 'Make regression pass', acceptanceCriteria: [{ id: 'c', description: legitimateNegative ? 'CLI negative test must fail with expected nonzero exit' : 'Post-fix tests must exit zero' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    expect(global(runtime, agentId).taskOutcome.status).toBe(['negative', 'successful-rerun', 'zero'].includes(mode) ? 'accepted' : 'incomplete')
    expect(global(runtime, agentId).taskController.goalRecoveries).toBe(0)
  })
})
