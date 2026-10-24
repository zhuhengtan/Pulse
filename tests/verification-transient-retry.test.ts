import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it.each([
  ['stage', 'recover'], ['final', 'recover'], ['source', 'recover'],
  ['stage', 'repeat'], ['final', 'repeat'], ['source', 'repeat'],
  ['stage', 'legacy'], ['stage', 'budget'], ['stage', 'auth'],
  ['stage', 'stale'], ['stage', 'denied'], ['stage', 'shape-network'],
] as const)('retries only transient verification without replaying work: %s %s', async (phase, mode) => {
  let agentId = '', workTurns = 0, fetches = 0, attempts = 0
  const prefix = phase === 'stage' ? 'verify-stage' : phase === 'final' ? 'verify-task' : 'verify-sources'
  const program = buildTaskControllerProgram({ version: mode === 'legacy' ? '33' : '34', system: 'test', toolNames: ['web.fetch'], approvalMode: 'auto', maxTurns: 64,
    modelBudgetView: () => ({ limit: 64, used: 8 + attempts, workAllowed: true, verificationAllowed: mode !== 'budget' || attempts === 0, finalAllowed: mode !== 'budget' || attempts === 0 }) })
  const refs = () => [...runtime.state.results.values()].filter(r => r.producer?.kind === 'effect' && runtime.state.effects.get(r.producer.id)?.kind === 'tool').map(r => r.id)
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') { fetches++; return { value: { url: 'https://source.example/page', fetchedAt: '2026-10-23T00:00:00Z', text: 'Actual official page.' } } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'research', kind: 'analyze', goal: 'Read the official page and summarize', check: 'Actual source evidence and answer', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    if (effect.key?.startsWith(prefix)) {
      attempts++
      if (mode === 'shape-network' && attempts === 1) return { value: { malformed: true } }
      if (mode !== 'recover' && mode !== 'shape-network' || attempts === 1 || mode === 'shape-network' && attempts === 2) {
        const code = mode === 'auth' ? 'PROVIDER_HTTP_401' : mode === 'stale' ? 'EVIDENCE_CHANGED' : mode === 'denied' ? 'APPROVAL_DENIED' : phase === 'final' ? 'PROVIDER_HTTP_503' : phase === 'source' ? 'PROVIDER_HTTP_429' : 'PROVIDER_NETWORK_ERROR'
        return { value: null, status: 'failed', executionState: 'failed', error: { code, message: code, retryable: mode !== 'auth' } }
      }
    }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs(), note: 'Actual page read' } }
    if (effect.key?.startsWith('verify-task') || effect.key?.startsWith('verify-sources')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs(), rationale: 'Actual source supports the response' }], findings: [] } }
    workTurns++
    return { value: workTurns === 1 ? { text: '', toolCalls: [{ name: 'web.fetch', input: { url: 'https://source.example/page' }, toolCallId: 'fetch-once' }], finishReason: 'tool_calls' } : { text: 'The official page was read.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Read the official page and summarize', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'retry-test', objective: 'Read the official page and summarize', acceptanceCriteria: [{ id: 'criterion-1', description: 'Source-based response' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  const agent = runtime.state.agents.get(agentId)!, state = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(fetches).toBe(1)
  expect(workTurns).toBe(2)
  expect(attempts).toBe(mode === 'repeat' || mode === 'shape-network' ? 3 : mode === 'recover' ? 2 : 1)
  expect(state.taskOutcome.status).toBe(mode === 'recover' || mode === 'shape-network' ? 'accepted' : 'incomplete')
  if (mode === 'repeat') expect(Object.values(state.taskController.verificationRetries)).toEqual([2])
  if (mode === 'legacy') expect(state.taskController.verificationRetries).toBeUndefined()
})
