import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { reusableEvidence } from '../packages/runtime/src/dsl/evidence-reuse.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { normalizeStageKinds, stageRequiresFileChange, controllerFromGlobal } from '../packages/server/src/task-controller/state.js'
import { parseEvaluationBudgets } from '../scripts/eval/config-budget.mjs'
const real = JSON.parse(await readFile(new URL('./fixtures/lt01-round6-regression.json', import.meta.url), 'utf8'))
const globalFor = (r: PulseRuntime, id: string): any => { const a = r.state.agents.get(id)!; return a.globalVersions.get(a.latestGlobalVersion) }
it('corrects the actual pure integration check even when planner says edit', () => {
  for (const goal of [real.stage.goal, '集成验证 run.mjs', '确认接入结果并记录证据', 'Integration verification of runner', '检查 runner 并记录测试结果']) {
    expect(stageRequiresFileChange(goal, 'Tests pass', 'edit', true), goal).toBe(false)
    expect(normalizeStageKinds([{ id: 's', ...real.stage, goal, dependsOn: [], criterionIds: ['c'] }], true)[0]!.kind).toBe('verify')
  }
  for (const goal of ['修复 runner 并验证', '将模块接入 scripts/run.mjs', '更新 docs/README.md', '检查 runner 然后更新文档', '集成核查并创建 docs/check.md', '集成核查并将证据记录到 docs/check.md', 'Integration check and record findings in docs/report.md']) expect(stageRequiresFileChange(goal, 'Tests pass', 'edit', true), goal).toBe(true)
  expect(stageRequiresFileChange('只读核查，不得修改文件', '', 'edit', true)).toBe(false)
  expect(stageRequiresFileChange(real.stage.goal, real.stage.check, 'edit')).toBe(true) // v12 compatibility
})
it('parses budget flags independently before collapsing aliases', () => {
  expect(parseEvaluationBudgets(['--max-calls', '7', '--max-turns', '3'])).toEqual({ maxModelCalls: 7, maxTurns: 3 })
  expect(parseEvaluationBudgets(['--max-model-calls', '7', '--max-calls', '7'])).toMatchObject({ maxModelCalls: 7 })
  for (const args of [['--max-model-calls', '7', '--max-calls', '11'], ['--max-calls', '7', '--max-calls', '8'], ['--max-turns'], ['--max-calls', '--max-turns', '3'], ['--max-model-calls', 'NaN']]) expect(() => parseEvaluationBudgets(args)).toThrow()
})

const checkValue = real.tools.find((t: any) => t.outcome.resultRef === 'result-293').result
it('reuses actual successful check evidence, preserving failure/version/argument distinctions', () => {
  const data: any = { 'result-1': { toolName: 'shell.exec', toolArguments: { command: 'node', args: ['--test', 'scripts/eval/config-budget.test.mjs'] }, value: checkValue } }
  const ctx: any = { results: { meta: (ref: string) => data[ref] ? { ...data[ref], outcomeStatus: 'succeeded' } : undefined, read: (ref: string) => data[ref]?.value } }
  const call = { toolName: 'shell.exec', input: data['result-1'].toolArguments }
  expect(reusableEvidence(ctx, [call], Object.keys(data))).toEqual({ refs: ['result-1'], checksOnly: true })
  for (const change of [{ code: 1 }, { truncated: true }, { checkReceipt: { ...checkValue.checkReceipt, definitionChanged: true } }]) {
    data['result-1'].value = { ...checkValue, ...change }
    expect(reusableEvidence(ctx, [call], Object.keys(data))).toBeUndefined()
  }
  data['result-1'].value = checkValue
  expect(reusableEvidence(ctx, [{ ...call, input: { ...call.input, cwd: 'other' } }], Object.keys(data))).toBeUndefined()
  data['result-2'] = { effectKind: 'human', value: { answer: 'New requirement' } }
  expect(reusableEvidence(ctx, [call], Object.keys(data))).toBeUndefined()
  delete data['result-2']
  data['result-2'] = { ...data['result-1'], value: { ...checkValue, code: 1 } }
  expect(reusableEvidence(ctx, [call], Object.keys(data))).toBeUndefined()
  delete data['result-2']
  data['result-2'] = { toolName: 'fs.write', toolArguments: { path: 'scripts/eval/config-budget.mjs' }, value: { path: 'scripts/eval/config-budget.mjs', hash: 'new-version' } }
  expect(reusableEvidence(ctx, [call], Object.keys(data))).toBeUndefined()
})

it.each(['corrected', 'repeated', 'failed-required'] as const)('bounds citation correction with real git/no-commit evidence (%s)', async mode => {
  let id = '', work = 0, reviews = 0, tools = 0, sawRepair = false
  const program = buildTaskControllerProgram({ version: '13', system: 'test', toolNames: ['shell.exec', 'fs.read', 'fs.write'], approvalMode: 'auto', maxTurns: 32 })
  const r = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') {
      tools++; const input = effect.input as any
      if (input.name === 'fs.read') return { value: { path: 'source.txt', content: 'fact', hash: 'same' } }
      if (input.arguments.command === 'git') return { value: real.tools.find((t: any) => t.outcome.resultRef === 'result-285').result }
      return { value: { ...checkValue, code: mode === 'failed-required' ? 1 : 0 } }
    }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 's', ...real.stage, criterionIds: ['c1'], dependsOn: [] }] } }
    const state = globalFor(r, id).taskController
    if (effect.key?.startsWith('verify-stage')) {
      reviews++; sawRepair ||= JSON.stringify(effect.input).includes('CITATION_REPAIR')
      const refs = state.tasks[0].evidenceRefs
      return { value: { status: 'passed', evidenceRefs: refs.filter((ref: string) => mode === 'failed-required' ? r.state.results.get(ref)?.value && (r.state.results.get(ref)!.value as any).code === undefined : mode === 'corrected' && reviews > 1 ? (r.state.results.get(ref)?.value as any)?.code === 0 : true), note: 'Checks pass, git observation reports no commits' } }
    }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c1', status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs, rationale: 'Checks passed' }] } }
    work++
    return { value: work === 1 ? { finishReason: 'tool_calls', toolCalls: [
      { name: 'shell.exec', input: { command: 'node', args: ['--test', 'scripts/eval/config-budget.test.mjs'] } },
      mode === 'failed-required' ? { name: 'fs.read', input: { path: 'source.txt' } } : { name: 'shell.exec', input: { command: 'git', args: ['log', '--oneline', '-1'] } },
    ] } : { finishReason: 'stop', text: 'Checks recorded' } }
  } })
  id = r.createAgent({ goal: 'Validate integration without writing files', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Validate integration', acceptanceCriteria: [{ id: 'c1', description: 'Checks pass' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect((await r.start(id).outcome()).status).toBe('succeeded')
  const g = globalFor(r, id)
  expect(g.taskOutcome.status).toBe(mode === 'corrected' ? 'accepted' : 'incomplete')
  expect(tools).toBe(2); expect(work).toBeLessThanOrEqual(2)
  expect(reviews).toBe(mode === 'failed-required' ? 1 : 2)
  expect(sawRepair).toBe(mode !== 'failed-required')
  expect(g.taskController.tasks[0].kind).toBe('verify')
  if (mode !== 'failed-required') expect(controllerFromGlobal(JSON.parse(JSON.stringify(g)))!.tasks[0]!.citationRepairs).toBe(1)
})

it('stops alternating already-read proposals without dispatching duplicate reads', async () => {
  let models = 0, reads = 0, corrections = 0
  const p = defineLaneProgram({ id: 'reuse-read-loop', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'Read two sources', toolAllow: ['fs.read'], reuseSettledEvidence: true, maxTurns: 16, onFinish: () => ({ complete: {} }) }))
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') { reads++; const a = (e.input as any).arguments; return { value: { path: a.path, offset: 0, hash: a.path, content: 'evidence', truncated: false } } }
    models++; if (JSON.stringify(e.input).includes('Runtime progress correction:')) corrections++
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: models % 2 ? 'a.txt' : 'b.txt' } }] } }
  } })
  const { agentId } = r.createAgent('Inspect sources', p)
  expect(await r.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
  expect(reads).toBe(2); expect(models).toBe(6); expect(corrections).toBe(1)
  const snapshot = r.exportPersistence(); const restored = await PulseRuntime.restore({ load: async () => snapshot, save: async () => {} }, { programs: [p] })
  expect([...restored.state.lanes.values()].map(l => l.resume.locals)).toEqual([...r.state.lanes.values()].map(l => l.resume.locals))
})
it('keeps unread pages, real edits, and their new versions executable', async () => {
  let models = 0, tools = 0, hash = 'before'
  const calls = [{ name: 'fs.read', input: { path: 'a.txt' } }, { name: 'fs.read', input: { path: 'a.txt', offset: 3 } }, { name: 'fs.write', input: { path: 'a.txt', content: 'after' } }, { name: 'fs.read', input: { path: 'a.txt' } }]
  const p = defineLaneProgram({ id: 'reuse-valid-progress', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'Read/edit', toolAllow: ['fs.read', 'fs.write'], reuseSettledEvidence: true, maxTurns: 12, onFinish: () => ({ complete: {} }) }))
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') { tools++; const i = e.input as any; if (i.name === 'fs.write') hash = 'after'; return { value: { path: 'a.txt', hash, offset: i.arguments.offset ?? 0, nextOffset: i.arguments.offset ? undefined : 3, content: 'abc', changed: i.name === 'fs.write' } } }
    const call = calls[models++]; return { value: call ? { finishReason: 'tool_calls', toolCalls: [call] } : { finishReason: 'stop', text: 'Done' } }
  } })
  const { agentId } = r.createAgent('Read/edit', p)
  expect((await r.start(agentId).outcome()).status).toBe('succeeded'); expect(tools).toBe(4)
})
it('hands the original successful check ref to acceptance with no second tool effect', async () => {
  let models = 0, tools = 0, reused: string[] = []
  const p = defineLaneProgram({ id: 'reuse-check', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'Check', toolAllow: ['shell.exec'], reuseSettledEvidence: true, onReuseEvidence: refs => { reused = refs; return { complete: { value: { evidenceRefs: refs } } } }, maxTurns: 8, onFinish: () => ({ complete: {} }) }))
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') { tools++; return { value: checkValue } }
    models++; return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--test', 'scripts/eval/config-budget.test.mjs'] } }] } }
  } })
  const { agentId } = r.createAgent('Check', p); expect((await r.start(agentId).outcome()).status).toBe('succeeded')
  expect(tools).toBe(1); expect(models).toBe(2); expect(reused).toHaveLength(1)
  expect([...r.state.effects.values()].filter(e => e.kind === 'tool')).toHaveLength(1)
})

it('carries passed check evidence into a new verify stage using a real offline Host', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path'), { tmpdir } = await import('node:os')
  const { vi } = await import('vitest'), { createLocalHost } = await import('../packages/server/src/index.js')
  const { acceptanceCriteriaFromObjective } = await import('../packages/server/src/task.js')
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-reuse-host-'))
  await writeFile(join(cwd, 'probe.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(1+1,2)")
  const objective = 'Run the local test then verify integration using its evidence; do not rewrite files.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init!.body)), blob = body.messages.findLast((m: any) => m.name === 'instruction')?.content ?? JSON.stringify(body.messages)
    if (JSON.stringify(body.messages).includes("You write Pulse's final user-facing reply")) return chat('Local checks passed.')
    const refs = body.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content)).map((r: any) => r.id)
    if (blob.includes('Pulse safety reviewer')) return chat('APPROVE')
    if (blob.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'test', kind: 'verify', goal: 'Run local tests', check: 'node --test probe.test.mjs passes', dependsOn: [], criterionIds: ids },
      { id: 'confirm', kind: 'edit', goal: '集成核查并记录证据', check: 'Existing tests passed without a new write', dependsOn: ['test'], criterionIds: ids },
    ] }))
    if (blob.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Local check passed' }))
    if (blob.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Actual current check evidence' })) }))
    work++
    return chat({ content: '', tool_calls: [{ id: `check-${work}`, function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'node', args: ['--test', 'probe.test.mjs'] }) } }] })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), logDir: join(cwd, 'logs'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: objective })
    const outcome = await run.outcome(); expect(outcome.status, JSON.stringify({ outcome, work })).toBe('succeeded'); const business = await run.taskOutcome(); expect(business, JSON.stringify(business)).toMatchObject({ status: 'accepted' })
    const snapshot = JSON.parse(await readFile(join(cwd, 'data/conversations', c.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state
    expect(snapshot.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'shell.exec')).toHaveLength(1)
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', c.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    expect(state.tasks.every((t: any) => t.status === 'passed')).toBe(true)
    expect(state.tasks.every((t: any) => t.kind === 'verify')).toBe(true)
    expect(work).toBe(3)
  } finally { await host.close(); vi.unstubAllGlobals(); await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

it('retains unselected read windows across passed stages without promoting them to acceptance', async () => {
  let id = '', workA = 0, workB = 0, reads = 0
  const p = buildTaskControllerProgram({ version: '13', system: 'test', toolNames: ['fs.read'], readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 32 })
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') { reads++; const input = (e.input as any).arguments; return { value: { path: input.path, offset: 0, hash: input.path, content: 'actual fact' } } }
    if (e.key?.startsWith('plan')) return { value: { tasks: [{ id: 'a', kind: 'analyze', goal: 'Inspect source files', check: 'Describe findings', criterionIds: ['c1'], dependsOn: [] }, { id: 'b', kind: 'analyze', goal: 'Explain b.txt', check: 'Describe the b source', criterionIds: ['c2'], dependsOn: ['a'] }] } }
    const g = globalFor(r, id), state = g.taskController, active = state.tasks.find((t: any) => t.id === state.activeId)
    if (e.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: active.evidenceRefs.slice(0, 1), note: 'Requested findings delivered' } }
    if (e.key?.startsWith('verify-task')) return { value: { criteria: state.tasks.map((t: any, i: number) => ({ criterionId: `c${i + 1}`, status: 'passed', evidenceRefs: t.evidenceRefs, rationale: 'Source facts' })) } }
    if (state.tasks[0].status !== 'passed') { workA++; return { value: workA === 1 ? { finishReason: 'tool_calls', toolCalls: ['a.txt', 'b.txt'].map(path => ({ name: 'fs.read', input: { path } })) } : { finishReason: 'stop', text: 'Findings' } } }
    workB++
    expect(state.tasks[0].contextRefs).toHaveLength(2); expect(state.tasks[0].evidenceRefs).toHaveLength(1)
    return { value: workB === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'b.txt' } }] } : { finishReason: 'stop', text: 'b source facts' } }
  } })
  id = r.createAgent({ goal: 'Analyze source files and explain b', program: p, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Analyze source files', acceptanceCriteria: [{ id: 'c1', description: 'Inspect sources' }, { id: 'c2', description: 'Explain b source' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect((await r.start(id).outcome()).status).toBe('succeeded'); expect(globalFor(r, id).taskOutcome.status).toBe('accepted')
  expect(reads).toBe(2); expect(workB).toBe(2)
})
