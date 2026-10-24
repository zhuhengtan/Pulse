import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it.each([
  { version: '41', requiredTest: false, correct: true, accepted: false, reviews: 1 },
  { version: '42', requiredTest: false, correct: true, accepted: true, reviews: 2 },
  { version: '42', requiredTest: false, correct: false, accepted: false, reviews: 2 },
  { version: '42', requiredTest: true, correct: true, accepted: false, reviews: 1 },
] as const)('repairs failed ancillary citations without accepting required failures (%j)', async scenario => {
  let runtime: PulseRuntime, agentId = '', work = 0, reviews = 0
  const executed: string[] = []
  const global = () => { const a = runtime.state.agents.get(agentId)!; return a.globalVersions.get(a.latestGlobalVersion) as any }
  const program = buildTaskControllerProgram({ version: scenario.version, system: 'test', toolNames: ['web.fetch', 'shell.exec', 'fs.list'], readOnlyToolNames: ['web.fetch', 'fs.list'], approvalMode: 'auto', maxTurns: 24 })
  runtime = new PulseRuntime({ effectExecutor: async effect => {
    const input: any = effect.input
    if (effect.kind === 'tool') {
      executed.push(input.name)
      if (input.name === 'fs.list') throw Object.assign(new Error('missing optional cache directory'), { code: 'ENOENT', retryable: false })
      return { value: input.name === 'web.fetch' ? { url: 'https://docs.example.org/', text: 'Official source content.' } : { code: scenario.requiredTest ? 1 : 56, stdout: '', stderr: 'command failed', timedOut: false, aborted: false } }
    }
    if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: 'retrieve', kind: 'analyze', goal: scenario.requiredTest ? 'Run required verification tests' : 'Retrieve documentation content', check: scenario.requiredTest ? 'node --test test/check.test.mjs must pass' : 'Official source content retrieved', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    const stage = global().taskController.tasks[0]
    const successfulSources = [...runtime.state.results.values()].filter(result => result.producer?.kind === 'effect' && (runtime.state.effects.get(result.producer.id)?.input as any)?.name === 'web.fetch').map(result => result.id)
    if (effect.key.startsWith('verify-stage')) {
      reviews++
      if (reviews > 1) expect(input.inputs.citationCorrection).toContain('not success proof')
      return { value: { status: 'passed', evidenceRefs: reviews > 1 && scenario.correct ? successfulSources : stage.evidenceRefs, note: 'Source retrieved; failed observations are context only.' } }
    }
    if (effect.key.startsWith('verify-task') || effect.key.startsWith('verify-sources')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: successfulSources, rationale: 'Actual successful source receipt.' }], findings: [] } }
    work++
    if (work === 1) return { value: { finishReason: 'tool_calls', toolCalls: [
      { name: 'web.fetch', input: { url: 'https://docs.example.org/' } },
      { name: 'shell.exec', input: { command: scenario.requiredTest ? 'node' : 'curl', args: scenario.requiredTest ? ['--test', 'test/check.test.mjs'] : ['https://docs.example.org/', '-o', 'cache.html'] } },
      { name: 'fs.list', input: { path: 'cache' } },
    ] } }
    return { value: { text: 'Documentation retrieved from the successful source receipt.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Retrieve documentation content', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'test', objective: scenario.requiredTest ? 'Run required verification tests successfully' : 'Retrieve documentation content', acceptanceCriteria: [{ id: 'criterion-1', description: scenario.requiredTest ? 'Required tests pass' : 'Official content retrieved' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  expect(global().taskOutcome.status).toBe(scenario.accepted ? 'accepted' : 'incomplete')
  expect(reviews).toBe(scenario.reviews)
  expect(executed.sort()).toEqual(['fs.list', 'shell.exec', 'web.fetch'])
  const failedListing = [...runtime.state.effects.values()].find(effect => effect.kind === 'tool' && (effect.input as any).name === 'fs.list')
  expect(failedListing?.outcome?.status).toBe('failed')
})
