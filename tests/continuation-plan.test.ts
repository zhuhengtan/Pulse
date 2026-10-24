import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { createCheckpoint, validateCheckpoint, type Checkpoint } from '../packages/server/src/task-controller/checkpoint.js'
import { continuationCandidates, requiresBaselineTestRemoval } from '../packages/server/src/task-controller/continuation-plan.js'
import { initialController, fitPlanToBudget, mergePreparatoryStages, mergeRoutineVerificationStages } from '../packages/server/src/task-controller/state.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

const fixture = (): Checkpoint => ({ schemaVersion: 1, sourceRunId: 'prior', objective: 'Create the output and finish remaining work', controller: initialController(32), stamp: { available: true, files: { 'scripts/tool.mjs': 'script-hash', 'output.json': 'output-hash', 'input.json': 'input-hash' } }, reusableIds: [], evidence: {}, fileHashes: {}, continuationVersion: 2, facts: [{ stageId: 'write', sourceRef: 'old-write', tool: 'fs.write', result: { path: 'scripts/tool.mjs', hash: 'script-hash' } }], completedCommands: [{ stageId: 'run', sourceRef: 'old-command', command: 'node', args: ['scripts/tool.mjs'], cwd: '.', scriptHashes: { 'scripts/tool.mjs': 'script-hash' }, exitCode: 0 }] })
const stage = (id: string, goal: string, dependsOn: string[] = []) => ({ id, kind: 'edit' as const, goal, check: 'Requested contract is met', criterionIds: ['criterion-1'], dependsOn })

it('turns retained writes and successful generators into fresh read-only verification, not passes', () => {
  const tasks = [stage('write', 'Create scripts/tool.mjs from input.json'), stage('run', 'Run node scripts/tool.mjs to produce output.json', ['write']), stage('missing', 'Create missing.json', ['run'])]
  const normalized = continuationCandidates(tasks, fixture(), 'Finish remaining work')
  expect(normalized.map(t => t.retainedArtifactVerification ?? false)).toEqual([true, true, false])
  expect(normalized[0]).toMatchObject({ kind: 'verify', dependsOn: [], criterionIds: ['criterion-1'] })
  expect(normalized[1]?.check).toContain('not fresh checks')
  expect(normalized[0]).not.toHaveProperty('status')
  expect(normalized[2]).toEqual(tasks[2])
  const constrained = fitPlanToBudget(mergeRoutineVerificationStages(mergePreparatoryStages(normalized)), 10)
  expect(constrained.filter(t => (t as any).retainedArtifactVerification)).toHaveLength(2)
  expect(constrained.find(t => t.id === 'missing')?.goal).toBe('Create missing.json')
})

it('does not equate an existing script with a successful generator execution', () => {
  const checkpoint = { ...fixture(), completedCommands: [] }
  const run = stage('run', 'Run node scripts/tool.mjs')
  expect(continuationCandidates([run], checkpoint, 'Run the tool')).toEqual([run])
})

it('honors an explicit current rerun while retaining a negative rerun instruction', () => {
  const run = stage('run', 'Run node scripts/tool.mjs')
  expect(continuationCandidates([run], fixture(), 'Produce output', 'Rerun node scripts/tool.mjs now')).toEqual([run])
  expect(continuationCandidates([run], fixture(), 'Produce output', 'Continue; do not rerun completed generators')[0]?.retainedArtifactVerification).toBe(true)
})

it('keeps mixed missing work and explicit user reruns, and does not change legacy checkpoints', () => {
  const mixed = stage('mixed', 'Create scripts/tool.mjs and missing/new.json')
  expect(continuationCandidates([mixed], fixture(), 'Continue')[0]).toEqual(mixed)
  const tasks = [stage('missing', 'Create missing.json'), stage('repeat', 'Rerun the complete pipeline', ['missing'])]
  expect(continuationCandidates(tasks, fixture(), 'Finish the remaining work')).toHaveLength(1)
  expect(continuationCandidates(tasks, fixture(), 'Rerun the pipeline after finishing')).toHaveLength(2)
  expect(continuationCandidates(tasks, { ...fixture(), continuationVersion: undefined }, 'Continue')).toEqual(tasks)
})

it.each([
  ['Replace placeholder tests in test/check.test.mjs', true],
  ['将 test/check.test.mjs 的占位用例替换为真实校验', true],
  ['Append tests while preserving placeholder tests in test/check.test.mjs', false],
  ['Replace placeholder implementation in src/main.mjs', false],
])('rejects plan requirements that contradict frozen baseline tests (%s)', (goal, expected) => {
  expect(requiresBaselineTestRemoval([stage('test', goal)])).toBe(expected)
})

it('records only bounded public successful local commands with unchanged observed scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-command-checkpoint-'))
  try {
    execFileSync('git', ['init', '-q', root])
    const content = 'console.log("produce output")\n', hash = createHash('sha256').update(content).digest('hex')
    await writeFile(join(root, 'tool.mjs'), content); await writeFile(join(root, 'output.json'), '{}\n')
    const controller = initialController(32)
    controller.tasks = [{ ...stage('deliver', 'Create tool.mjs and produce output.json'), status: 'running', attempts: 1, evidenceRefs: ['result-1', 'result-2'] }]
    const effects = new Map<string, any>([
      ['effect-1', { id: 'effect-1', kind: 'tool', input: { name: 'fs.write', arguments: { path: 'tool.mjs', content } }, outcome: { status: 'succeeded', resultRef: 'result-1' } }],
      ['effect-2', { id: 'effect-2', kind: 'tool', input: { name: 'shell.exec', arguments: { command: 'node', args: ['tool.mjs'] } }, outcome: { status: 'succeeded', resultRef: 'result-2' } }],
    ])
    const results = new Map<string, any>([
      ['result-1', { id: 'result-1', privacy: 'public', producer: { kind: 'effect', id: 'effect-1' }, value: { path: 'tool.mjs', hash } }],
      ['result-2', { id: 'result-2', privacy: 'public', producer: { kind: 'effect', id: 'effect-2' }, value: { code: 0 } }],
    ])
    const runtime: any = { state: { effects, results } }, global: any = { taskRecord: { objective: fixture().objective }, taskController: controller }
    expect((await createCheckpoint(runtime, root, 'prior', global))?.continuationVersion).toBeUndefined()
    const checkpoint = (await createCheckpoint(runtime, root, 'prior', global, undefined, { continuationCommands: true }))!
    expect(checkpoint.reusableIds).toEqual([])
    expect(checkpoint.stamp.files).toHaveProperty('output.json')
    expect(checkpoint.completedCommands).toEqual([expect.objectContaining({ command: 'node', args: ['tool.mjs'], exitCode: 0, scriptHashes: { 'tool.mjs': hash } })])
    for (const bad of [{ code: 1 }, { code: null }, { code: 0, timedOut: true }, { code: 0, truncated: true }]) {
      results.get('result-2').value = bad
      expect((await createCheckpoint(runtime, root, 'prior', global, undefined, { continuationCommands: true }))?.completedCommands).toEqual([])
    }
    results.get('result-2').value = { code: 0 }; results.get('result-2').privacy = 'private'
    expect((await createCheckpoint(runtime, root, 'prior', global, undefined, { continuationCommands: true }))?.completedCommands).toEqual([])
    await writeFile(join(root, 'tool.mjs'), 'changed by another actor\n')
    expect(await validateCheckpoint(root, checkpoint, fixture().objective)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('blocks actual write and generator proposals in a retained verification stage', async () => {
  let runtime: PulseRuntime, agentId = '', calls = 0
  const executed: string[] = []
  const current = () => { const a = runtime.state.agents.get(agentId)!; return a.globalVersions.get(a.latestGlobalVersion) as any }
  const checkpoint = fixture()
  const program = buildTaskControllerProgram({ version: '40', system: 'test', continuationCheckpoint: checkpoint, resumePlan: checkpoint.controller, toolNames: ['task.recall', 'fs.read', 'fs.write', 'shell.exec'], readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 32 })
  runtime = new PulseRuntime({ effectExecutor: async effect => {
    const input: any = effect.input
    if (effect.kind === 'tool') {
      executed.push(input.name)
      return { value: input.name === 'task.recall' ? { valid: true, reusableIds: [] } : { path: 'scripts/tool.mjs', hash: 'script-hash', content: 'retained source', nextOffset: null } }
    }
    if (effect.key.startsWith('plan')) return { value: { tasks: [stage('write', 'Create scripts/tool.mjs')] } }
    const task = current().taskController.tasks[0]
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: task.evidenceRefs, note: 'Current retained source satisfies contract.' } }
    if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: task.evidenceRefs, rationale: 'Current content inspected.' }] } }
    calls++
    if (calls === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'scripts/tool.mjs', content: 'replay' } }] } }
    if (calls === 2) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['scripts/tool.mjs'] } }] } }
    if (calls === 3) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'scripts/tool.mjs' } }] } }
    return { value: { text: 'Retained source verified.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: fixture().objective, program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'current', objective: fixture().objective, acceptanceCriteria: [{ id: 'criterion-1', description: 'Source contract is met' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(executed).toEqual(['task.recall', 'fs.read'])
  expect(current().taskOutcome.status).toBe('accepted')
})
