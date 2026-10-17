import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createAgent, createRuntimeState, defineLaneProgram, PulseRuntime } from '@hunterzhu/pulse-runtime'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { createCheckpoint, validateCheckpoint, checkpointReceipt } from '../packages/server/src/task-controller/checkpoint.js'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { initialController, unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it('bounds repeated reasoning-only exhaustion at one focused retry without executing a proposal', async () => {
  let calls = 0
  const program = defineLaneProgram({ id: 'pure-truncated', version: '1' }, b => {
    b.addReActLoopStep('work', { instruction: 'Fix all original requirements', maxTurns: 20, maxTruncationRetries: 5, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async e => {
    expect(e.kind).toBe('llm'); calls++
    if (calls === 2) expect(JSON.stringify(e.input)).toContain('ONE minimal fs.apply_patch')
    return { value: { text: '', finishReason: 'length', toolCalls: [], usage: { outputTokens: 16384, reasoningTokens: 16384 } } }
  } })
  const { agentId } = runtime.createAgent('Fix all original requirements', program)
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'REASONING_OUTPUT_EXHAUSTED' } })
  expect(calls).toBe(2)
  expect([...runtime.state.effects.values()].some(e => e.kind === 'tool')).toBe(false)
})

it('allows a successful small action after reasoning-only truncation', async () => {
  let models = 0, tools = 0
  const p = defineLaneProgram({ id: 'pure-recover', version: '1' }, b => {
    b.addReActLoopStep('work', { instruction: 'Fix a file', toolAllow: ['fs.apply_patch'], maxTurns: 4, maxTruncationRetries: 2, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') { tools++; return { value: { changed: true } } }
    models++
    return { value: models === 1 ? { text: '', finishReason: 'length' } : models === 2 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'fs.apply_patch', input: { path: 'a', find: 'a', replace: 'b' } }] } : { text: 'Done', finishReason: 'stop' } }
  } })
  expect(await runtime.start(runtime.createAgent('Fix a file', p).agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(tools).toBe(1); expect(models).toBe(3)
})

it.each([false, true])('does not compact summary plus failed reasoning again; useful tools reopen compaction (%s)', useful => {
  const program = defineLaneProgram({ id: 'summary-guard', version: '1', historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 1 } }, b => b.addStep('work', () => ({ actions: [], next: 'work' })))
  const state = createRuntimeState(); const { root } = createAgent(state, 'Task', { programId: program.id, programVersion: '1', step: 'work', locals: {} })
  root.historyPressure = { historyTokens: 100, softTokens: 10, hardTokens: 200 }
  root.context.history = [{ seq: 1, instruction: '[history compacted]', resultRefs: ['summary'], privacy: 'public' }, { seq: 2, instruction: 'request', resultRefs: ['extra'], privacy: 'public' }, { seq: 3, instruction: 'recent', resultRefs: [], privacy: 'public' }]
  state.effects.set('extra-effect', { id: 'extra-effect', kind: useful ? 'tool' : 'llm', key: useful ? 'write' : 'work-turn-1' } as any)
  state.results.set('extra', { id: 'extra', value: { finishReason: 'length' }, privacy: 'public', producer: { kind: 'effect', id: 'extra-effect' }, derivedFrom: [] })
  expect(program.step({ lane: root, state, now: 0 }).next.step).toBe(useful ? '$compact:summarize' : 'work')
})

it('persists unique truncation receipts through cold restore, without resetting a legacy budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-trunc-ledger-'))
  try {
    const file = join(dir, 'ledger.json'), budget = await ModelAttemptBudget.open(file, 8)
    await budget.reserve(); await budget.recordUsage({ inputTokens: 10, outputTokens: 16, outputTruncated: true }, 'one')
    await budget.recordUsage({ inputTokens: 10, outputTokens: 16, outputTruncated: true }, 'one')
    await budget.reserve(); await budget.recordUsage({ inputTokens: 4, outputTokens: 2, outputTruncated: false }, 'two')
    const restored = await ModelAttemptBudget.open(file, 100)
    expect(restored.accounting.truncationEvents).toBe(1); expect(restored.used).toBe(2); expect(restored.limit).toBe(8)
    await writeFile(file, JSON.stringify({ schemaVersion: 1, limit: 8, used: 3 }))
    expect((await ModelAttemptBudget.open(file, 100)).accounting.truncationEvents).toBeUndefined()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('keeps unchanged filesystem facts when a shell check cannot be reused, and invalidates only changed facts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-partial-checkpoint-'))
  try {
    execFileSync('git', ['init', '-q', dir]); await writeFile(join(dir, 'a.txt'), 'actual delivery')
    const hash = createHash('sha256').update('actual delivery').digest('hex'), state = createRuntimeState(), controller = initialController(16)
    controller.tasks = [{ id: 'edit', kind: 'edit', goal: 'Deliver a file', check: 'Check behavior', criterionIds: ['c'], dependsOn: [], status: 'passed', attempts: 1, evidenceRefs: ['file', 'check'] }]
    for (const [ref, name] of [['file', 'fs.read'], ['check', 'shell.exec']] as const) {
      state.effects.set(ref, { id: ref, kind: 'tool', input: { name, arguments: {} }, outcome: { status: 'succeeded', resultRef: ref } } as any)
      state.results.set(ref, { id: ref, privacy: 'public', producer: { kind: 'effect', id: ref }, value: ref === 'file' ? { path: 'a.txt', hash, content: 'actual delivery' } : { code: 0 }, derivedFrom: [] })
    }
    const checkpoint = (await createCheckpoint({ state }, dir, 'old', { taskRecord: { objective: 'Preserve delivery' }, taskController: controller } as any))!
    expect(checkpoint.reusableIds).toEqual([]); expect(checkpoint.facts?.[0]?.result).toMatchObject({ content: 'actual delivery' })
    expect((await validateCheckpoint(dir, checkpoint, 'Preserve delivery'))?.facts).toHaveLength(1)
    expect(checkpointReceipt(checkpoint).verification).toContain('not fresh shell')
    await writeFile(join(dir, 'a.txt'), 'changed')
    expect(await validateCheckpoint(dir, checkpoint, 'Preserve delivery')).toBeUndefined()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('reports shared independent failure once and suppresses old candidate prose on network termination', () => {
  const controller = initialController(16)
  controller.tasks = [{ id: 's', kind: 'verify', goal: 'Check delivery', check: 'Actual check', criterionIds: ['a', 'b'], dependsOn: [], status: 'blocked', attempts: 1, candidateRef: 'old', candidateAttempt: 1, evidenceRefs: [], note: 'PROVIDER_NETWORK_ERROR: TimeoutError' }]
  controller.acceptanceResults = [{ id: 'check', status: 'failed', reason: 'specific frozen assertion failed' }]
  const runtime = new PulseRuntime(), p = buildTaskControllerProgram({ system: 'x', approvalMode: 'auto', toolNames: [], maxTurns: 16 })
  const { laneId } = runtime.createAgent({ goal: 'Verify delivery', program: p, initialGlobal: { taskController: controller, taskRecord: { schemaVersion: 1, runId: 'x', objective: 'Verify delivery', status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [], acceptanceCriteria: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }], acceptanceChecks: [{ id: 'check', description: 'Actual', criterionIds: ['a', 'b'], toolName: 'verify', input: {}, expectedChecks: ['one'], covers: [] }] } } as any })
  const lane = runtime.state.lanes.get(laneId)!; lane.resume.step = 'report'
  runtime.state.results.set('old', { id: 'old', privacy: 'public', value: { text: 'STALE INTENTION I WILL READ FILES' }, derivedFrom: [] }); lane.visibleResultRefs?.add('old')
  const output = p.step({ lane, state: runtime.state, now: 0 }); const text = JSON.stringify(output.actions)
  expect(text.match(/specific frozen assertion failed/g)).toHaveLength(1)
  expect(text).not.toContain('STALE INTENTION')
})

it('attributes assertion failures only to Host-declared criteria and rejects missing scopes', async () => {
  const { validateAcceptanceChecks, assessAcceptanceValue, acceptanceFailure } = await import('../packages/server/src/task-controller/acceptance.js')
  const criteria = [{ id: 'a', description: 'Summary' }, { id: 'b', description: 'Helper' }]
  const raw = { id: 'x', description: 'Check', criterionIds: ['a', 'b'], toolName: 'check', input: {}, expectedChecks: ['summary', 'helper'], assertionCriterionIds: { summary: ['a'], helper: ['b'] } }
  const [check] = validateAcceptanceChecks([raw], criteria, ['check'])
  const result = assessAcceptanceValue(check!, { checks: [{ id: 'summary', passed: false, detail: '3 instead of 2' }, { id: 'helper', passed: true }] })
  expect(result.status).toBe('failed')
  const record = { objective: 'Summary and helper', acceptanceCriteria: criteria, acceptanceChecks: [check!] }
  expect(acceptanceFailure(record, [result], 'a')?.status).toBe('not_met')
  expect(acceptanceFailure(record, [result], 'b')).toBeUndefined()
  expect(() => validateAcceptanceChecks([{ ...raw, assertionCriterionIds: { summary: ['a'] } }], criteria, ['check'])).toThrow('ACCEPTANCE_CONTRACT_INVALID')
})

it('salvages legacy empty checkpoints from archived receipts without rewriting the historical run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-legacy-facts-'))
  execFileSync('git', ['init', '-q', dir]); await writeFile(join(dir, 'a.mjs'), 'export const delivery = "DELIVERY-V1"\n')
  const options = { cwd: dir, dataDir: join(dir, 'data'), taskController: true, jarvis: { enabled: false }, approvalMode: 'auto' as const, mockParallelPlan: { tasks: [{ id: 'read', kind: 'analyze' as const, goal: 'Read a.mjs', check: 'Actual file evidence', criterionIds: ['criterion-1'], dependsOn: [] }] }, mockToolCalls: [{ name: 'fs.read', input: { path: 'a.mjs' } }], mockAfterToolResponse: 'Source delivered' }
  let host = createLocalHost(options)
  try {
    const c = await host.createConversation(), first = await host.sendMessage(c.id, { text: 'Read a.mjs' })
    expect((await first.outcome()).status).toBe('succeeded'); const oldDir = join(dir, 'data/conversations', c.id, 'runs', first.id)
    const cp = JSON.parse(await readFile(join(oldDir, 'checkpoint.json'), 'utf8'))
    delete cp.facts; cp.reusableIds = []; cp.evidence = {}; cp.fileHashes = {}; cp.stageFileHashes = {}
    const legacy = JSON.stringify(cp); await writeFile(join(oldDir, 'checkpoint.json'), legacy)
    await host.close(); host = createLocalHost(options)
    const next = await host.sendMessage(c.id, { text: '继续', continueTask: true }); await next.outcome()
    const snapshot = JSON.parse(await readFile(join(dir, 'data/conversations', c.id, 'runs', next.id, 'runtime.json'), 'utf8'))
    const plan = snapshot.state.state.effects.map((x: any) => x[1]).find((e: any) => e.key === 'plan-llm')
    expect(JSON.stringify(plan.input)).toContain('Validated continuation filesystem facts')
    expect(JSON.stringify(plan.input)).toContain('DELIVERY-V1')
    expect(await readFile(join(oldDir, 'checkpoint.json'), 'utf8')).toBe(legacy)
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 240_000 : 15_000)

it.each(['REASONING_OUTPUT_EXHAUSTED', 'OUTPUT_TRUNCATED'])('does not reopen exhausted recovery with a reworded plan: %s', code => {
  const state = initialController(256)
  state.tasks = [{ id: 'edit', kind: 'edit', goal: 'Fix a file', check: 'Check it', criterionIds: ['c'], dependsOn: [], status: 'blocked', attempts: 4, evidenceRefs: [], note: `${code}: recovery exhausted` }]
  expect(unmetGoalCanChangeApproach(state)).toBe(false)
})

it('ignores installed node_modules links in the source stamp but rejects arbitrary links', async () => {
  const { symlink, mkdir } = await import('node:fs/promises'), { workspaceStamp } = await import('../packages/server/src/task-controller/checkpoint.js')
  const dir = await mkdtemp(join(tmpdir(), 'pulse-checkpoint-deps-'))
  try {
    execFileSync('git', ['init', '-q', dir]); await writeFile(join(dir, 'source.txt'), 'source')
    await mkdir(join(dir, 'deps')); await symlink(join(dir, 'deps'), join(dir, 'node_modules'))
    expect((await workspaceStamp(dir)).available).toBe(true)
    await symlink(join(dir, 'source.txt'), join(dir, 'arbitrary-link'))
    expect((await workspaceStamp(dir)).available).toBe(false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('continues after approving a canonical operation even when a sibling carries its error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-approved-origin-'))
  await writeFile(join(dir, 'fixture.mjs'), "console.log('SAFE SCRIPT')\n"); await writeFile(join(dir, 'fixture-two.mjs'), "console.log('SECOND SAFE SCRIPT')\n"); await writeFile(join(dir, 'a.txt'), 'source')
  const { currentRequestText, suppliedRequestResults } = await import('./helpers/provider-request.js')
  let work = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).map((r: any) => r.id)
    let content: any
    if (text.includes('Create an executable plan')) content = JSON.stringify({ tasks: [{ id: 'check', kind: 'verify', goal: 'Check fixture.mjs and read a.txt', check: 'Actual local receipt', criterionIds: ['criterion-1'], dependsOn: [] }] })
    else if (text.includes('Verify ONLY the active')) content = JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Actual check' })
    else if (text.includes('Independently verify every ORIGINAL')) content = JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Checked' }] })
    else if (++work === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'node', function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'node', args: ['fixture.mjs'] }) } }, { id: 'read', function: { name: 'fs_read', arguments: JSON.stringify({ path: 'a.txt' }) } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } })
    else if (work === 2) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'second-node', function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'node', args: ['fixture-two.mjs'] }) } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } })
    else content = 'Completed checks'
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), taskController: true, approvalMode: 'auto', jarvis: { enabled: false }, provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, maxModelCalls: 16 })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Check fixture.mjs and read a.txt' }); let approvals = 0
    for await (const event of run.events) {
      if (event.type !== 'waiting') continue
      for (const group of await run.pendingInteractions()) for (const item of group.items) {
        approvals++; const tools = item.input.tools as any[]
        expect(new Set(tools.map(t => t.toolCallId)).size).toBe(tools.length)
        // Reproduce the global guard's real inherited-error shape after the human request exists.
        const runtime = (host as any).active.get(run.id).runtime as PulseRuntime
        const origin = [...runtime.state.effects.values()].reverse().find(e => e.outcome?.error?.code === 'AI_APPROVAL_UNAVAILABLE')!
        expect(origin).toBeDefined()
        runtime.state.effects.set('inherited-sibling-' + approvals, { ...structuredClone(origin), id: 'inherited-sibling-' + approvals, input: { name: 'fs.read', arguments: { path: 'a.txt' } } })
        await run.reply(item.effectId, { approved: true })
      }
    }
    expect(approvals, JSON.stringify({ work, outcome: await run.outcome() })).toBe(2)
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    const audit = JSON.parse(await readFile(join(dir, 'data/conversations', c.id, 'runs', run.id, 'operations.json'), 'utf8'))
    expect(audit.operations.filter((e: any) => e.tool === 'shell.exec' && e.status === 'succeeded'), JSON.stringify({ audit, outcome: await run.outcome() })).toHaveLength(2)
  } finally { await host.close(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 240_000 : 15_000)

it.each([false, true])('deduplicates inherited approval cards and rejects conflicting identities (%s)', conflict => {
  const controller = initialController(16)
  controller.tasks = [{ id: 's', goal: 'Check file', check: 'Check it', criterionIds: ['c'], dependsOn: [], status: 'running', attempts: 1, evidenceRefs: [] }]; controller.activeId = 's'
  const runtime = new PulseRuntime(), p = buildTaskControllerProgram({ system: 'x', approvalMode: 'auto', toolNames: ['shell.exec'], maxTurns: 16 })
  const { laneId } = runtime.createAgent({ goal: 'Check file', program: p, initialGlobal: { taskController: controller, taskRecord: { schemaVersion: 1, runId: 'x', objective: 'Check file', status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [], acceptanceCriteria: [{ id: 'c', description: 'Check file' }] } } as any })
  const lane = runtime.state.lanes.get(laneId)!; lane.resume.step = 'work:tools'
  const dep = (id: string, file: string) => ({ state: 'settled' as const, target: { kind: 'effect' as const, id }, outcome: { status: 'failed' as const, error: { code: 'AI_APPROVAL_UNAVAILABLE', message: 'Missing reviewer', details: { manualApproval: true, toolName: 'shell.exec', toolCallId: 'manual:origin', input: { command: 'node', args: [file] } } } } })
  const output = p.step({ lane, state: runtime.state, now: 0, resumeInput: { type: 'wait', resolution: { waitId: 'w', status: 'unsatisfied', dependencies: { first: dep('first', 'a.mjs'), sibling: dep('sibling', conflict ? 'b.mjs' : 'a.mjs') } } } })
  if (conflict) { expect(output.next.step).toBe('dispatch'); expect(JSON.stringify(output.actions)).not.toContain('submit_effects') }
  else expect((output.actions[0] as any).effects[0].input.tools).toHaveLength(1)
})

it.each(['global-first', 'lane-first', 'checkpoint'])('commits global and lane updates atomically before effects (%s)', async order => {
  const p = defineLaneProgram<{ attempt: number }>({ id: 'paired-context-' + order, version: '1' }, b => {
    if (order === 'checkpoint') b.beforeStep((ctx, step) => { if (step === 'work') ctx.commitGlobal({ ops: d => { d.reviewed = true }, adoptImmediately: true }); return undefined })
    b.addStep('work', ctx => {
      if (order === 'global-first') ctx.commitGlobal({ ops: d => { d.reviewed = true }, adoptImmediately: true })
      ctx.mutateLane(d => { d.attempt++ })
      if (order === 'lane-first') ctx.commitGlobal({ ops: d => { d.reviewed = true }, adoptImmediately: true })
      return { next: 'done', actions: [] }
    })
    b.addStep('done', ctx => ({ next: { complete: { global: ctx.global, state: ctx.laneState } } }))
  })
  const rt = new PulseRuntime(); const a = rt.createAgent({ goal: 'retry', program: p, initialGlobal: { reviewed: false } })
  rt.state.lanes.get(a.laneId)!.context.state = { attempt: 1 }
  const outcome = await rt.start(a.agentId).outcome()
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'succeeded' })
  expect(rt.state.lanes.get(a.laneId)?.context.state).toEqual({ attempt: 2 })
  expect(rt.state.agents.get(a.agentId)?.globalVersions.get(1)).toEqual({ reviewed: true })
  expect([...rt.state.effects.values()]).toHaveLength(0)
})

it('rejects an invalid secondary context delta without committing the valid global update', async () => {
  const p = defineLaneProgram({ id: 'invalid-pair', version: '1' }, b => b.addStep('work', () => ({ next: { complete: {} } })))
  const rt = new PulseRuntime(); const a = rt.createAgent({ goal: 'atomic', program: p, initialGlobal: { safe: true } })
  const lane = rt.state.lanes.get(a.laneId)!
  const { validateStep } = await import('../packages/runtime/src/transitions/validate.js')
  const admitted = validateStep(rt.state, lane.id, { actions: [], next: lane.resume, contextDelta: { target: 'global', baseVersion: 0, ops: [{ op: 'set', path: ['safe'], value: false }] }, laneContextDelta: { target: 'lane', baseVersion: 99, ops: [] }, adoptCommittedContext: true })
  expect(admitted.rejection?.code).toBe('CONTEXT_VERSION_CONFLICT')
  expect(rt.state.agents.get(a.agentId)?.latestGlobalVersion).toBe(0)
})

it('bounds reasoning-heavy truncated partial tool proposals without executing them', async () => {
  let calls = 0
  const program = defineLaneProgram({ id: 'pure-truncated', version: '1' }, b => {
    b.addReActLoopStep('work', { instruction: 'Fix all original requirements', maxTurns: 20, maxTruncationRetries: 5, onFinish: () => ({ complete: {} }) })
  })
  const runtime = new PulseRuntime({ effectExecutor: async e => {
    expect(e.kind).toBe('llm'); calls++
    if (calls === 2) expect(JSON.stringify(e.input)).toContain('ONE minimal fs.apply_patch')
    return { value: { text: '', finishReason: 'length', toolCalls: [{ name: 'fs.apply_patch', input: { path: 'a', find: 'incomplete' } }], usage: { outputTokens: 16384, reasoningTokens: 16384 } } }
  } })
  const { agentId } = runtime.createAgent('Fix all original requirements', program)
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'REASONING_OUTPUT_EXHAUSTED' } })
  expect(calls).toBe(2)
  expect([...runtime.state.effects.values()].some(e => e.kind === 'tool')).toBe(false)
})


it('handles fresh human input before the automatic compaction handoff', () => {
  const p = defineLaneProgram({ id: 'compact-steer', version: '1', historyCompaction: { summarizeTask: 'summary', keepRecentRounds: 0 } }, b => {
    b.beforeStep(ctx => ctx.humanInputs?.length ? { actions: [], next: 'update' } : undefined)
    b.addStep('work', () => ({ actions: [], next: 'work' }))
    b.addStep('update', () => ({ next: { complete: {} } }))
  })
  const state = createRuntimeState(), { root } = createAgent(state, 'task', { programId: p.id, programVersion: '1', step: 'work', locals: {} })
  root.historyPressure = { historyTokens: 100, softTokens: 10, hardTokens: 200 }
  root.context.history = [{ seq: 1, instruction: 'old', resultRefs: [], privacy: 'public' }]
  expect(p.step({ lane: root, state, now: 0, humanInputs: [{ id: 'steer', agentId: root.agentId, value: { text: 'new requirement' }, status: 'consumed', receivedAt: 0 }] }).next.step).toBe('update')
})

it.each(['$compact:summarize', '$compact:decode', 'work:tools'])('retains fresh steering and requirement record at internal boundary %s', async step => {
  const controller = initialController(16)
  controller.tasks = [{ id: 'done', kind: 'edit', goal: 'Delivered', check: 'checked', criterionIds: ['a'], dependsOn: [], status: 'passed', attempts: 1, evidenceRefs: [] }]
  const p = buildTaskControllerProgram({ system: 'x', approvalMode: 'auto', toolNames: [], maxTurns: 16, modelBudgetView: () => ({ limit: 16, used: 1, workAllowed: true, verificationAllowed: true, finalAllowed: true }) })
  const rt = new PulseRuntime(), a = rt.createAgent({ goal: 'task', program: p, initialGlobal: { taskController: controller, taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'task', status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [], acceptanceCriteria: [{ id: 'a', description: 'original' }] } } as any })
  const lane = rt.state.lanes.get(a.laneId)!; lane.resume.step = step
  const output = p.step({ lane, state: rt.state, now: 0, humanInputs: [{ id: 'new-steer', agentId: a.agentId, value: { text: '新增需求：保留导出文件' }, status: 'consumed', receivedAt: 0 }] })
  expect(output.next.step).toBe('plan'); expect(output.actions).toEqual([])
  const { commitStep } = await import('../packages/runtime/src/transitions/validate.js')
  expect(commitStep(rt.state, lane.id, output).rejection).toBeUndefined()
  const agent = rt.state.agents.get(a.agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(global.taskController.seenInputIds).toContain('new-steer')
  expect(global.taskController.priorTasks.find((t: any) => t.id === 'done')?.status).toBe('passed')
  expect(global.taskRecord.acceptanceCriteria).toHaveLength(2)
  expect(global.taskRecord.acceptanceCriteria[1].description).toContain('保留导出文件')
})
