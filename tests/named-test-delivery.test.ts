import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { namedTestExtensions, missingNamedTestExtensions } from '../packages/server/src/task-controller/named-test-delivery.js'

it.each([
  ['补充并通过 test/bookmarks.test.mjs 自动化测试，确保 node --test 全部通过。', ['test/bookmarks.test.mjs']],
  ['Extend tests/api.test.ts with regression tests.', ['tests/api.test.ts']],
  ['在 test/api.test.mjs 中新增测试。', ['test/api.test.mjs']],
  ['读取 test/api.test.mjs，新增候选测试。', []],
  ['不要修改任何测试；只读取 test/api.test.mjs。', []],
  ['Run node --test test/api.test.mjs', []],
  ['Add tests for src/api.mjs.', []],
  ['补充 test/api.test.mjs 测试，或者编写单独候选测试。', []],
  ['Extend tests/api.test.ts or use a separate candidate suite.', []],
])('recognizes only an explicit named test extension: %s', (description, expected) => {
  expect(namedTestExtensions(description)).toEqual(expected)
})

it('matches exact target paths, including actual absolute receipts, without accepting a candidate alias', () => {
  const description = '补充 test/api.test.mjs 测试。'
  expect(missingNamedTestExtensions(description, ['test/api.candidate.test.mjs'])).toEqual(['test/api.test.mjs'])
  expect(missingNamedTestExtensions(description, ['/actual/root/test/api.test.mjs'])).toEqual([])
})

it.each(['legacy', 'candidate-only', 'rejected', 'no-op', 'corrected', 'final-gate'] as const)('does not accept a candidate suite as the named delivery: %s', async mode => {
  const description = '补充 test/api.test.mjs 自动化测试，运行 node --test 全部通过。'
  let runtime: PulseRuntime, agentId = '', work = 0
  const writes: string[] = []
  const global = () => { const a = runtime.state.agents.get(agentId)!; return a.globalVersions.get(a.latestGlobalVersion) as any }
  const program = buildTaskControllerProgram({ version: mode === 'legacy' ? '50' : '51', system: 'test', toolNames: ['fs.write', 'fs.apply_patch', 'shell.exec'], approvalMode: 'auto', maxTurns: 40 })
  runtime = new PulseRuntime({ effectExecutor: async effect => {
    const input = effect.input as any
    if (effect.kind === 'tool') {
      if (input.name === 'shell.exec') return { value: { code: 0, stdout: 'all fixture tests passed', stderr: '' } }
      writes.push(input.arguments.path)
      if (mode === 'rejected') return { status: 'failed', error: { code: 'FROZEN_TEST_CHANGE', message: 'Original assertion cannot be removed.' } }
      return { value: { path: input.arguments.path, hash: 'b'.repeat(64), ...(mode === 'no-op' ? { changed: false } : {}) } }
    }
    if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: 'extend', kind: 'edit', goal: mode === 'final-gate' ? 'Add supplemental candidate tests' : description, check: 'node --test passes', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    const refs = [...runtime.state.results.values()].filter(r => r.producer?.kind === 'effect' && runtime.state.effects.get(r.producer.id)?.kind === 'tool').map(r => r.id)
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Optimistic verifier accepts the alternate suite' } }
    if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Optimistic final verifier accepts candidate-only tests' }] } }
    const task = global().taskController.tasks.find((t: any) => t.id === global().taskController.activeId)
    const invocation = ++work
    if (invocation === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: mode === 'rejected' || mode === 'no-op' ? 'test/api.test.mjs' : 'test/api.candidate.test.mjs', content: 'candidate fixture' } }] } }
    if (mode === 'corrected' && task.attempts > 1 && !writes.includes('test/api.test.mjs')) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.apply_patch', input: { path: 'test/api.test.mjs', find: 'original', replace: 'original\ntest("additional", () => {})' } }] } }
    if (invocation === 2 || mode === 'corrected' && invocation === 4) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--test'] } }] } }
    return { value: { finishReason: 'stop', text: 'Fixture stage complete' } }
  } })
  agentId = runtime.createAgent({ goal: description, program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'named-test', objective: description, acceptanceCriteria: [{ id: 'criterion-1', description }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  expect(global().taskOutcome.status === 'accepted').toBe(mode === 'legacy' || mode === 'corrected')
  if (!['legacy', 'corrected'].includes(mode)) expect(JSON.stringify(global().taskOutcome)).toContain('NAMED_TEST_DELIVERY_MISSING')
  if (mode === 'corrected') expect(writes).toEqual(['test/api.candidate.test.mjs', 'test/api.test.mjs'])
})
