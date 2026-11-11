import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import * as adapters from '@hunterzhu/pulse-adapters'
import { fixtureNodeChecks } from './helpers/fixture-node-check.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const COUNT = 17
const names = Array.from({ length: COUNT }, (_, i) => `c${i}.test.mjs`)
const body = (i: number) => `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from './feature.mjs'\ntest('value ${i}', () => assert.equal(value, 2))\n`

async function checkExecutor(cwd: string, checks: readonly string[], argv: readonly (readonly string[])[], original: string) {
  const executor = await fixtureNodeChecks(cwd, argv, {
    'feature.mjs': [original, original.replace('value = 2', 'value = 2 // reviewed')],
    ...Object.fromEntries(checks.map(name => [name, [body(names.indexOf(name))]])),
  })
  vi.spyOn(adapters, 'runShell').mockImplementation(executor.execute)
  return executor
}
function expectChecks(executor: Awaited<ReturnType<typeof checkExecutor>>, argv: readonly (readonly string[])[]) {
  expect(executor.calls.map(call => call.args)).toEqual(argv)
  for (const call of executor.calls) {
    expect(call.pid).toBeGreaterThan(0)
    expect(call.result).toMatchObject({ code: 0, timedOut: false, aborted: false, truncated: false })
    expect(call.result!.stdout).toContain(`value ${names.indexOf(call.args.at(-1)!)}`)
  }
}

// Real Node processes exercise the Host ledger; native sandbox/receipt bridges
// remain in check-debt-handoff, evidence-freshness-host and candidate-test-script.
// Independent original checks invalidated by one later edit must all stay owed: nothing is evicted by count.
it.each([
  ['all 17 original checks rerun', names, true],
  ['only the latest 16 rerun', names.slice(1), false],
] as const)('keeps every invalidated original check owed (%s)', async (_label, rerun, accepted) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-check-capacity-'))
  const objective = 'Fix feature.mjs to keep exporting value 2 and validate it with candidate tests.'
  const original = 'export const value = 2\n'
  await writeFile(join(cwd, 'feature.mjs'), original)
  // Immutable candidate definitions exist before the run, so the model only runs, edits and reruns.
  await Promise.all(names.map((name, i) => writeFile(join(cwd, name), body(i))))
  const executor = await checkExecutor(cwd, names, names.map(name => ['--test', name]), original)
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tools = (calls: Array<[string, object]>) => chat({ content: '', tool_calls: calls.map(([name, input], i) => ({ id: `call-${work}-${i}`, function: { name, arguments: JSON.stringify(input) } })) })
  const check = (list: readonly string[]) => list.map(name => ['shell_exec', { command: 'node', args: ['--test', name] }] as [string, object])
  const turns: Array<Array<[string, object]>> = [
    check(names),
    [['fs_apply_patch', { path: 'feature.mjs', find: 'value = 2', replace: 'value = 2 // reviewed', expectedHash: createHash('sha256').update(original).digest('hex') }]],
    [],
    check(rerun),
  ]
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).filter((r: any) => r.value?.code === undefined || r.value?.code === 0).map((r: any) => r.id)
    if (request.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))) return chat('APPROVE')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'fix', kind: 'edit', goal: objective, check: 'Candidate tests pass', dependsOn: [], criterionIds: ids }] }))
    if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Latest suites passed' }))
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Actual updated feature and tests' })) }))
    // An empty turn is one real stop, so the stage verifier runs on the patched artifact before any rerun.
    if (work < turns.length) { const turn = turns[work++]!; return turn.length ? tools(turn) : chat('Patch applied; checks pending.') }
    return chat('Completed with the latest actual test results.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 1_000_000, maxOutputTokens: 4096 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 40 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    // The fixture's checks are pre-existing local scripts; any human wait (approval or question) is a failure, never auto-answered.
    const waits: unknown[] = []
    const watcher = (async () => { for await (const event of run.events) if (event.type === 'waiting') waits.push(await run.pendingInteractions()) })()
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    await watcher
    expect(waits, JSON.stringify(waits)).toEqual([])
    const task = await run.taskOutcome()
    const root = join(cwd, 'data/conversations', conv.id, 'runs', run.id)
    const controller = JSON.parse(await readFile(join(root, 'task-controller.json'), 'utf8'))
    const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).state.state
    const owed = (controller.invalidatedChecks ?? []).map((item: { key: string }) => item.key)
    // The stop after the patch made the real freshness verifier invalidate every original check identity.
    expect(owed).toHaveLength(COUNT)
    for (const name of names) expect(owed.filter((key: string) => key.includes(name))).toHaveLength(1)
    const shells = runtime.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'shell.exec').map(([, e]: any) => e)
    expect(shells.map((e: any) => e.input.arguments.args[1])).toEqual([...names, ...rerun])
    expect(shells.every((e: any) => e.state === 'succeeded' && e.input.arguments.command === 'node')).toBe(true)
    expectChecks(executor, [...names, ...rerun].map(name => ['--test', name]))

    expect(task?.status === 'accepted', JSON.stringify(task)).toBe(accepted)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 60_000)

// Controller entry: repeated unaccepted reports must not run the owed checks for the worker, nor widen budgets.
it.each([
  ['the worker never reruns an owed check', 'none'],
  ['a partial rerun clears part of the debt and recovery continues', 'partial'],
] as const)('bounds consecutive needs_work reports for owed checks (%s)', async (_label, mode) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-check-capacity-'))
  const objective = 'Fix feature.mjs to keep exporting value 2 and validate it with candidate tests.'
  const original = 'export const value = 2\n'
  const three = names.slice(0, 3)
  await writeFile(join(cwd, 'feature.mjs'), original)
  await Promise.all(three.map((name, i) => writeFile(join(cwd, name), body(i))))
  const executor = await checkExecutor(cwd, three, three.map(name => ['--test', name]), original)
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0, stageReviews = 0
  const rerun = new Set<string>()
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tools = (calls: Array<[string, object]>) => chat({ content: '', tool_calls: calls.map(([name, input], i) => ({ id: `call-${work}-${i}`, function: { name, arguments: JSON.stringify(input) } })) })
  const check = (list: readonly string[], later = false) => list.map(name => { if (later) rerun.add(name); return ['shell_exec', { command: 'node', args: ['--test', name] }] as [string, object] })
  const patch: [string, object] = ['fs_apply_patch', { path: 'feature.mjs', find: 'value = 2', replace: 'value = 2 // reviewed', expectedHash: createHash('sha256').update(original).digest('hex') }]
  const turns: Array<() => Array<[string, object]>> = mode === 'none'
    ? [() => check(three), () => [patch]]
    : [() => check(three), () => [patch], () => [], () => check([three[0]!], true), () => [], () => check(three.slice(1), true)]
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).filter((r: any) => r.value?.code === undefined || r.value?.code === 0).map((r: any) => r.id)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'fix', kind: 'edit', goal: objective, check: 'Candidate tests pass', dependsOn: [], criterionIds: ids }] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      stageReviews++
      return chat(JSON.stringify(rerun.size === 3 ? { status: 'passed', evidenceRefs: refs, note: 'Latest suites passed' } : { status: 'needs_work', correctionKind: 'verify', evidenceRefs: refs, note: 'Checks are not rerun against the patched feature' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Actual updated feature and tests' })) }))
    const turn = turns[work++]?.()
    return turn?.length ? tools(turn) : chat('Stopped without running the owed checks.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 1_000_000, maxOutputTokens: 4096 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 40 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    const waits: unknown[] = []
    const watcher = (async () => { for await (const event of run.events) if (event.type === 'waiting') waits.push(await run.pendingInteractions()) })()
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    await watcher
    expect(waits, JSON.stringify(waits)).toEqual([])
    const task = await run.taskOutcome()
    const root = join(cwd, 'data/conversations', conv.id, 'runs', run.id)
    const controller = JSON.parse(await readFile(join(root, 'task-controller.json'), 'utf8'))
    const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).state.state
    const shells = runtime.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'shell.exec').map(([, e]: any) => e.input.arguments.args[1])
    const stages = [...controller.priorTasks, ...controller.tasks]
    expect(controller.invalidatedChecks).toHaveLength(3)
    expectChecks(executor, (mode === 'none' ? three : [...three, ...three]).map(name => ['--test', name]))
    expect(controller.actualBudget.used ?? 0).toBeLessThanOrEqual(40)
    expect((await run.usage()).modelCalls).toBeLessThanOrEqual(40)
    for (const stage of stages) expect(stage.checkRerunRequests ?? 0).toBeLessThanOrEqual(2)
    if (mode === 'none') {
      expect(task?.status).not.toBe('accepted')
      expect(shells).toEqual(three)
      expect(JSON.stringify(controller)).toContain('CHECK_RERUN_REQUIRED')
      expect(stageReviews).toBeLessThanOrEqual(4)
    } else {
      expect(shells).toEqual([...three, ...three])
      expect(task?.status, JSON.stringify(task)).toBe('accepted')
    }
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 60_000)

// A legal but very long check argv must keep a short stable identity; the debt is persisted, readable, owed until really rerun.
it.each([
  ['the same long check is rerun', true],
  ['the long check is not rerun', false],
] as const)('keeps an over-long valid check owed with a bounded identity (%s)', async (_label, rerun) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-check-capacity-'))
  const objective = 'Fix feature.mjs to keep exporting value 2 and validate it with candidate tests.'
  const original = 'export const value = 2\n'
  await writeFile(join(cwd, 'feature.mjs'), original)
  await writeFile(join(cwd, 'c0.test.mjs'), body(0))
  const pattern = `value 0|${'x'.repeat(1300)}`
  const args = ['--test', `--test-name-pattern=${pattern}`, 'c0.test.mjs']
  const executor = await checkExecutor(cwd, [names[0]!], [args], original)
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tools = (name: string, input: object) => chat({ content: '', tool_calls: [{ id: `call-${work}`, function: { name, arguments: JSON.stringify(input) } }] })
  const turns: Array<[string, object] | undefined> = [
    ['shell_exec', { command: 'node', args }],
    ['fs_apply_patch', { path: 'feature.mjs', find: 'value = 2', replace: 'value = 2 // reviewed', expectedHash: createHash('sha256').update(original).digest('hex') }],
    undefined,
    ...(rerun ? [['shell_exec', { command: 'node', args }] as [string, object]] : []),
  ]
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).filter((r: any) => r.value?.code === undefined || r.value?.code === 0).map((r: any) => r.id)
    if (request.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))) return chat('APPROVE')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'fix', kind: 'edit', goal: objective, check: 'Candidate tests pass', dependsOn: [], criterionIds: ids }] }))
    if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Latest suite passed' }))
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Actual updated feature and tests' })) }))
    if (work < turns.length) { const turn = turns[work++]; return turn ? tools(...turn) : chat('Patch applied; checks pending.') }
    return chat('Completed with the latest actual test results.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 1_000_000, maxOutputTokens: 4096 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 40 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    // The long pattern is outside the automatic allowlist, so the user approves exactly this fixture's explicit local check;
    // anything else (another tool, argv or an ask question) fails the test and nothing is auto-approved by production.
    const approvals: unknown[] = []
    const watcher = (async () => { for await (const event of run.events) if (event.type === 'waiting') for (const group of await run.pendingInteractions()) {
      expect(group.kind, JSON.stringify(group)).toBe('approval')
      for (const item of group.items) {
        const tools = (item.input as any).tools as Array<{ toolName: string; input: { command: string; args: string[]; cwd?: string } }>
        expect(tools).toHaveLength(1)
        expect(tools[0]).toMatchObject({ toolName: 'shell.exec', input: { command: 'node', args } })
        if (tools[0]!.input.cwd) expect(tools[0]!.input.cwd.startsWith(cwd) || tools[0]!.input.cwd === '.').toBe(true)
        approvals.push(tools[0]!.input.args)
        await run.reply(item.effectId, { approved: true })
      }
    } })()
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    await watcher
    expect(approvals.length).toBeGreaterThanOrEqual(1)
    const root = join(cwd, 'data/conversations', conv.id, 'runs', run.id)
    const controller = JSON.parse(await readFile(join(root, 'task-controller.json'), 'utf8'))
    const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).state.state
    const owed = controller.invalidatedChecks ?? []
    // The persisted controller stays valid: the long argv is kept whole in toolArguments, only the key is bounded.
    expect(owed).toHaveLength(1)
    expect(owed[0].key.length).toBeLessThanOrEqual(1200)
    expect(owed[0].toolArguments).toEqual({ command: 'node', args })
    const shells = runtime.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'shell.exec').map(([, e]: any) => e)
    // Approval-gated attempts that never ran are not executions: count only the receipts of real runs.
    const ran = shells.filter((e: any) => e.state === 'succeeded')
    expect(ran).toHaveLength(rerun ? 2 : 1)
    expectChecks(executor, rerun ? [args, args] : [args])
    expect(ran.every((e: any) => JSON.stringify(e.input.arguments.args) === JSON.stringify(args))).toBe(true)
    expect(shells.filter((e: any) => e.state !== 'succeeded').every((e: any) => JSON.stringify(e.input.arguments.args) === JSON.stringify(args))).toBe(true)
    expect((await run.taskOutcome())?.status === 'accepted', JSON.stringify(await run.taskOutcome())).toBe(rerun)
    expect((await run.usage()).modelCalls).toBeLessThanOrEqual(40)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 60_000)
