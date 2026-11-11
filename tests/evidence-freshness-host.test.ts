import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { evidenceFreshnessTimeouts } from './helpers/evidence-freshness-timeouts.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'

const fixtureTimeouts = evidenceFreshnessTimeouts(process.platform)

afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('retains the latest dependency patch at final freshness verification (external change=%s)', async external => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-retained-patch-'))
  const objective = 'Create greeting.txt, then update its content from ready to ready now.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let stage = 0
  const turns = [0, 0]
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, input: object) => chat({ content: '', tool_calls: [{ id: `call-${stage}-${turns[stage]}`, function: { name, arguments: JSON.stringify(input) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages), results = suppliedRequestResults(request.messages)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'create', kind: 'edit', goal: 'Create greeting.txt', check: 'Saved ready', dependsOn: [], criterionIds: ids },
      { id: 'update', kind: 'edit', goal: 'Update greeting.txt', check: 'Saved ready now', dependsOn: ['create'], criterionIds: ids },
    ] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      // The new patch is retained context, not an explicit success citation.
      const refs = stage === 0 ? results.map((r: any) => r.id) : results.filter((r: any) => r.value?.content === 'ready').map((r: any) => r.id)
      stage++
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Saved' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) {
      if (external) await writeFile(join(cwd, 'greeting.txt'), 'external mutation')
      return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: results.map((r: any) => r.id), rationale: 'Saved ready now' })) }))
    }
    const turn = ++turns[stage]!
    if (stage === 0 && turn === 1) return tool('fs_write', { path: 'greeting.txt', content: 'ready' })
    if (stage === 1 && turn === 1) return tool('fs_read', { path: 'greeting.txt' })
    if (stage === 1 && turn === 2) return tool('fs_apply_patch', { path: 'greeting.txt', find: 'ready', replace: 'ready now' })
    return chat('Saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false }, approvalMode: 'auto', taskController: true, maxModelCalls: 24, provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 256000 } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    // Repeated synthetic invalidation can cross the normal history boundary.
    // Explicitly answer only this fixture's capacity question; production keeps
    // requiring a user decision, and the reliability ledger survives compaction.
    for await (const event of run.events) if (event.type === 'waiting') {
      for (const group of await run.pendingInteractions()) for (const item of group.items) {
        expect(item.input.prompt).toBe('已达到本轮上下文容量，是否继续？')
        await run.reply(item.effectId, { value: 'continue' })
      }
    }
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: external ? 'incomplete' : 'accepted' })
    if (external) { expect(stage).toBeGreaterThanOrEqual(2); expect(stage).toBeLessThanOrEqual(24) }
    else expect(stage).toBe(2)
    const snapshot = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
    expect(snapshot.state.state.effects.filter(([,e]:any)=>e.kind==='tool' && e.input.name==='fs.write')).toHaveLength(1)
    const patches = snapshot.state.state.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'fs.apply_patch')
    expect(patches).toHaveLength(1)
    expect(patches[0][1].outcome).toMatchObject({ status: 'succeeded', resultRef: expect.any(String) })
    const patchRef = patches[0][1].outcome.resultRef
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    if (external) {
      expect(state.reliability.invalidations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'EVIDENCE_CHANGED', refs: expect.arrayContaining([patchRef]) }),
      ]))
      expect(state.reliability.excludedRefs).toContain(patchRef)
      expect(Object.values(state.reliability.freshness)).toEqual([1])
    } else {
      const update = state.tasks.find((task: any) => task.id === 'update')
      expect(update.contextRefs).toContain(patchRef)
      expect(update.evidenceRefs).not.toContain(patchRef)
      expect(state.reliability.invalidations).toEqual([])
    }
    expect((await run.usage()).modelCalls).toBeLessThanOrEqual(24)
    expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe(external ? 'external mutation' : 'ready now')
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
// Bounded 24-call invalidation recovery and durable checkpoints need a
// whole-fixture envelope; model/tool budgets and Windows defaults are unchanged.
}, fixtureTimeouts.retainedPatch)
it.each(['unchanged', 'before-stage', 'during-stage', 'during-final'])('verifies current file evidence outside pure steps (%s)', async change => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-fresh-evidence-'))
  const objective = 'Write greeting.txt and confirm it contains ready.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0, plans = 0, stageReviews = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), blob = currentRequestText(request.messages)
    if (blob.includes("You write Pulse's final user-facing reply")) return chat('Greeting saved.')
    const results = request.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content))
    if (blob.includes('Create an executable plan')) { plans++; return chat(JSON.stringify({ tasks: [{ id: 's', goal: 'Write greeting.txt', check: 'The file contains ready', dependsOn: [], criterionIds: ids }] })) }
    if (blob.includes('Verify ONLY the active taskController stage')) {
      stageReviews++
      if (change === 'during-stage') await writeFile(join(cwd, 'greeting.txt'), 'external change during stage verifier')
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: results.map((r: any) => r.id), note: 'Saved ready' }))
    }
    if (blob.includes('Independently verify every ORIGINAL')) {
      if (change === 'during-final') await writeFile(join(cwd, 'greeting.txt'), 'external change during final verifier')
      return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: results.map((r: any) => r.id), rationale: 'File exists' })) }))
    }
    work++
    if (work === 1) return chat({ content: '', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'ready' }) } }] })
    if (change === 'before-stage') await writeFile(join(cwd, 'greeting.txt'), 'external change before stage verifier')
    return chat('Greeting saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), logDir: join(cwd, 'logs'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    expect((await run.taskOutcome())?.status === 'accepted').toBe(change === 'unchanged')
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    if (change !== 'unchanged') expect(JSON.stringify(state)).toContain('EVIDENCE_CHANGED')
    expect(plans).toBeGreaterThanOrEqual(1); expect(plans).toBeLessThanOrEqual(9)
    if (change === 'unchanged') { expect(work).toBe(2); expect(stageReviews).toBe(1) }
    else {
      // v58 refreshes each unchanged stale-version set once. Repeated
      // external mutation still cannot pass or authorize replaying the edit.
      expect([...state.priorTasks, ...state.tasks].some((task: any) => task.freshnessRecoveries === 1)).toBe(true)
      expect(work).toBeGreaterThan(2); expect(work).toBeLessThanOrEqual(16)
      expect(stageReviews).toBeGreaterThanOrEqual(change === 'before-stage' ? 0 : 1); expect(stageReviews).toBeLessThanOrEqual(8)
      const snapshot = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
      expect(snapshot.state.state.effects.filter(([, e]: any) => e.kind === 'tool' && e.input.name === 'fs.write')).toHaveLength(1)
    }
    expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe(change === 'unchanged' ? 'ready' : `external change ${change === 'before-stage' ? 'before stage' : change === 'during-stage' ? 'during stage' : 'during final'} verifier`)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

it.each([
  'Add regression tests to feature.test.mjs and run all tests.',
  '确保 node --test feature.test.mjs 全部通过，并补充针对这些问题的回归断言。',
])('allows authorized test additions through stage and final verification: %s', async objective => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-staged-test-additions-'))
  const original = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('baseline', () => assert.equal(1, 1))\n"
  await writeFile(join(cwd, 'feature.test.mjs'), original)
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let stage = 0
  const turns = [0, 0, 0]
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, input: object) => chat({ content: '', tool_calls: [{ id: `call-${stage}-${turns[stage]}`, function: { name, arguments: JSON.stringify(input) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), blob = currentRequestText(request.messages)
    if (blob.includes("You write Pulse's final user-facing reply")) return chat('Greeting saved.')
    const results = request.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content))
    if (blob.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'baseline', kind: 'verify', goal: 'Run existing baseline test', check: 'Baseline test exits zero', dependsOn: [], criterionIds: ids },
      { id: 'append', kind: 'edit', goal: 'Add tests to feature.test.mjs', check: 'Preserve original test and syntax-check added tests', dependsOn: ['baseline'], criterionIds: ids },
      { id: 'behavior', kind: 'verify', goal: 'Run full tests', check: 'All tests exit zero', dependsOn: ['append'], criterionIds: ids },
    ] }))
    if (blob.includes('Verify ONLY the active taskController stage')) { stage++; return chat(JSON.stringify({ status: 'passed', evidenceRefs: results.map((r: any) => r.id), note: 'Stage check passed' })) }
    if (blob.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: results.map((r: any) => r.id), rationale: 'New tests executed' })) }))
    const turn = ++turns[stage]!
    if (stage === 0 && turn === 1 || stage === 2 && turn === 1) return tool('shell_exec', { command: 'node', args: ['--test', 'feature.test.mjs'] })
    if (stage === 1 && turn === 1) return tool('fs_apply_patch', { path: 'feature.test.mjs', find: original, replace: original + "\ntest('new regression', () => assert.equal(2, 2))\n", expectedHash: createHash('sha256').update(original).digest('hex') })
    if (stage === 1 && turn === 2) return tool('shell_exec', { command: 'node', args: ['--check', 'feature.test.mjs'] })
    return chat('Stage done.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, approvalMode: 'auto', taskController: true, maxModelCalls: 24 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    const outcome = await run.outcome()
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'succeeded' })
    const task = await run.taskOutcome()
    const diagnostics = task?.status === 'accepted' ? undefined : JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state.results.filter(([, r]: any) => r.value?.checkReceipt || typeof r.summary?.code === 'number').map(([, r]: any) => ({ id: r.id, code: r.value?.code, timedOut: r.value?.timedOut, aborted: r.value?.aborted, stdout: r.value?.stdout?.slice(-2000), stderr: r.value?.stderr?.slice(-2000), check: r.value?.checkReceipt }))
    expect(task, JSON.stringify({ text: outcome.text, stage, turns, diagnostics })).toMatchObject({ status: 'accepted' })
    // Three planned stages verify once each. The append patch makes the baseline's earlier `node --test` stale, so that owed
    // check must be rerun against the patched file and `append` is verified once more: 3 stages + 1 necessary re-verification.
    expect(stage).toBe(4)
    const root = join(cwd, 'data/conversations', conversation.id, 'runs', run.id)
    const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).state.state
    const controller = JSON.parse(await readFile(join(root, 'task-controller.json'), 'utf8'))
    expect([...controller.priorTasks, ...controller.tasks].filter((item: any) => ['baseline', 'append', 'behavior'].includes(item.id) && item.status === 'passed').map((item: any) => item.id).sort()).toEqual(['append', 'baseline', 'behavior'])
    const tools = runtime.effects.filter(([, e]: any) => e.kind === 'tool').map(([, e]: any) => e)
    const summary = tools.map((e: any) => `${e.input.name}:${e.input.arguments.args?.join(' ') ?? e.input.arguments.path}`)
    expect(summary).toEqual(['shell.exec:--test feature.test.mjs', 'fs.apply_patch:feature.test.mjs', 'shell.exec:--check feature.test.mjs', 'shell.exec:--test feature.test.mjs'])
    expect(tools.every((e: any) => e.state === 'succeeded')).toBe(true)
    expect((await run.usage()).modelCalls).toBeLessThanOrEqual(24)
    expect((await readFile(join(cwd, 'feature.test.mjs'), 'utf8')).startsWith(original)).toBe(true)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
// Three actual cold launches plus durable receipts and sandbox cleanup.
// The POSIX envelope covers the whole fixture, not each command's deadline.
}, fixtureTimeouts.testAdditions)
