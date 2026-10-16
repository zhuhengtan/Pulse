import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { runShell } from '../packages/adapters/src/tools/shell.js'
import { installationDependencyRoots } from '../packages/adapters/src/tools/installation-dependencies.js'
import { allowIndependentDocumentation, fitPlanToBudget, initialController, nextTask, controllerFromGlobal, type ControlledTask } from '../packages/server/src/task-controller/state.js'
import { observeStageProgress, stageProgressBlock } from '../packages/server/src/task-controller/progress.js'
import { controllerReport } from '../packages/server/src/task-controller/report.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { namedHostChecks, existingContractEvidence, stageCheckFailure } from '../packages/server/src/task-controller/stage-checks.js'

const stage = (id: string, goal: string, dependsOn: string[] = []): ControlledTask => ({ id, kind: 'edit', goal, check: 'Actual file and check', criterionIds: [id], dependsOn, attempts: 0, status: 'pending', evidenceRefs: [] })
const context = (rows: Record<string, any>): any => ({ results: { read: (ref: string) => rows[ref]?.value, meta: (ref: string) => rows[ref]?.meta } })

it('grants only host installation dependency directories, never workspace or home', async () => {
  const roots = await installationDependencyRoots()
  expect(roots).toContain(resolve('node_modules'))
  expect(roots).toContain(resolve('packages/adapters/node_modules'))
  expect(roots.every(root => /[/\\]node_modules$/.test(root))).toBe(true)
  expect(roots).not.toContain(resolve('.'))
})

it('loads shared installed aliases in the actual sandbox while denying sibling sources, credentials and writes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pulse-dependency-boundary-')), cwd = join(base, 'workspace')
  await mkdir(cwd); await writeFile(join(base, 'private-config.json'), 'PRIVATE SENTINEL')
  await symlink(resolve('packages/adapters/node_modules'), join(cwd, 'node_modules'))
  const forbiddenWrite = join(resolve('packages/adapters/node_modules'), `pulse-denied-${Date.now()}.txt`)
  try {
    const script = `import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';await import('@anthropic-ai/sandbox-runtime');assert.throws(()=>readFileSync(${JSON.stringify(resolve('packages/adapters/src/tools/shell.ts'))}));assert.throws(()=>readFileSync(${JSON.stringify(join(base, 'private-config.json'))}));assert.throws(()=>writeFileSync(${JSON.stringify(forbiddenWrite)},'must not write',{flag:'wx'}));console.log('DEPENDENCY_READ_ONLY_OK')`
    await writeFile(join(cwd, 'probe.mjs'), script)
    const result = await runShell('node', ['probe.mjs'], { cwd, env: { PATH: process.env.PATH }, timeoutMs: 30000 })
    expect(result.code, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('DEPENDENCY_READ_ONLY_OK')
  } finally { await rm(forbiddenWrite, { force: true }); await rm(base, { recursive: true, force: true }) }
}, 40000)

it('keeps no-progress accounting across work, changed durations, verification retries and cold state restore', () => {
  const t = stage('s', 'Run tests'); t.kind = 'verify'; t.attempts = 1
  const rows: Record<string, any> = {}, ctx = context(rows)
  for (let i = 1; i <= 5; i++) {
    rows[`r${i}`] = { meta: { effectKind: 'tool', toolName: 'shell.exec', toolArguments: { command: 'node', args: ['--test'] } }, value: { code: 0, stdout: `✔ assertion (${i}.5ms)\nℹ duration_ms ${i}`, outputArchive: { stdout: { id: `log-${i}`, complete: true } }, checkReceipt: { stable: true, definitionChanged: false, files: { 'source.mjs': 'v1' } } } }
    t.evidenceRefs.push(`r${i}`); t.modelCalls = i
    observeStageProgress(t, ctx)
    observeStageProgress(t, ctx) // verifier observing the same call is not another round
    const restored = controllerFromGlobal(JSON.parse(JSON.stringify({ taskController: { ...initialController(64), tasks: [t] } })))!
    t.progress = restored.tasks[0]!.progress!
  }
  expect(t.progress?.noProgress).toBe(4)
  expect(stageProgressBlock(t)).toContain('NO_PROGRESS')
  rows.r6 = { ...rows.r5, value: { ...rows.r5.value, code: 1, stdout: '✖ changed assertion failed' } }
  t.evidenceRefs.push('r6'); t.modelCalls = 6; observeStageProgress(t, ctx)
  expect(t.progress?.noProgress).toBe(0) // changed failure is evidence, never a pass
})

it('treats unread pages, changed file versions and actual new answers as progress', () => {
  const t = stage('s', 'Inspect source'), rows: Record<string, any> = {}, ctx = context(rows)
  for (let i = 1; i <= 3; i++) {
    rows[`r${i}`] = { meta: { effectKind: 'tool', toolName: 'fs.read', toolArguments: { path: 'a.mjs' } }, value: { path: 'a.mjs', hash: 'v1', offset: i * 3000, content: `page-${i}`, nextOffset: i * 3000 + 3000 } }
    t.evidenceRefs.push(`r${i}`); t.modelCalls = i; observeStageProgress(t, ctx); expect(t.progress?.noProgress).toBe(0)
  }
  rows.r4 = { meta: { effectKind: 'human' }, value: { approved: true } }; t.evidenceRefs.push('r4'); t.modelCalls = 4; observeStageProgress(t, ctx)
  expect(t.progress?.noProgress).toBe(0)
})

it('continues independent README work after test settlement while keeping implementation and explicit pass gates hard', () => {
  const checks = stage('test', 'Create scripts/eval/resume-run.test.mjs and run tests'), doc = stage('doc', '更新 evals/README.md，说明当前实现与测试结果', ['test'])
  checks.status = 'blocked'; checks.attempts = 1; checks.note = 'SANDBOX_DEPENDENCY_UNAVAILABLE'
  const state = initialController(64); state.tasks = allowIndependentDocumentation([checks, doc], 'Implement and test, then update README') as ControlledTask[]
  expect(nextTask(state)?.id).toBe('doc'); expect(state.tasks[0]?.status).toBe('blocked')
  state.tasks = allowIndependentDocumentation([checks, doc], '只有测试通过后才能更新文档') as ControlledTask[]
  expect(nextTask(state)).toBeUndefined(); expect(state.tasks[1]?.status).toBe('blocked')
  const implementation = { ...checks, goal: 'Implement scripts/eval/run.mjs' }
  state.tasks = allowIndependentDocumentation([implementation, { ...doc, status: 'pending' }], 'Update code and docs') as ControlledTask[]
  expect(nextTask(state)).toBeUndefined()
})

it('does not unlock documentation when its test dependency only inherited a missing implementation', () => {
  const source = stage('source', 'Implement src/api.mjs'); source.status = 'blocked'; source.attempts = 1
  const test = stage('test', 'Create scripts/api.test.mjs', ['source']), doc = stage('doc', 'Update README.md', ['test'])
  const state = initialController(64); state.tasks = allowIndependentDocumentation([source, test, doc], 'Implement and document') as ControlledTask[]
  expect(nextTask(state)).toBeUndefined(); expect(state.tasks.every(t => t.status === 'blocked')).toBe(true)
})

it('prints the shared failure once while retaining each criterion status, unique failures, files and unstarted stages', () => {
  const first = stage('s1', 'Run actual tests'); first.status = 'blocked'; first.attempts = 1; first.note = 'ERR_MODULE_NOT_FOUND native dependency'
  const doc = stage('s2', 'Update README.md', ['s1']); doc.status = 'blocked'; doc.note = first.note
  const state = initialController(64); state.tasks = [first, doc]
  const criteria = [
    { criterionId: 's1', status: 'not_met' as const, evidenceRefs: ['r1'], rationale: `s1: ${first.note}` },
    { criterionId: 's2', status: 'unverifiable' as const, evidenceRefs: [], rationale: `s2: ${first.note}` },
    { criterionId: 'other', status: 'not_met' as const, evidenceRefs: ['r2'], rationale: 'Separate assertion mismatch' },
  ]
  const original = JSON.stringify(criteria), text = controllerReport(state, criteria, false, true, t => t.id === 's1' ? ['scripts/test.mjs'] : [], () => undefined)
  expect(text.split(first.note).length - 1).toBe(1)
  expect(text).toContain('s1: not_met [r1]'); expect(text).toContain('s2: unverifiable')
  expect(text).toContain('Separate assertion mismatch'); expect(text).toContain('未启动阶段'); expect(text).toContain('scripts/test.mjs')
  expect(JSON.stringify(criteria)).toBe(original)
})

it('requires native current file hashes and full frozen assertions for reuse of an existing edit', () => {
  const t = stage('s', 'Update scripts/run.mjs'); t.check = 'duplicate-summary passes'; t.evidenceRefs = ['read', 'check']; t.hostCheckRefs = { frozen: 'check' }
  const check: any = { id: 'frozen', toolName: 'host.check', criterionIds: ['s'], expectedChecks: ['duplicate-summary'], description: 'frozen', input: {}, covers: [] }
  const rows: any = { read: { meta: { toolName: 'fs.read', outcomeStatus: 'succeeded' }, value: { path: 'scripts/run.mjs', hash: 'v1' } }, check: { meta: { effectKind: 'tool', toolName: 'host.check', outcomeStatus: 'succeeded' }, value: { checks: [{ id: 'duplicate-summary', passed: true }], checkReceipt: { stable: true, definitionChanged: false, files: { 'scripts/run.mjs': 'v1' } } } } }
  const ctx = context(rows)
  expect(namedHostChecks({ acceptanceChecks: [check] } as any, t)).toHaveLength(1)
  expect(existingContractEvidence(ctx, t, [check])).toBe(true)
  rows.read.value.hash = 'v2'; expect(existingContractEvidence(ctx, t, [check])).toBe(false)
  rows.check.value.checks[0].passed = false
  expect(stageCheckFailure(ctx, t, [check])).toContain('INDEPENDENT_ACCEPTANCE_FAILED')
  expect(existingContractEvidence(ctx, t, [check])).toBe(false)
})

it('stops the actual controller work/verifier cycle without another plan, preserving the failed criterion', async () => {
  let runtime: PulseRuntime, work = 0, plans = 0
  const globals: JsonValue = { taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Verify runner', acceptanceCriteria: [{ id: 's', description: 'Verify runner' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } }
  const program = buildTaskControllerProgram({ version: '18', system: 'offline', toolNames: [], approvalMode: 'auto', maxTurns: 96 })
  runtime = new PulseRuntime({ effectExecutor: async e => {
    if (e.key.startsWith('plan')) { plans++; return { value: { tasks: [{ id: 's', kind: 'verify', goal: 'Verify runner', check: 'Missing check remains missing', criterionIds: ['s'], dependsOn: [] }] } } }
    if (e.key.startsWith('verify-stage')) return { value: { status: 'needs_work', evidenceRefs: [], correctionKind: 'verify', note: 'Missing check remains missing' } }
    work++; return { value: { text: 'Still missing the check', finishReason: 'stop' } }
  } })
  const { agentId } = runtime.createAgent({ goal: 'Verify runner', program, initialGlobal: globals })
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  const agent = runtime.state.agents.get(agentId)!, result = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(plans).toBe(1); expect(work).toBeLessThanOrEqual(4)
  expect(result.taskOutcome.status).toBe('incomplete')
  expect(result.taskController.tasks[0].note).toContain('NO_PROGRESS')
})

function globalState(runtime: PulseRuntime): any {
  const agent = [...runtime.state.agents.values()][0]!
  return agent.globalVersions.get(agent.latestGlobalVersion)
}
function activeState(runtime: PulseRuntime, laneId: string): any {
  return (runtime.state.lanes.get(laneId)?.context.state as any)?.taskControllerChain ?? globalState(runtime).taskController
}
function contract(criteria: Array<{ id: string; description: string }>): any {
  return { schemaVersion: 1, runId: 'offline', objective: 'Implement, test and document current behavior', acceptanceCriteria: criteria, status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] }
}

it.each([false, true])('runs a named frozen Host check at stage and final verification; a failed assertion cannot pass (%s)', async failed => {
  let runtime: PulseRuntime, work = 0, nativeChecks = 0, writes = 0
  const hash = 'a'.repeat(64), check: any = { id: 'frozen', description: 'Frozen runner check', toolName: 'host.check', input: {}, expectedChecks: ['duplicate-summary'], criterionIds: ['s'], covers: [] }
  const record = { ...contract([{ id: 's', description: 'Update scripts/run.mjs' }]), acceptanceChecks: [check] }
  const program = buildTaskControllerProgram({ version: '18', system: 'offline', toolNames: ['fs.read', 'fs.write', 'host.check'], approvalMode: 'auto', maxTurns: 48 })
  runtime = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') {
      const name = (e.input as any).name
      if (name === 'host.check') { nativeChecks++; return { value: { checks: [{ id: 'duplicate-summary', passed: !failed, detail: failed ? 'duplicate rows remain' : 'one row' }], checkReceipt: { stable: true, definitionChanged: false, files: { 'scripts/run.mjs': hash } } } } }
      if (name === 'fs.write') { writes++; throw Error('Must reuse the verified existing implementation') }
      return { value: { path: 'scripts/run.mjs', hash, content: 'existing implementation', offset: 0, nextOffset: null } }
    }
    if (e.key.startsWith('plan')) return { value: { tasks: [{ id: 's', kind: 'edit', goal: 'Update scripts/run.mjs', check: 'duplicate-summary passes', criterionIds: ['s'], dependsOn: [] }] } }
    const state = activeState(runtime, e.ownerLaneId), t = state.tasks.find((t: any) => t.id === state.activeId)
    if (e.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: t.evidenceRefs, note: 'Actual native file and frozen check' } } // hostile pass when failed
    if (e.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 's', status: 'passed', evidenceRefs: globalState(runtime).taskController.tasks[0].evidenceRefs, rationale: 'Current native proof' }] } }
    work++
    return { value: work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'scripts/run.mjs' } }] } : { finishReason: 'stop', text: 'Existing implementation is present' } }
  } })
  const { agentId } = runtime.createAgent({ goal: 'Update scripts/run.mjs', program, initialGlobal: { taskRecord: record } })
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(writes).toBe(0); expect(nativeChecks).toBe(2)
  const result = globalState(runtime)
  expect(result.taskOutcome.status).toBe(failed ? 'incomplete' : 'accepted')
  if (failed) expect(result.taskOutcome.criteria[0].status).toBe('not_met')
  else expect(result.taskController.tasks[0].status).toBe('passed')
})

it.each([false, true])('actually writes independent README after an environment failure unless the user requires tests to pass (%s)', async explicitGate => {
  let runtime: PulseRuntime
  const owners = new Set<string>(), docWrites: string[] = [], turns = new Map<string, number>()
  const program = buildTaskControllerProgram({ version: '18', system: 'offline', toolNames: ['shell.exec', 'fs.write'], approvalMode: 'auto', maxTurns: 64 })
  const record = contract([{ id: 'test', description: 'Run actual tests' }, { id: 'doc', description: 'Update README.md truthfully' }])
  if (explicitGate) record.objective = '只有测试通过后才能更新文档'
  runtime = new PulseRuntime({ effectExecutor: async e => {
    if (e.key.startsWith('plan')) return { value: { tasks: [
      { id: 'test', kind: 'verify', goal: 'Run scripts/check.test.mjs', check: 'Tests pass', criterionIds: ['test'], dependsOn: [] },
      { id: 'doc', kind: 'edit', goal: 'Update README.md', check: 'Document current behavior and failed verification', criterionIds: ['doc'], dependsOn: ['test'] },
    ] } }
    const state = activeState(runtime, e.ownerLaneId), active = state.tasks.find((t: any) => t.id === state.activeId)
    owners.add(e.ownerLaneId)
    if (e.kind === 'tool') {
      const name = (e.input as any).name
      if (name === 'shell.exec') return { value: { code: 1, stderr: 'EPERM: sandbox dependency inaccessible' } }
      docWrites.push((e.input as any).arguments.path)
      return { value: { path: 'README.md', hash: 'd'.repeat(64), changed: true } }
    }
    if (e.key.startsWith('verify-stage')) return { value: { status: active.id === 'test' ? 'blocked' : 'passed', evidenceRefs: active.evidenceRefs, note: active.id === 'test' ? 'EPERM: sandbox dependency inaccessible' : 'README describes the current implementation and remaining environment failure' } }
    const turn = (turns.get(active.id) ?? 0) + 1; turns.set(active.id, turn)
    return { value: turn === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: active.id === 'test' ? 'shell.exec' : 'fs.write', input: active.id === 'test' ? { command: 'node', args: ['--test', 'scripts/check.test.mjs'] } : { path: 'README.md', content: 'Current behavior; test blocked by environment.' } }] } : { finishReason: 'stop', text: 'Stage evidence retained' } }
  } })
  const { agentId } = runtime.createAgent({ goal: record.objective, program, initialGlobal: { taskRecord: record } })
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(docWrites).toEqual(explicitGate ? [] : ['README.md'])
  expect(globalState(runtime).taskOutcome.status).toBe('incomplete')
  expect(globalState(runtime).taskController.tasks[0].status).toBe('blocked')
  if (!explicitGate) { expect(globalState(runtime).taskController.tasks[1].status).toBe('passed'); expect(owners.size).toBe(1) }
})

it.each([false, true])('replays the real LT02 prefix with bounded verification correction and Host budget refresh (fork=%s)', async fork => {
  const fixture = JSON.parse(await readFile(resolve('tests/fixtures/lt02-continuation05-cycle.json'), 'utf8'))
  let runtime: PulseRuntime, cursor = 0, reviews = 0, plans = 0
  const program = buildTaskControllerProgram({ version: '18', system: 'offline real-trace replay', toolNames: ['fs.read', 'fs.list', 'fs.search', 'shell.exec', 'fs.write'], approvalMode: 'auto', maxTurns: 96, modelBudgetView: () => ({ limit: 96, used: cursor + reviews + plans, workAllowed: true, verificationAllowed: true, finalAllowed: true }) })
  runtime = new PulseRuntime({ effectExecutor: async e => {
    if (e.key === '$compact-summary') return { value: { text: 'Settled reads and failed/missing checks retained. No tool proposed or executed by this summary.', finishReason: 'stop' } }
    if (e.key.startsWith('plan')) { plans++; return { value: { tasks: [fixture.plan, ...(fork ? [{ id: 'other', kind: 'analyze', goal: 'Explain the status', check: 'Response delivered', dependsOn: [], criterionIds: ['other'] }] : [])] } } }
    const state = activeState(runtime, e.ownerLaneId), t = state.tasks.find((t: any) => t.id === state.activeId)
    if (t?.id === 'other') return { value: e.key.startsWith('verify-stage') ? { status: 'passed', evidenceRefs: [t.candidateRef], note: 'Independent response delivered' } : { text: 'Independent response delivered', finishReason: 'stop' } }
    if (e.kind === 'tool') {
      const { name, arguments: args } = e.input as any
      if (name === 'fs.read') return { value: fixture.reads.find((r: any) => r.path === args.path && r.offset === (args.offset ?? 0)) ?? { path: args.path, hash: 'a'.repeat(64), offset: 0, content: 'existing helper', nextOffset: null } }
      if (name === 'shell.exec') return { value: { code: 0, stdout: '8 helper checks passed', checkReceipt: { stable: true, definitionChanged: false, files: { 'scripts/eval/run.mjs': fixture.reads[0].hash } } } }
      return { value: { entries: ['run.mjs', 'resume.mjs'], matches: [] } }
    }
    if (e.key.startsWith('verify-stage')) { reviews++; return { value: { ...JSON.parse(fixture.verifiers[Math.min(reviews - 1, fixture.verifiers.length - 1)]), evidenceRefs: t.evidenceRefs } } }
    if (e.key.startsWith('progress-review')) return { value: { status: 'ready', evidenceRefs: t.evidenceRefs, note: 'Current file is already implemented' } }
    const row = fixture.work[Math.min(cursor++, fixture.work.length - 1)]
    const calls = row.proposed.filter((p: any) => ['fs_read', 'fs_list', 'fs_search', 'shell_exec'].includes(p.name)).map((p: any) => ({ name: p.name.replace('_', '.'), input: p.arguments }))
    return { value: calls.length ? { finishReason: 'tool_calls', toolCalls: calls } : { finishReason: 'stop', text: row.visibleText || 'No new evidence' } }
  } })
  const { agentId } = runtime.createAgent({ goal: 'Continue existing runner verification', program, initialGlobal: { taskRecord: contract([...fixture.criteria, ...(fork ? [{ id: 'other', description: 'Explain the status' }] : [])]) } })
  const outcome = await runtime.start(agentId).outcome()
  expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded')
  const result = globalState(runtime)
  expect(plans).toBe(1); expect(reviews).toBeLessThanOrEqual(4); expect(cursor).toBeLessThanOrEqual(20)
  expect(result.taskOutcome.status).toBe('incomplete')
  if (fork) expect(result.taskController.tasks.find((t: any) => t.id === 'other').status, JSON.stringify({controller:result.taskController,errors:runtime.state.events.filter(e=>/control|reject/.test(e.type)).slice(-8)})).toBe('passed')
  expect(result.taskController.tasks[0].correctionKind).toBe('verify')
  expect(result.taskController.tasks[0].note).toMatch(/NO_PROGRESS|Verifier/)
})

it('preserves soft documentation prerequisites when fitting the plan budget and rejects mixed source edits', () => {
  const tests = stage('tests', 'Run tests'); tests.kind = 'verify'
  const doc = stage('doc', 'Update README.md', ['tests'])
  const normalized = allowIndependentDocumentation([tests, doc], 'Run tests and document')
  const fitted = fitPlanToBudget(normalized, 8)
  expect(fitted).toHaveLength(2)
  expect(fitted[1]?.settledDependencies).toEqual(['tests'])
  const mixed = allowIndependentDocumentation([tests, stage('mixed', 'Update README.md and src/api.ts', ['tests'])], 'Implement and document')
  expect(mixed[1]?.settledDependencies).toEqual([])
})

it('reads installed aliases through the actual Host tool and native approval using only a mock model', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pulse-native-dependencies-')), workspace = join(base, 'workspace')
  await mkdir(workspace)
  // Build a tiny standalone native check with the same installed-alias boundary.
  await symlink(resolve('packages/adapters/node_modules'), join(workspace, 'node_modules'))
  await writeFile(join(workspace, 'dependency.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('installed dependency resolves',async()=>{const pkg=await import('@anthropic-ai/sandbox-runtime');assert.ok(pkg.SandboxManager)});\n")
  const host = createLocalHost({ cwd: workspace, dataDir: join(base, 'data'), provider: { provider: 'mock' }, taskController: true, approvalMode: 'ask', jarvis: { enabled: false }, maxModelCalls: 16, maxTurns: 16,
    mockParallelPlan: { tasks: [{ id: 's', kind: 'verify', goal: 'Run dependency.test.mjs', check: 'Node test passes', criterionIds: ['criterion-1'], dependsOn: [] }] },
    mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--test', 'dependency.test.mjs'] } }], mockAfterToolResponse: 'Actual native check completed',
  })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Run dependency.test.mjs' })
    let approvals = 0
    for await (const event of run.events) if (event.type === 'waiting') for (const group of await run.pendingInteractions()) for (const item of group.items) { expect(group.kind).toBe('approval'); approvals++; await run.reply(item.effectId, { approved: true }) }
    expect(approvals).toBe(1)
    expect((await run.outcome()).status).toBe('succeeded')
    const state = await readFile(join(base, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')
    expect(state).toContain('pulse.assistant')
    const files = await import('node:fs/promises'), results = join(base, 'data/conversations', conversation.id, 'runs', run.id, 'runtime-results')
    const receipts = await Promise.all((await files.readdir(results)).map(async p => JSON.parse(await readFile(join(results, p), 'utf8'))))
    expect(receipts.some(r => r.value?.code === 0 && r.value?.stdout?.includes('installed dependency resolves'))).toBe(true)
  } finally { await host.close(); await rm(base, { recursive: true, force: true }) }
}, 20000)
