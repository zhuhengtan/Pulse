import { describe, expect, it } from 'vitest'
import { PulseRuntime, ContextBuilder, createAgent, createRuntimeState, appendHistory, defineLaneProgram, validateStep, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { stageRequiresFileChange } from '../packages/server/src/task-controller/state.js'
import { deliveryChains, stageDelivery } from '../packages/server/src/task-controller/delivery.js'

const stage = (id: string, dependsOn: string[] = []) => ({ id, kind: 'edit' as const, goal: `Create src/${id}.txt`, check: `src/${id}.txt exists`, criterionIds: [id], dependsOn })
const globals = (tasks: ReturnType<typeof stage>[]): JsonValue => ({ taskRecord: { schemaVersion: 1, runId: 'offline', objective: 'Deliver the requested files', acceptanceCriteria: tasks.map(t => ({ id: t.id, description: t.goal })), status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } })
function rootState(r: PulseRuntime): any { const agent = [...r.state.agents.values()][0]!; return agent.globalVersions.get(agent.latestGlobalVersion) }
function activeState(r: PulseRuntime, laneId: string): any { return (r.state.lanes.get(laneId)?.context.state as any)?.taskControllerChain ?? rootState(r).taskController }
function fixture(tasks: ReturnType<typeof stage>[], retry?: string, fail?: string, pause?: string, failCheck?: string, autoCheck = false) {
  let r: PulseRuntime
  const work = new Map<string, number>(), owners = new Map<string, Set<string>>(), writes: string[] = [], inputs: any[] = []
  const program = buildTaskControllerProgram({ system: 'offline simulation', toolNames: ['fs.write', 'shell.exec', 'ask.choice'], approvalMode: 'auto', maxTurns: 128 })
  const executor = async (e: any) => {
    if (e.key?.startsWith('plan')) return { value: { tasks } }
    const state = activeState(r, e.ownerLaneId), active = state?.tasks.find((t: any) => t.id === state.activeId)
    if (e.kind === 'tool') {
      const input = e.input as any
      if (input.name === 'fs.write') { writes.push(input.arguments.path); return { value: { path: input.arguments.path, hash: active.id.padEnd(64, '0'), changed: true } } }
      return { value: { code: failCheck === active.id ? 1 : 0, stdout: failCheck === active.id ? 'test failed' : 'check passed', ...(autoCheck ? { checkReceipt: { stable: true, definitionChanged: false } } : {}) } }
    }
    if (e.key?.startsWith('verify-stage')) return { value: { status: fail === active.id ? 'blocked' : retry === active.id && active.attempts === 1 ? 'needs_work' : 'passed', correctionKind: 'verify', evidenceRefs: active.evidenceRefs, note: fail === active.id ? 'External permission denied' : retry === active.id && active.attempts === 1 ? 'Run the missing check; keep the completed file' : 'Current file/check verified' } }
    if (e.key?.startsWith('verify-task')) return { value: { criteria: rootState(r).taskController.tasks.map((t: any) => ({ criterionId: t.id, status: 'passed', evidenceRefs: t.evidenceRefs, rationale: 'Actual settled file evidence' })) } }
    if (e.key?.startsWith('progress-review')) return { value: { status: 'ready', evidenceRefs: active.evidenceRefs, note: 'Sufficient current evidence' } }
    if (!active) throw new Error(`No active stage for ${e.key}`)
    inputs.push({ stage: active.id, lane: e.ownerLaneId, inputs: e.input, history: [...r.state.lanes.get(e.ownerLaneId)!.context.history] })
    if (!owners.has(active.id)) owners.set(active.id, new Set())
    owners.get(active.id)!.add(e.ownerLaneId)
    const key = `${active.id}:${active.attempts}`, turn = (e.input as any).turn; work.set(key, (work.get(key) ?? 0) + 1)
    if (pause === active.id && turn === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'ask.choice', input: { prompt: '请选择输出格式', options: [{ label: 'Markdown', value: 'md' }, { label: '纯文本', value: 'txt' }], defaultValue: 'md' } }] } }
    if (autoCheck && active.id !== 'a' && turn === 2) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--check', `src/${active.id}.txt`] } }] } }
    return { value: turn === (pause === active.id ? 2 : 1) ? { finishReason: 'tool_calls', toolCalls: [{ name: active.attempts > 1 ? 'shell.exec' : 'fs.write', input: active.attempts > 1 ? { command: 'node', args: ['--check', `src/${active.id}.txt`] } : { path: `src/${active.id}.txt`, content: active.id } }] } : { finishReason: 'stop', text: `Stage delivered: ${active.id}` } }
  }
  r = new PulseRuntime({ builtinHumanEffects: true, effectExecutor: executor })
  const { agentId } = r.createAgent({ goal: 'Deliver files', program, initialGlobal: globals(tasks) })
  return { get r() { return r }, setRuntime(next: PulseRuntime) { r = next }, program, executor, agentId, owners, writes, inputs, work }
}

describe('v14 delivery-chain continuity', () => {
  it('partitions dependency-connected deliveries while keeping unrelated work separate', () => {
    expect(deliveryChains([stage('a'), stage('b', ['a']), stage('c'), stage('d', ['c'])])).toEqual([['a', 'b'], ['c', 'd']])
    expect(deliveryChains([stage('a'), stage('b', ['a']), stage('c', ['a']), stage('d', ['b', 'c'])])).toEqual([['a', 'b', 'c', 'd']])
  })
  it('keeps every stage and a verification-only retry on one live lane with prior history', async () => {
    const f = fixture([stage('a'), stage('b', ['a']), stage('c', ['b'])], 'b')
    expect((await f.r.start(f.agentId).outcome()).status).toBe('succeeded')
    const g = rootState(f.r)
    expect(g.taskOutcome.status, JSON.stringify({ controller: g.taskController, errors: f.r.state.events.filter(e => /control|reject/.test(e.type)) })).toBe('accepted')
    expect(new Set([...f.owners.values()].flatMap(s => [...s])).size).toBe(1)
    expect(f.r.state.lanes.size).toBe(1)
    expect(f.writes).toEqual(['src/a.txt', 'src/b.txt', 'src/c.txt'])
    expect(g.taskController.tasks.map((t: any) => t.attempts)).toEqual([1, 2, 1])
    expect(g.taskController.tasks.map((t: any) => t.candidateAttempt)).toEqual([1, 2, 1])
    expect(new Set(g.taskController.tasks.map((t: any) => t.candidateRef)).size).toBe(3)
    expect(f.inputs.find(i => i.stage === 'b')!.history.length).toBeGreaterThan(0)
    expect(f.inputs.find(i => i.stage === 'c')!.history.length).toBeGreaterThan(f.inputs.find(i => i.stage === 'b')!.history.length)
    const bFirst = f.inputs.find(i => i.stage === 'b')!.inputs as any
    expect(bFirst.inputs.results ?? []).toEqual([]) // source bodies stay in history; no duplicate dependency injection
    expect(bFirst.inputs.conversation.some((m: any) => { try { return JSON.parse(m.content).deliveries?.some((d: any) => d.version === 1 && d.stageId === 'a') } catch { return false } })).toBe(true)
    // Auxiliary compaction calls belong to the Host budget ledger, not the
    // controller's work/review counter.
    const controllerCalls = [...f.r.state.effects.values()].filter(e => e.kind === 'llm' && e.key !== '$compact-summary')
    expect(new Set(g.taskController.seenModelRefs)).toEqual(new Set(controllerCalls.map(e => e.id)))
    expect(g.taskController.usedTurns).toBe(controllerCalls.length)
  })
  it('runs two independent carriers and joins their verified receipts without losing stages', async () => {
    const f = fixture([stage('a'), stage('b', ['a']), stage('x'), stage('y', ['x'])], 'b')
    expect((await f.r.start(f.agentId).outcome()).status).toBe('succeeded')
    const g = rootState(f.r)
    expect(g.taskOutcome.status, JSON.stringify({ controller: g.taskController, errors: f.r.state.events.filter(e => /control|reject/.test(e.type)) })).toBe('accepted')
    expect([...f.owners.get('a')!]).toEqual([...f.owners.get('b')!])
    expect([...f.owners.get('x')!]).toEqual([...f.owners.get('y')!])
    expect([...f.owners.get('a')!]).not.toEqual([...f.owners.get('x')!])
    expect(f.r.state.lanes.size).toBe(3)
    expect(new Set(f.writes).size).toBe(4); expect(f.writes).toHaveLength(4)
    expect(g.taskController.tasks.every((t: any) => t.status === 'passed' && t.delivery)).toBe(true)
    expect(g.taskController.usedTurns).toBe([...f.r.state.effects.values()].filter(e => e.kind === 'llm').length)
    const childResults = [...f.r.state.results.values()].map(r => r.value as any).filter(v => v?.type === 'delivery-chain')
    expect(childResults).toHaveLength(2)
    expect(childResults.every(r => !JSON.stringify(r).includes('Stage delivered'))).toBe(true)
  })
  it('blocks successors while allowing an unrelated chain to finish', async () => {
    const f = fixture([stage('a'), stage('b', ['a']), stage('x'), stage('y', ['x'])], undefined, 'a')
    expect((await f.r.start(f.agentId).outcome()).status).toBe('succeeded')
    const g = rootState(f.r)
    expect(g.taskOutcome.status).toBe('incomplete')
    expect(g.taskController.tasks.map((t: any) => [t.id, t.status, t.attempts])).toEqual([['a', 'blocked', 1], ['b', 'blocked', 0], ['x', 'passed', 1], ['y', 'passed', 1]])
    expect(f.writes).not.toContain('src/b.txt')
  })
  it('bounds handoff bytes, exposes omission counts, and never includes file/log bodies', () => {
    const refs = Array.from({ length: 100 }, (_, i) => `result-${i}`)
    const ctx: any = { lane: { id: 'lane-1' }, results: { meta: () => ({ toolName: 'fs.read' }), read: () => ({ path: '文件/'.repeat(150), hash: 'a'.repeat(64), offset: 0, nextOffset: 3000, content: 'PRIVATE_BODY'.repeat(10000) }) } }
    const delivery = stageDelivery(ctx, { ...stage('a'), status: 'passed', attempts: 1, evidenceRefs: refs, note: 'done' })
    expect(Buffer.byteLength(JSON.stringify(delivery))).toBeLessThanOrEqual(4096)
    expect(delivery.omitted).toBe(refs.length - delivery.evidence.length)
    expect(delivery.evidence.length).toBeGreaterThan(0)
    expect(JSON.stringify(delivery)).not.toContain('PRIVATE_BODY')
  })
  it.each([false, true])('restores the same carrier at a pending question without replaying writes (parallel=%s)', async parallel => {
    const tasks = [stage('a'), stage('b', ['a']), ...(parallel ? [stage('x'), stage('y', ['x'])] : [])]
    const f = fixture(tasks, undefined, undefined, 'b')
    const first = f.r, session = first.start(f.agentId), original = session.outcome()
    await expect.poll(() => [...first.state.effects.values()].find(e => e.kind === 'human' && !e.outcome)).toBeTruthy()
    // Freeze a quiescent question checkpoint. An independent carrier may still
    // be finishing when the first question appears; those legitimate calls
    // must not race this simulated process replacement through the shared fake.
    if (parallel) await expect.poll(() => [...first.state.lanes.values()].some(lane => {
      const tasks = activeState(first, lane.id)?.tasks
      return tasks?.some((t: any) => t.id === 'x') && tasks.filter((t: any) => ['x', 'y'].includes(t.id)).every((t: any) => t.status === 'passed')
    })).toBe(true)
    const pending = [...first.state.effects.values()].find(e => e.kind === 'human' && !e.outcome)!
    const snapshot = first.exportPersistence(), laneId = pending.ownerLaneId
    const history = JSON.stringify(first.state.lanes.get(laneId)!.context.history)
    const count = f.inputs.length
    const candidates = activeState(first, laneId).tasks.map((t: any) => [t.id, t.candidateRef, t.candidateAttempt])
    const restored = new PulseRuntime({ persistence: snapshot, programs: [f.program], builtinHumanEffects: true, effectExecutor: f.executor })
    f.setRuntime(restored)
    expect(activeState(restored, laneId).tasks.map((t: any) => [t.id, t.candidateRef, t.candidateAttempt])).toEqual(candidates)
    const resumed = restored.start(f.agentId)
    try {
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(f.inputs.length).toBe(count)
      const same = restored.state.effects.get(pending.id)!
      expect(same.ownerLaneId).toBe(laneId); expect(same.input).toEqual(pending.input)
      expect(JSON.stringify(restored.state.lanes.get(laneId)!.context.history)).toBe(history)
      expect(f.writes).not.toContain('src/b.txt')
      await resumed.reply(pending.id, { value: 'md' })
      expect((await resumed.outcome()).status).toBe('succeeded')
      expect(rootState(restored).taskOutcome.status).toBe('accepted')
      expect(f.writes.filter(p => p === 'src/a.txt')).toHaveLength(1)
      expect(f.writes.filter(p => p === 'src/b.txt')).toHaveLength(1)
      expect([...f.owners.get('b')!]).toEqual([laneId])
    } finally { await session.cancel('TEST_CLEANUP'); await original }
  })
  it('exposes continuous history with explicit state isolation and without duplicate result bodies', () => {
    const state = createRuntimeState(), { agent, root } = createAgent(state, 'goal', { programId: 'test', programVersion: '1', step: 'work', locals: {} })
    agent.globalVersions.set(0, { unrelated: 'DO_NOT_INJECT_GLOBAL' })
    state.results.set('r1', { id: 'r1', value: { fact: 'UNIQUE_SOURCE_BODY' }, privacy: 'local_only', derivedFrom: [] })
    root.visibleResultRefs!.add('r1')
    root.context.state = { privateControl: 'DO_NOT_INJECT_LANE' }
    const lane = appendHistory(root, { instruction: 'source read', resultRefs: ['r1'], output: { text: 'completed', toolCalls: [], providerContinuation: { reasoningContent: 'INTERNAL_REASONING' } }, privacy: 'local_only' })
    const projection = new ContextBuilder(state).build({ agent, lane, explicitContext: true, includeLaneHistory: true, resultRefs: ['r1'], conversation: [{ role: 'user', content: 'next stage' }], instruction: 'Continue', toolSetId: 'test' })
    const text = JSON.stringify(projection.blocks)
    expect(text.split('UNIQUE_SOURCE_BODY')).toHaveLength(2)
    expect(text).not.toContain('DO_NOT_INJECT_GLOBAL'); expect(text).not.toContain('DO_NOT_INJECT_LANE'); expect(text).not.toContain('INTERNAL_REASONING')
    expect(projection.privacy).toBe('local_only')
    expect(projection.blocks.find(b => b.kind === 'results')?.content).toEqual([{ id: 'r1', fromHistory: true }])
    expect(projection.blocks.findIndex(b => b.kind === 'history')).toBeLessThan(projection.blocks.findIndex(b => b.kind === 'conversation'))
    const ordinary = new ContextBuilder(state).build({ agent, lane, explicitContext: true, instruction: 'Legacy', toolSetId: 'test' })
    expect(ordinary.blocks.find(b => b.kind === 'history')?.content).toEqual([])
  })

  it('retains completed stages and rejects a failed required check during a same-lane retry', async () => {
    const f = fixture([stage('a'), stage('b', ['a']), stage('c', ['b'])], 'b', undefined, undefined, 'b')
    expect((await f.r.start(f.agentId).outcome()).status).toBe('succeeded')
    const g = rootState(f.r)
    expect(g.taskOutcome.status).toBe('incomplete')
    expect(g.taskController.tasks.map((t: any) => t.status)).toEqual(['passed', 'blocked', 'blocked'])
    expect(f.writes).toEqual(['src/a.txt', 'src/b.txt'])
    expect(f.r.state.lanes.size).toBe(1)
  })

  it('compacts only the selected historical prefix and keeps normal history append-only', () => {
    const state = createRuntimeState(), { agent, root } = createAgent(state, 'goal', { programId: 'test', programVersion: '1', step: 'work', locals: {} })
    const first = appendHistory(root, { instruction: 'first', resultRefs: [], output: { text: 'older fact' }, privacy: 'public' })
    const second = appendHistory(first, { instruction: 'second', resultRefs: [], output: { text: 'KEEP_RECENT' }, privacy: 'public' })
    const builder = new ContextBuilder(state)
    const project = (lane: typeof root, historySeqs?: number[]) => builder.build({ agent, lane, explicitContext: true, includeLaneHistory: true, ...(historySeqs ? { historySeqs } : {}), instruction: 'Continue', toolSetId: 'test' })
    const older = project(first).blocks.find(b => b.kind === 'history')!.content as any[]
    const growing = project(second).blocks.find(b => b.kind === 'history')!.content as any[]
    expect(growing.slice(0, older.length)).toEqual(older)
    const selected = JSON.stringify(project(second, [1]).blocks)
    expect(selected).toContain('older fact'); expect(selected).not.toContain('KEEP_RECENT')
  })

  it('does not force a new write while summarizing earlier write receipts', () => {
    expect(stageRequiresFileChange('Summarize original fixture write receipts', 'Original receipts retrieved and summarized without rewriting files', 'analyze', true)).toBe(false)
    expect(stageRequiresFileChange('Summarize findings and update docs/result.md', 'Saved result', 'edit', true)).toBe(true)
    expect(stageRequiresFileChange('汇总结果并保存到 docs/result.md', '文件已保存', 'edit', true)).toBe(true)
  })

  it('coalesces checkpoint/handler lane assignments while preserving raw global conflicts', async () => {
    const p = defineLaneProgram({ id: 'checkpoint-assign', version: '1' }, b => {
      b.beforeStep(ctx => { ctx.mutateLane((s: any) => { s.marker = 'checkpoint' }); return undefined })
      b.addStep('finish', ctx => { ctx.mutateLane((s: any) => { s.marker = 'final' }); return { next: { complete: { value: 'done' } } } })
    })
    const r = new PulseRuntime(), { agentId, laneId } = r.createAgent('checkpoint', p)
    expect((await r.start(agentId).outcome()).status).toBe('succeeded')
    expect(r.state.lanes.get(laneId)!.context.state).toEqual({ marker: 'final' })
    const raw = defineLaneProgram({ id: 'raw-global-conflict', version: '1' }, b => b.addStep('work', ctx => {
      ctx.commitGlobal({ ops: [{ op: 'set', path: ['x'], value: 1 }, { op: 'set', path: ['x'], value: 2 }] })
      return { next: { complete: { value: null } } }
    }))
    const state = createRuntimeState(), { root } = createAgent(state, 'raw', { programId: raw.id, programVersion: raw.version, step: 'work', locals: {} })
    const validated = validateStep(state, root.id, raw.step({ lane: root, state, now: 0 }))
    expect('rejection' in validated && validated.rejection.code).toBe('CONTEXT_PATH_CONFLICT')
  })

})

 it('isolates candidates when later stages end on a stable check without assistant prose', async () => {
  const f = fixture([stage('a'), stage('b', ['a']), stage('c', ['b'])], undefined, undefined, undefined, undefined, true)
  const result = await f.r.start(f.agentId).outcome()
  expect(result.status).toBe('succeeded')
  const tasks = rootState(f.r).taskController.tasks
  expect(tasks.map((t: any) => t.status)).toEqual(['passed', 'passed', 'passed'])
  expect(new Set(tasks.map((t: any) => t.ownerLaneId)).size).toBe(1)
  expect(new Set(tasks.map((t: any) => t.candidateRef)).size).toBe(3)
  expect(tasks.every((t: any) => t.candidateAttempt === t.attempts)).toBe(true)
  const final = f.r.state.results.get(result.resultRef!)?.value as any
  expect(final.text.match(/Stage delivered: a/g)).toHaveLength(1)
  expect(final.text).not.toContain('Stage delivered: b')
  expect(final.text).not.toContain('Stage delivered: c')
 })
