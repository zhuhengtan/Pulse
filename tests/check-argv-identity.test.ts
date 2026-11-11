import { afterEach, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { argvCheckKey, controllerFromGlobal, initialController, mergeInvalidatedChecks } from '../packages/server/src/task-controller/state.js'
import { FileRuntimeContentStore, hydrateRuntimeResultBodies } from '@hunterzhu/pulse-runtime'
import * as adapters from '@hunterzhu/pulse-adapters'
import { fixtureNodeChecks } from './helpers/fixture-node-check.js'

import { namedVitestCheck } from '../packages/server/src/vitest-check.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([
  ['a different argv with the same display string', 'different', false],
  ['the original argv rerun', 'same', true],
] as const)('%s %s', async (_label, mode, accepted) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-argv-identity-'))
  const objective = 'Fix feature.mjs so value is 2 and enabled is true, and validate with candidate tests.'
  const original = 'export const value = 1; export const enabled = false\n'
  const required = "import test from 'node:test'; import assert from 'node:assert/strict'; import {value,enabled} from './feature.mjs'; test('required',()=>{assert.equal(value,2);assert.equal(enabled,true)})"
  const unrelated = "import test from 'node:test'; import assert from 'node:assert/strict';test('unrelated',()=>assert.equal(2+2,4))"
  const definitions = { 'a.test.mjs b.test.mjs': required, 'a.test.mjs': unrelated, 'b.test.mjs': unrelated }
  await writeFile(join(cwd, 'feature.mjs'), original)
  for (const [name, bytes] of Object.entries(definitions)) await writeFile(join(cwd, name), bytes)
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  // Same display string, different argv boundaries: a file name with a space is one legal file.
  const first = ['--test', 'a.test.mjs b.test.mjs'], second = ['--test', 'a.test.mjs', 'b.test.mjs']
  expect(first.join(' ')).toBe(second.join(' '))
  expect(first).not.toEqual(second)
  const chat = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  let work = 0
  const same = mode === 'same'
  const updated = same ? original.replace('value = 1; export const enabled = false', 'value = 2; export const enabled = true') : original.replace('value = 1', 'value = 2')
  // Keep the real Host policy/receipt/controller path; only repeated native ACL
  // lifecycles are separated from these ledger cases. Node receives exact argv.
  const executor = await fixtureNodeChecks(cwd, [first, second], {
    'feature.mjs': [original, updated],
    ...Object.fromEntries(Object.entries(definitions).map(([name, bytes]) => [name, [bytes]])),
  })
  vi.spyOn(adapters, 'runShell').mockImplementation(executor.execute)
  const calls = [
    ['shell_exec', { command: 'node', args: first }],
    ['fs_apply_patch', {
      path: 'feature.mjs',
      find: same ? 'value = 1; export const enabled = false' : 'value = 1',
      replace: same ? 'value = 2; export const enabled = true' : 'value = 2',
      expectedHash: createHash('sha256').update(original).digest('hex'),
    }],
    ['shell_exec', { command: 'node', args: same ? first : second }],
  ]
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).filter((r: any) => r.value?.code === undefined || r.value?.code === 0).map((r: any) => r.id)
    if (text.includes('Create an executable plan'))
      return chat(JSON.stringify({ tasks: [{ id: 'fix', kind: 'edit', goal: objective, check: 'Original candidate tests pass', dependsOn: [], criterionIds: ids }] }))
    if (text.includes('Verify ONLY the active'))
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Latest checks passed' }))
    if (text.includes('Independently verify every ORIGINAL'))
      return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Latest results' })) }))
    const call = calls[work++]
    return call ? chat({ content: '', tool_calls: [{ id: 'call-' + work, function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }) : chat('Done')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 256000 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 30, execPolicy: { rules: [first, second].map(args => ({ pattern: ['node', ...args], decision: 'prompt' as const })) } })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: objective })
    // Approve only the two exact fixture argv; anything else fails the test.
    const approvals: string[][] = []
    const watcher = (async () => {
      for await (const e of run.events) {
        if (e.type !== 'waiting') continue
        for (const group of await run.pendingInteractions()) {
          expect(group.kind).toBe('approval')
          for (const item of group.items) {
            const tools = (item.input as any).tools
            expect(tools).toHaveLength(1)
            expect(tools[0]).toMatchObject({ toolName: 'shell.exec', reviewCode: 'EXEC_POLICY_PROMPT' })
            const a = tools[0].input
            expect(a.command).toBe('node')
            expect(a.args).toEqual(approvals.length === 0 ? first : same ? first : second)
            expect(await run.reviewApproval(item.effectId)).toMatchObject({ status: 'manual', reason: 'exec_policy_prompt' })
            // No unapproved invocation has reached the real process executor.
            expect(executor.calls).toHaveLength(approvals.length)
            approvals.push(a.args)
            await run.reply(item.effectId, { approved: true })
          }
        }
      }
    })()
    // Observe both promises immediately: an approval assertion must close the
    // Host, not leave outcome waiting on the unanswered human interaction.
    const [out] = await Promise.all([run.outcome(), watcher])
    expect(out.status).toBe('succeeded')
    const expectedArgv = [first, same ? first : second]
    expect(approvals).toEqual(expectedArgv)
    expect(executor.calls.map(call => call.args)).toEqual(expectedArgv)
    expect(executor.calls.map(call => call.result?.code)).toEqual([1, 0])
    for (const call of executor.calls) {
      expect(call.pid).toBeGreaterThan(0)
      expect(call.result).toMatchObject({ aborted: false, timedOut: false, truncated: false })
    }
    expect(executor.calls[0]!.result!.stdout).toContain('required')
    expect(executor.calls[0]!.result!.stdout).toContain('ERR_ASSERTION')
    expect(executor.calls[1]!.result!.stdout).toContain(same ? 'required' : 'unrelated')
    for (const [name, bytes] of Object.entries(definitions)) expect(await readFile(join(cwd, name), 'utf8')).toBe(bytes)
    const root = join(cwd, 'data/conversations', c.id, 'runs', run.id)
    const controller = JSON.parse(await readFile(join(root, 'task-controller.json'), 'utf8'))
    const runtime = (await hydrateRuntimeResultBodies(JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')), new FileRuntimeContentStore(join(root, 'runtime-results')))).state.state
    const ran = runtime.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'shell.exec' && e.state === 'succeeded').map(([, e]: any) => e)
    expect(ran.map((e: any) => e.input.arguments.args)).toEqual(expectedArgv)
    const results = new Map(runtime.results as Array<[string, any]>)
    const receipts = ran.map((e: any) => results.get(e.outcome.resultRef)?.value?.checkReceipt)
    expect(receipts.map((receipt: any) => receipt?.args)).toEqual(expectedArgv)
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ command: 'node', cwd: '.', stable: true, definitionChanged: false })
      expect(Object.keys(receipt.definitions).length).toBeGreaterThan(0)
    }
    expect(await readFile(join(cwd, 'feature.mjs'), 'utf8')).toBe(updated)
    expect((await run.usage()).modelCalls).toBeLessThanOrEqual(30)
    if (!same) expect(controller.invalidatedChecks).toEqual(expect.arrayContaining([expect.objectContaining({ key: argvCheckKey('node', first, '.'), toolArguments: expect.objectContaining({ command: 'node', args: first }) })]))
    const status = (await run.taskOutcome())?.status
    expect(status).toBe(same ? 'accepted' : 'incomplete')
    expect(status === 'accepted', 'argv identity: ' + status + JSON.stringify(await run.taskOutcome())).toBe(accepted)
    if (!accepted) expect(await readFile(join(cwd, 'feature.mjs'), 'utf8')).toContain('enabled = false')
  } finally {
    await host.close()
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  }
}, 60000)

const read = (key: string, toolArguments: unknown) => {
  const base = initialController(10) as any
  base.invalidatedChecks = [{ key, toolArguments, criterionIds: ['c1'] }]
  return controllerFromGlobal({ taskController: JSON.parse(JSON.stringify(base)) })!.invalidatedChecks![0]!.key
}

it('normalizes persisted display and raw over-long debt keys from retained structured arguments', () => {
  const toolArguments = { command: 'node', args: ['--test', 'a.test.mjs b.test.mjs'], cwd: 'pkg' }
  const sibling = { command: 'node', args: ['--test', 'a.test.mjs', 'b.test.mjs'], cwd: 'pkg' }
  const display = JSON.stringify(['node --test a.test.mjs b.test.mjs', 'pkg'])
  const a = read(display, toolArguments), b = read(display, sibling)
  expect(a).not.toBe(b)
  expect(a.startsWith('["argv",')).toBe(true)
  expect(read('x'.repeat(150_000), { command: 'node', args: ['--test', 'y'.repeat(2000)] }).length).toBeLessThanOrEqual(1200)
  expect(read('legacy display only', {}).length).toBeLessThanOrEqual(1200)
})

// An old display key whose retained structure is an explicit named Vitest run must become the same key the live
// check identity produces from its native receipt, otherwise the exact same command could never discharge it.
it('rebuilds a legacy named Vitest debt as the current named identity', () => {
  const args = ['node_modules/vitest/vitest.mjs', 'run', 'a.test.ts']
  const live = namedVitestCheck('node', args, '.')!.key
  expect(live.startsWith('["vitest",')).toBe(true)
  const legacy = JSON.stringify(['node node_modules/vitest/vitest.mjs run a.test.ts', '.'])
  expect(read(legacy, { command: 'node', args, cwd: '.' })).toBe(live)
  // Different files stay different; an unrecoverable structure stays fail-closed (never equals a live key).
  expect(read(legacy, { command: 'node', args: ['node_modules/vitest/vitest.mjs', 'run', 'b.test.ts'], cwd: '.' })).not.toBe(live)
  expect(read(legacy, {})).toBe(legacy)
  expect(read(legacy, { command: 'node', args, cwd: '/abs' })).toBe(argvCheckKey('node', args, '/abs'))
})

it('normalizes legacy keys at the merge entry too, so root and child debts do not split', () => {
  const args = ['node_modules/vitest/vitest.mjs', 'run', 'a.test.ts']
  const legacy = JSON.stringify(['node node_modules/vitest/vitest.mjs run a.test.ts', '.'])
  const state = initialController(10)
  state.invalidatedChecks = [{ key: legacy, toolArguments: { command: 'node', args, cwd: '.' }, criterionIds: ['c1'], afterOrder: 2 }]
  mergeInvalidatedChecks(state, [{ key: namedVitestCheck('node', args, '.')!.key, toolArguments: { command: 'node', args, cwd: '.' }, criterionIds: ['c2'], afterOrder: 5 }])
  expect(state.invalidatedChecks).toHaveLength(1)
  expect(state.invalidatedChecks![0]).toMatchObject({ criterionIds: ['c1', 'c2'], afterOrder: 5 })
})
