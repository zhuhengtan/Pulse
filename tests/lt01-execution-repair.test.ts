import { afterEach, expect, it, vi } from 'vitest'
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageRequiresFileChange, normalizeStageKinds, mergePreparatoryStages, mergeRoutineVerificationStages, validatePlan } from '../packages/server/src/task-controller/state.js'
import { toolEvidenceHash, stableCheckOutput } from '../packages/runtime/src/dsl/program.js'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { createLocalHost } from '../packages/server/src/index.js'
import { initialController } from '../packages/server/src/task-controller/state.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
const fixture = JSON.parse(await readFile(new URL('./fixtures/lt01-real-regression.json', import.meta.url), 'utf8'))
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'pulse-lt01-repair-')); roots.push(root); return root }

it('recognizes actual failed t3/t4 and protects read-only intent', () => {
  for (const id of ['t3', 't4']) { const t = fixture.stages.find((t: any) => t.id === id); expect(stageRequiresFileChange(t.goal, t.check)).toBe(true) }
  for (const goal of ['Read scripts/run.mjs', '检查 test_helpers.ts', 'Run node --test fixed.test.mjs', '验证修复结果', '只读检查，不得修改 run.mjs']) expect(stageRequiresFileChange(goal, 'Check result')).toBe(false)
  expect(stageRequiresFileChange('只读检查，不得修改文件', '', 'edit')).toBe(false)
  expect(normalizeStageKinds([{ id: 'edit', goal: fixture.stages[2].goal, check: fixture.stages[2].check, kind: 'analyze', dependsOn: [], criterionIds: ['c1'] }])[0]!.kind).toBe('edit')
})
it('merges a discovery prerequisite without dropping criteria or dependency edges', () => {
  const tasks = normalizeStageKinds([
    { id: 'inspect', goal: '读取 scripts/run.mjs', check: '源码已读取', dependsOn: [], criterionIds: ['c1'] },
    { id: 'edit', goal: '更新 scripts/run.mjs', check: '入口已接入', dependsOn: ['inspect'], criterionIds: ['c2'] },
    { id: 'verify', goal: '验证集成', check: '测试通过', dependsOn: ['edit'], criterionIds: ['c3'] },
  ])
  const merged = mergePreparatoryStages(tasks)
  expect(merged.map(t => t.id)).toEqual(['edit', 'verify'])
  expect(merged[0]!.criterionIds).toEqual(['c1', 'c2'])
  expect(merged[1]!.dependsOn).toEqual(['edit'])
  expect(() => validatePlan(merged, ['c1', 'c2', 'c3'])).not.toThrow()
})
it('merges a pure inspection fanout into a delivery while preserving final CI and mandatory gates', () => {
  const prep = { id: 'inspect', kind: 'verify' as const, goal: '检查入口及源码', check: '读取现状与失败原因', dependsOn: [], criterionIds: ['c0'] }
  const edits = [1, 2, 3].map(n => ({ id: `edit${n}`, kind: 'edit' as const, goal: `修复模块${n}`, check: `模块${n}正确`, dependsOn: ['inspect'], criterionIds: [`c${n}`] }))
  const ci = { id: 'ci', kind: 'verify' as const, goal: '运行 node scripts/ci-check.mjs', check: '退出码0', dependsOn: edits.map(t => t.id), criterionIds: ['c4'] }
  expect(mergePreparatoryStages([prep, ...edits, ci], { preserveParallel: true })).toHaveLength(5)
  const merged = mergePreparatoryStages([prep, ...edits, ci])
  expect(merged.map(t => t.id)).toEqual(['edit1', 'ci'])
  expect(merged[0]!.criterionIds).toEqual(['c0', 'c1', 'c2', 'c3'])
  expect(merged[1]!.dependsOn).toEqual(['edit1'])
  expect(merged[1]!.goal).toBe(ci.goal)
  const baseline = { ...prep, check: '运行 node scripts/ci-check.mjs 复现失败输出' }
  expect(mergePreparatoryStages([baseline, ...edits, ci])).toHaveLength(5)
  const withBaseline = mergePreparatoryStages([baseline, ...edits, ci], { allowFailureBaseline: true })
  expect(withBaseline).toHaveLength(2)
  expect(withBaseline[0]!.check).toContain(baseline.check)
  expect(mergePreparatoryStages([{ ...baseline, check: baseline.check + '，退出码必须为0' }, ...edits, ci], { allowFailureBaseline: true })).toHaveLength(5)
  expect(() => validatePlan(merged, ['c0', 'c1', 'c2', 'c3', 'c4'])).not.toThrow()
  for (const check of ['写出报告', '等待用户确认', '运行 node --test baseline.test.mjs 必须通过']) expect(mergePreparatoryStages([{ ...prep, check }, ...edits, ci])).toHaveLength(5)
  expect(mergePreparatoryStages([prep, ...edits, { ...ci, settledDependencies: ['edit2'] }])).toHaveLength(5)
  expect(mergePreparatoryStages([prep, { ...edits[0]!, dependsOn: ['inspect', 'external'] }])).toHaveLength(2)
})
it('folds a routine verification into its edit with checks intact, but preserves new criteria and user gates', () => {
  const edit = { id: 'edit', kind: 'edit' as const, goal: '修复 entry.mjs', check: '入口正确', dependsOn: [], criterionIds: ['c1'] }
  const verify = { id: 'verify', kind: 'verify' as const, goal: '复跑 node entry.mjs', check: '退出码0', dependsOn: ['edit'], criterionIds: ['c1'] }
  const doc = { id: 'doc', kind: 'edit' as const, goal: '撰写 report.md', check: '报告完整', dependsOn: ['verify'], criterionIds: ['c2'] }
  const merged = mergeRoutineVerificationStages([edit, verify, doc])
  expect(merged.map(t => t.id)).toEqual(['edit', 'doc'])
  expect(merged[0]!.goal).toContain(verify.goal)
  expect(merged[0]!.check).toContain(verify.check)
  expect(merged[1]!.dependsOn).toEqual(['edit'])
  expect(() => validatePlan(merged, ['c1', 'c2'])).not.toThrow()
  expect(mergeRoutineVerificationStages([edit, { ...verify, criterionIds: ['c2'] }])).toHaveLength(2)
  expect(mergeRoutineVerificationStages([edit, { ...verify, goal: 'Run all tests', check: 'All tests pass' }])).toHaveLength(2)
  expect(mergeRoutineVerificationStages([edit, { ...verify, goal: '询问用户确认修复结果' }])).toHaveLength(2)
  expect(mergeRoutineVerificationStages([edit, { ...verify, settledDependencies: ['edit'] }])).toHaveLength(2)
})
it('replays six actual successful checks as the same evidence, keeping failures distinct', () => {
  const hashes = fixture.checks.map((c: any) => toolEvidenceHash({ toolName: 'shell.exec', toolArguments: c.args }, c.value))
  expect(new Set(hashes).size).toBe(1)
  const original = fixture.checks[0]
  for (const change of [{ code: 1 }, { stdout: original.value.stdout.replace('pass 10', 'pass 9') }, { checkReceipt: { ...original.value.checkReceipt, files: { ...original.value.checkReceipt.files, 'scripts/eval/config-budget.mjs': 'changed' } } }, { stderr: 'AssertionError: expected 42, got 41' }]) {
    expect(toolEvidenceHash({ toolName: 'shell.exec', toolArguments: original.args }, { ...original.value, ...change })).not.toBe(hashes[0])
  }
  expect(stableCheckOutput('Expected latency 42ms, got 99ms')).toBe('Expected latency 42ms, got 99ms')
})
it('durably replays all 42 usage receipts, survives reopening and deduplicates', async () => {
  const root = await temp(), path = join(root, 'budget.json')
  let budget = await ModelAttemptBudget.open(path, 256)
  for (const row of fixture.usage) { await budget.reserve(); await budget.recordUsage(row, `actual-${row.sample}`) }
  const before = budget.accounting
  budget = await ModelAttemptBudget.open(path, 4)
  await budget.recordUsage(fixture.usage[0], 'actual-1')
  expect(budget.accounting).toEqual(before)
  expect(before).toMatchObject({ used: 42, limit: 256, inputTokens: 848924, outputTokens: 30472, metrics: { cachedInputTokens: { known: 42, total: 658432 }, reasoningTokens: { known: 42, total: 18917 } } })
})
it('old ledgers retain their limit/count and do not invent auxiliary usage', async () => {
  const root = await temp(), path = join(root, 'budget.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, used: 5, limit: 16, inputTokens: 10, outputTokens: 2, reportedUsage: 1 }))
  const budget = await ModelAttemptBudget.open(path, 256)
  expect(budget.accounting.metrics).toBeUndefined(); expect(budget.used).toBe(5)
  await budget.reserve(); await budget.recordUsage({ inputTokens: 4, outputTokens: 1, cachedInputTokens: 0 }, 'new')
  expect(budget.accounting.metrics).toMatchObject({ cachedInputTokens: { total: 0, known: 1 }, inputTokens: { total: 14, known: 2 } })
})

it('review format failure stops with retained evidence instead of restarting the same loop', async () => {
  let agentId = '', works = 0, reviews = 0; const keys: string[] = []
  const program = buildTaskControllerProgram({ system: 'fixture', toolNames: ['fs.search'], readOnlyToolNames: ['fs.search'], approvalMode: 'auto', maxTurns: 32 })
  const global = () => { const a = runtime.state.agents.get(agentId)!; return a.globalVersions.get(a.latestGlobalVersion) as any }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    keys.push(String(effect.key)); if (effect.kind === 'tool') return { value: { matches: [`fact-${works}`] } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'analyze', kind: 'analyze', goal: 'Analyze sources', check: 'Explain findings', criterionIds: ['c1'], dependsOn: [] }] } }
    if (effect.key?.startsWith('progress-review')) { reviews++; return { value: null, status: 'failed', error: { code: 'OUTPUT_SCHEMA_VIOLATION', message: '508 character action then blank response', retryable: false } } }
    works++; return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.search', input: { query: `fact-${works}` } }] } }
  } })
  agentId = runtime.createAgent({ goal: 'Analyze sources', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Analyze sources', acceptanceCriteria: [{ id: 'c1', description: 'Explain sources' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(global().taskOutcome.status).toBe('incomplete')
  expect(global().taskController.tasks[0].note, JSON.stringify({ works, reviews, keys, stage: global().taskController.tasks[0] })).toContain('PROGRESS_REVIEW_UNAVAILABLE')
  expect(global().taskController.tasks[0].evidenceRefs.length).toBeGreaterThan(0)
  expect(reviews).toBe(1); expect(works).toBe(4)
})

it('Host shows the current root summary instead of the old missing-file candidate', async () => {
  const root = await temp(), host = createLocalHost({ cwd: root, dataDir: join(root, 'data') })
  try {
    const conversation = await host.createConversation(), runId = 'fixture-final-summary'
    await mkdir(join(root, 'data/conversations', conversation.id, 'runs', runId), { recursive: true })
    const runtime = new PulseRuntime()
    runtime.state.results.set('historical', { id: 'historical', privacy: 'public', derivedFrom: [], value: { text: 'config-budget.mjs does not exist' } } as any)
    const summary = 'Delivered config-budget.mjs; checks passed. Integration blocked: NO_PROGRESS. README not started.'
    const program = defineLaneProgram({ id: 'report-fixture', version: '1' }, builder => builder.addStep('report', () => ({ actions: [{ type: 'complete', result: { text: summary } }], next: 'report' })))
    const controller = { ...initialController(16), tasks: [{ id: 'early', status: 'passed', attempts: 1, goal: 'Read sources', check: 'Report', dependsOn: [], criterionIds: ['c1'], evidenceRefs: [], candidateRef: 'historical' }] }
    const { agentId } = runtime.createAgent({ goal: 'Repair integration', program, initialGlobal: { taskController: controller, taskOutcome: { schemaVersion: 1, status: 'incomplete', verifier: 'host', criteria: [], evidenceRefs: [], replanCount: 0, completedAt: '2026-10-15' } } as any })
    const handle = (host as any).makeRunHandle(conversation.id, runId, runtime, runtime.start(agentId))
    const result = await handle.outcome()
    expect(result.text).toBe(summary)
    expect(result.text).not.toContain('does not exist')
  } finally { await host.close() }
})

it('Host auxiliary usage survives automatic event archival and cold resume', async () => {
  const root = await temp(); let calls = 0
  for (let i = 1; i <= 32; i++) await writeFile(join(root, `file-${i}.txt`), `fact-${i}`)
  vi.stubGlobal('fetch', async () => {
    calls++; if (calls > 40) throw Error('unexpected local mock loop')
    const name = calls <= 32 ? 'fs_read' : 'ask_choice'
    const args = calls <= 32 ? { path: `file-${calls}.txt` } : { prompt: '暂停还是继续？', options: ['暂停', '继续'] }
    return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: `call-${calls}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } } }), { headers: { 'content-type': 'application/json' } })
  })
  const options = { cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible' as const, defaultModel: 'fixture', maxContextTokens: 256000 }, taskController: false, approvalMode: 'auto' as const, maxModelCalls: 256, maxTurns: 64 }
  const first = createLocalHost(options); let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation(), run = await first.sendMessage(conversation.id, { text: '检查各个文件，随后询问是否继续' })
    for await (const event of run.events) if (event.type === 'waiting') break
    expect(calls).toBe(33)
    const runtime = (first as any).active.get(run.id).runtime
    await runtime.flushPersistence()
    expect((runtime.state.eventsCompactedThrough ?? 0) > 100, JSON.stringify({ events: runtime.state.events.length, seq: runtime.state.events.at(-1)?.seq, backend: Object.keys(runtime.persistenceBackend ?? {}) })).toBe(true)
    const accounting = (first as any).active.get(run.id).modelBudget.accounting
    expect(accounting).toMatchObject({ used: 33, metrics: { cachedInputTokens: { total: 132, known: 33 }, reasoningTokens: { total: 33, known: 33 } } })
    runtime.cancelAgent = () => {}
    await first.close()
    second = createLocalHost({ ...options, maxModelCalls: 4 })
    const restored = await second.resumeRun(conversation.id)
    expect((second as any).active.get(restored.id).modelBudget.accounting).toEqual(accounting)
    await restored.cancel('LOCAL_TEST_COMPLETE'); await restored.outcome()
    expect(await restored.usage()).toMatchObject({ modelCalls: 33, inputTokens: 330, outputTokens: 66, cachedInputTokens: 132, reasoningTokens: 33, fieldCompleteness: { cachedInputTokens: { status: 'complete', knownAttempts: 33, totalAttempts: 33 }, reasoningTokens: { status: 'complete' }, latencyMs: { status: 'complete' } } })
    expect(calls).toBe(33)
  } finally { await first.close(); await second?.close() }
}, 60000)

it.each([false, true])('failed progress review uses only an actual missing page once (worker=%s)', async worker => {
  let agentId = '', turns = 0, reviews = 0, plans = 0
  const program = buildTaskControllerProgram({ system: 'fixture', toolNames: ['fs.read'], readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 48 })
  const global = () => { const a = runtime.state.agents.get(agentId)!; return a.globalVersions.get(a.latestGlobalVersion) as any }
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') { const a = (effect.input as any).arguments; return { value: { path: a.path, offset: a.offset ?? 0, nextOffset: a.path === 'source-4.md' && !a.offset ? 3000 : null, hash: 'version', content: `page:${a.path}:${a.offset ?? 0}` } } }
    if (effect.key?.startsWith('plan')) { plans++; return { value: { tasks: [
      { id: 'a', kind: 'analyze', goal: 'Analyze source-4.md', check: 'Explain findings', dependsOn: [], criterionIds: ['c1'] },
      ...(worker ? [{ id: 'b', kind: 'analyze', goal: 'Explain conclusions', check: 'Response delivered', dependsOn: ['a'], criterionIds: ['c2'] }] : []),
    ] } } }
    if (effect.key?.startsWith('progress-review')) { reviews++; return { value: reviews % 2 ? JSON.parse(fixture.correction) : { text: fixture.blank } } }
    const state = global().taskController
    if (effect.key?.startsWith('verify-stage')) { const t = state.tasks.find((t: any) => t.id === state.activeId); return { value: { status: 'passed', evidenceRefs: t.evidenceRefs.length ? t.evidenceRefs : [t.candidateRef], note: 'Observed source pages' } } }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: ['c1', ...(worker ? ['c2'] : [])].map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: state.tasks.flatMap((t: any) => [...t.evidenceRefs, t.candidateRef].filter(Boolean)), rationale: 'Delivered and verified' })) } }
    turns++
    if (turns <= 4) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `source-${turns}.md` } }] } }
    if (turns === 5) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'source-4.md', offset: 3000 } }] } }
    return { value: { text: 'Source conclusions delivered', finishReason: 'stop' } }
  } })
  const criteria = ['c1', ...(worker ? ['c2'] : [])].map(id => ({ id, description: 'Explain sources' }))
  agentId = runtime.createAgent({ goal: 'Analyze sources', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Analyze sources', acceptanceCriteria: criteria, status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(global().taskOutcome.status).toBe('accepted')
  expect(plans).toBe(1); expect(reviews).toBe(2)
  const readEffects = [...runtime.state.effects.values()].filter(e => e.kind === 'tool')
  expect(readEffects).toHaveLength(5)
  expect((readEffects.at(-1)!.input as any).arguments.offset).toBe(3000)
})

it('partially reported usage keeps known values without inventing missing fields', async () => {
  const root = await temp(), path = join(root, 'budget.json'), budget = await ModelAttemptBudget.open(path, 4, 0, { maxTokens: 100 })
  await budget.reserve(); await budget.recordUsage({ inputTokens: 7 }, 'partial-response')
  expect(budget.accounting).toMatchObject({ inputTokens: 7, outputTokens: 0, unknown: 1, metrics: { inputTokens: { total: 7, known: 1 } } })
  expect(budget.accounting.metrics?.outputTokens).toBeUndefined()
  await expect(budget.reserve()).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  const restored = await ModelAttemptBudget.open(path, 256)
  expect(restored.accounting).toEqual(budget.accounting)
})
