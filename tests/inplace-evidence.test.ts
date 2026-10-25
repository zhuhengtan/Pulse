import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { captureInPlace, finishInPlace, inPlaceChanges } from '../packages/server/src/task-controller/inplace-evidence.js'
import { staleFileEvidence } from '../packages/server/src/task-controller/evidence-current.js'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const success = { code: 0, timedOut: false, aborted: false, truncated: false }
afterEach(() => vi.unstubAllGlobals())
it('refreshes an intentionally repaired fixture while still rejecting a later external change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-inplace-'))
  try {
    await writeFile(join(root, 'repair.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], '{\"fixed\":true}')")
    await writeFile(join(root, 'fixture.json'), '{"fixed":false}')
    const before = await captureInPlace(root, root, process.execPath, ['repair.mjs', 'fixture.json', '--write'])
    expect(before?.entries).toHaveLength(1)
    execFileSync(process.execPath, ['repair.mjs', 'fixture.json', '--write'], { cwd: root })
    const fileChanges = await finishInPlace(root, before, success)
    expect(fileChanges?.entries[0]).toMatchObject({ path: 'fixture.json', beforeHash: hash('{"fixed":false}'), hash: hash('{"fixed":true}') })
    const runtime = new PulseRuntime()
    for (const [id, name, value] of [['1', 'fs.write', { path: 'fixture.json', hash: hash('{"fixed":false}') }], ['2', 'shell.exec', { ...success, fileChanges }]] as const) {
      runtime.state.effects.set(`effect-${id}`, { id: `effect-${id}`, kind: 'tool', input: { name }, outcome: { status: 'succeeded' } } as any)
      runtime.state.results.set(`result-${id}`, { id: `result-${id}`, producer: { kind: 'effect', id: `effect-${id}` }, value } as any)
    }
    expect(await staleFileEvidence(root, ['result-2', 'result-1'], runtime)).toEqual([])
    await writeFile(join(root, 'fixture.json'), '{"external":true}')
    expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toEqual(['result-1', 'result-2'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not mint refresh proof from failure, stdout, changed scripts, protected source or out-of-scope files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-inplace-reject-'))
  const outside = await mkdtemp(join(tmpdir(), 'pulse-inplace-outside-'))
  try {
    await writeFile(join(root, 'repair.mjs'), 'export const version=1')
    await writeFile(join(root, 'fixture.json'), '{}')
    await writeFile(join(root, 'feature.test.mjs'), 'export const test=1')
    await writeFile(join(outside, 'private.json'), '{}')
    await symlink(join(outside, 'private.json'), join(root, 'link.json'))
    expect(await captureInPlace(root, root, 'node', ['repair.mjs', 'fixture.json'])).toBeUndefined()
    expect(await captureInPlace(root, root, 'node', ['repair.mjs', 'feature.test.mjs', '--write'])).toBeUndefined()
    expect(await captureInPlace(root, root, 'node', ['repair.mjs', 'link.json', '--write'])).toBeUndefined()
    const before = await captureInPlace(root, root, 'node', ['repair.mjs', 'fixture.json', '--write'])
    expect(await finishInPlace(root, before, { ...success, code: 1 })).toBeUndefined()
    await writeFile(join(root, 'repair.mjs'), 'export const version=2')
    expect(await finishInPlace(root, before, success)).toBeUndefined()
    expect(inPlaceChanges({ ...success, stdout: JSON.stringify({ fileChanges: before }) })).toEqual([])
    expect(await readFile(join(outside, 'private.json'), 'utf8')).toBe('{}')
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

it.each([false, true])('accepts Host-observed fixture repair but rejects external mutation after the check (external=%s)', async external => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-inplace-host-'))
  await writeFile(join(root, 'repair.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], '{\"fixed\":true}')")
  await writeFile(join(root, 'verify.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('repaired fixture',()=>assert.equal(JSON.parse(readFileSync('fixture.json','utf8')).fixed,true))")
  const objective = 'Create fixture.json, repair it with node repair.mjs fixture.json --write, and verify it with node --test verify.test.mjs.'
  const ids = acceptanceCriteriaFromObjective(objective).map(criterion => criterion.id)
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  let turns = 0
  let finalReviews = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages), results = suppliedRequestResults(request.messages)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'repair', kind: 'edit', goal: 'Create, repair and verify fixture.json', check: 'Fixture fixed; named Node test passes', criterionIds: ids, dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: results.map((result: any) => result.id), note: 'Explicit fixture write and behavioral check passed' }))
    if (text.includes('Independently verify every ORIGINAL')) {
      finalReviews++
      if (external) await writeFile(join(root, 'fixture.json'), '{"external":true}')
      return chat(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: results.map((result: any) => result.id), rationale: 'Requested repair and test ran' })) }))
    }
    const calls = [
      { name: 'fs_write', input: { path: 'fixture.json', content: '{"fixed":false}' } },
      { name: 'shell_exec', input: { command: 'node', args: ['repair.mjs', 'fixture.json', '--write'] } },
      { name: 'shell_exec', input: { command: 'node', args: ['--test', 'verify.test.mjs'] } },
    ]
    const call = calls[turns++]
    return call ? chat({ content: '', tool_calls: [{ id: `call-${turns}`, function: { name: call.name, arguments: JSON.stringify(call.input) } }] }) : chat('The explicit fixture was repaired and its test passed.')
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', jarvis: { enabled: false }, taskController: true, maxModelCalls: 20 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    for await (const event of run.events) if (event.type === 'waiting') {
      const interactions = await run.pendingInteractions()
      const tools = interactions.flatMap((interaction: any) => interaction.items).find((item: any) => item.effectId === event.data!.effectId)?.input?.tools
      expect(tools).toEqual([expect.objectContaining({ toolName: 'shell.exec', input: { command: 'node', args: ['repair.mjs', 'fixture.json', '--write'] } })])
      await run.reply(String(event.data!.effectId), { approved: true })
    }
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: external ? 'incomplete' : 'accepted' })
    expect(turns).toBe(3)
    expect(finalReviews).toBe(1)
    const snapshot = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state
    expect(snapshot.results.some(([, result]: any) => (result.value ?? result.summary)?.fileChanges?.operation === 'in-place')).toBe(true)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
