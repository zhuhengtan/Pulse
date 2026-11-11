import { expect, it } from 'vitest'
import { boundedCheckKey, argvCheckKey, controllerFromGlobal, initialController, mergeInvalidatedChecks, CHECK_CAPACITY_KEY, INVALIDATED_CHECK_CAPACITY } from '../packages/server/src/task-controller/state.js'
import { afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
const debt = { key: argvCheckKey('node', ['--test', 'feature.test.mjs'], '.'), toolArguments: { command: 'node', args: ['--test', 'feature.test.mjs'], cwd: '.' }, criterionIds: ['c1'], afterOrder: 1 }

// Real Host, real parallel dispatch: stage `a` runs a real check, the artifact changes during its verification, so the check
// becomes owed inside the carrier lane. The debt must come back to the parent while sibling `b` stays delivered.
it('brings a check debt created inside a parallel carrier back to the parent and keeps the sibling delivery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-check-capacity-'))
  const objective = 'Verify feature.mjs with c0.test.mjs and independently write notes.md.'
  await writeFile(join(cwd, 'feature.mjs'), 'export const value = 2\n')
  await writeFile(join(cwd, 'c0.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from './feature.mjs'\ntest('value', () => assert.equal(value, 2))\n")
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let changed = false
  const turns = new Map<string, number>()
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).filter((r: any) => r.value?.code === undefined || r.value?.code === 0).map((r: any) => r.id)
    if (request.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))) return chat('APPROVE')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'a', kind: 'verify', goal: 'Run c0.test.mjs against feature.mjs', check: 'Test passes', dependsOn: [], criterionIds: ids },
      { id: 'b', kind: 'edit', goal: 'Write notes.md', check: 'Notes saved', dependsOn: [], criterionIds: ids },
    ] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      if (!changed && text.includes('Run c0.test.mjs')) { changed = true; await writeFile(join(cwd, 'feature.mjs'), 'export const value = 2 // external\n') }
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'checked' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'checked' })) }))
    const stage = text.includes('Write notes.md') && !text.includes('Run c0.test.mjs') ? 'b' : 'a'
    const turn = (turns.get(stage) ?? 0) + 1
    turns.set(stage, turn)
    const call = (name: string, input: object) => chat({ content: '', tool_calls: [{ id: `call-${stage}-${turn}`, function: { name, arguments: JSON.stringify(input) } }] })
    if (turn === 1) return stage === 'a' ? call('shell_exec', { command: 'node', args: ['--test', 'c0.test.mjs'] }) : call('fs_write', { path: 'notes.md', content: 'notes\n' })
    return chat('Stage done.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 1_000_000, maxOutputTokens: 4096 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 40 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    const waits: unknown[] = []
    const watcher = (async () => { for await (const event of run.events) if (event.type === 'waiting') waits.push(await run.pendingInteractions()) })()
    const outcome = await run.outcome()
    await watcher
    expect(waits, JSON.stringify(waits)).toEqual([])
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    const root = join(cwd, 'data/conversations', conv.id, 'runs', run.id)
    const controller = JSON.parse(await readFile(join(root, 'task-controller.json'), 'utf8'))
    expect(controller.invalidatedChecks).toEqual([expect.objectContaining({ key: expect.stringContaining('c0.test.mjs'), criterionIds: ids, toolArguments: expect.objectContaining({ command: 'node', args: ['--test', 'c0.test.mjs'] }) })])
    expect(controller.tasks.find((t: any) => t.id === 'b')).toMatchObject({ status: 'passed' })
    expect(controller.tasks.find((t: any) => t.id === 'a')).toMatchObject({ status: 'blocked' })
    expect(await run.taskOutcome()).toMatchObject({ status: 'incomplete' })
    expect(await readFile(join(cwd, 'notes.md'), 'utf8')).toBe('notes\n')
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 60_000)

it('merges the same check across boundaries without losing a criterion or the later boundary, and fails closed at capacity', () => {
  const state = initialController(10)
  mergeInvalidatedChecks(state, [{ ...debt, criterionIds: ['c1'], afterOrder: 7 }])
  mergeInvalidatedChecks(state, [{ ...debt, criterionIds: ['c2'], afterOrder: 3 }])
  expect(state.invalidatedChecks).toEqual([{ ...debt, criterionIds: ['c1', 'c2'], afterOrder: 7 }])
  mergeInvalidatedChecks(state, [{ ...debt, criterionIds: ['c1'] }])
  expect(state.invalidatedChecks?.[0]?.afterOrder).toBe(7)
  const many = Array.from({ length: INVALIDATED_CHECK_CAPACITY + 5 }, (_, i) => ({ key: `check-${i}`, toolArguments: {}, criterionIds: ['c1'], afterOrder: i }))
  mergeInvalidatedChecks(state, many)
  mergeInvalidatedChecks(state, many)
  expect(state.invalidatedChecks).toHaveLength(INVALIDATED_CHECK_CAPACITY)
  expect(state.invalidatedChecks?.filter(item => item.key === CHECK_CAPACITY_KEY)).toHaveLength(1)
})

it('reads a persisted raw over-long check key as the same stable bounded identity', () => {
  const raw = JSON.stringify(['node --test --test-name-pattern=check|' + 'x'.repeat(1300), '.'])
  const state = initialController(10)
  state.invalidatedChecks = [{ key: raw, toolArguments: { command: 'node', args: ['--test', 'check.test.mjs'] }, criterionIds: ['c1'] }]
  const restored = controllerFromGlobal({ taskController: JSON.parse(JSON.stringify(state)) })!
  expect(raw.length).toBeGreaterThan(1200)
  expect(restored.invalidatedChecks?.[0]?.key).toBe(argvCheckKey('node', ['--test', 'check.test.mjs'], '.'))
  expect(restored.invalidatedChecks?.[0]?.key.length).toBeLessThan(100)
  expect(boundedCheckKey('short key')).toBe('short key')
})

// The real chain-start step with a valid root checkpoint: only stage `a` is delegated, yet the root's unmet check duty travels with it.
it('hands the root check debt to the carrier of a delegated delivery chain', async () => {
  const state = initialController(40)
  const stage = (id: string, kind: 'verify' | 'edit', criterionId: string) => ({ id, kind, goal: id === 'a' ? 'Inspect feature' : 'Write independent notes', check: id === 'a' ? 'Original check must be rerun' : 'Notes saved', criterionIds: [criterionId], dependsOn: [], status: 'pending' as const, attempts: 0, evidenceRefs: [] })
  state.tasks = [stage('a', 'verify', 'c1'), stage('b', 'edit', 'c2')]
  state.invalidatedChecks = [debt, { key: argvCheckKey('node', ['--test', 'other.test.mjs'], '.'), toolArguments: { command: 'node', args: ['--test', 'other.test.mjs'] }, criterionIds: ['c2'], afterOrder: 4 }]
  const program = buildTaskControllerProgram({ system: 'fixture', toolNames: [], approvalMode: 'auto', maxTurns: 40, contextProtocolVersion: 2 })
  // Run only the hand-off step; the dispatch that follows is covered by the real Host test above.
  const probe = { ...program, entry: 'chain-start', step: (ctx: any) => program.step(ctx.lane.resume.step === 'dispatch' ? { ...ctx, lane: { ...ctx.lane, resume: { ...ctx.lane.resume, step: 'report' } } } : ctx) }
  const runtime = new PulseRuntime()
  const { agentId } = runtime.createAgent({ goal: 'parallel inspection and notes', program: probe as any, initialGlobal: { taskController: state as any, taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'parallel inspection and notes', acceptanceCriteria: [{ id: 'c1', description: 'Inspect feature' }, { id: 'c2', description: 'Write notes' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } as any } })
  const lane = [...runtime.state.lanes.values()].find(l => l.agentId === agentId)!
  lane.resume.locals = { stageIds: ['a'] }
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  const carrier = (lane.context.state as any).taskControllerChain
  expect(carrier.tasks.map((t: any) => t.id)).toEqual(['a'])
  expect(carrier.invalidatedChecks).toEqual(state.invalidatedChecks)
})
