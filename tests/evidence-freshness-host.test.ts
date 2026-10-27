import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'

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
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false }, approvalMode: 'auto', taskController: true, maxModelCalls: 24, provider: { provider: 'openai-compatible', defaultModel: 'fixture' } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: external ? 'incomplete' : 'accepted' })
    expect(stage).toBe(2)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
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
    expect(await run.taskOutcome()).toMatchObject({ status: change === 'unchanged' ? 'accepted' : 'incomplete' })
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    if (change !== 'unchanged') expect(state.tasks[0].note).toContain('EVIDENCE_CHANGED')
    expect(plans).toBe(1); expect(work).toBe(2)
    expect(stageReviews).toBe(change === 'before-stage' ? 0 : 1)
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
    if (stage === 1 && turn === 1) return tool('fs_apply_patch', { path: 'feature.test.mjs', find: original, replace: original + "\ntest('new regression', () => assert.equal(2, 2))\n" })
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
    expect(stage).toBe(3)
    expect((await readFile(join(cwd, 'feature.test.mjs'), 'utf8')).startsWith(original)).toBe(true)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
// Three real cold Windows launches plus receipt checks and sandbox cleanup.
}, process.platform === 'win32' ? 720_000 : 10_000)
