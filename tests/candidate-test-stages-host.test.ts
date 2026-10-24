import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it('extends a new candidate test across refactor stages without rebasing the caller-owned baseline', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-candidate-test-stages-'))
  const baseline = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('caller baseline', () => assert.equal(1, 1))\n"
  const first = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('candidate first case', () => assert.equal(1, 1))\n"
  const second = first.replace("import assert from 'node:assert/strict'\n", "import assert from 'node:assert/strict'\nimport { platform } from 'node:os'\n") + "test('candidate second case', () => assert.equal(typeof platform(), 'string'))\n"
  await writeFile(join(cwd, 'baseline.test.mjs'), baseline)
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const objective = 'Refactor the application and run all tests with zero regressions.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let stage = 0
  const turns = [0, 0, 0]
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, input: object) => chat({ content: '', tool_calls: [{ id: `call-${stage}-${turns[stage]}`, function: { name, arguments: JSON.stringify(input) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const results = request.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content))
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'create', kind: 'edit', goal: 'Create candidate.test.mjs', check: 'New candidate test passes', dependsOn: [], criterionIds: ids },
      { id: 'extend', kind: 'edit', goal: 'Extend candidate.test.mjs', check: 'Both candidate cases pass', dependsOn: ['create'], criterionIds: ids },
      { id: 'verify', kind: 'verify', goal: 'Run all tests', check: 'Existing baseline and candidate tests pass', dependsOn: ['extend'], criterionIds: ids },
    ] }))
    if (text.includes('Verify ONLY the active taskController stage')) { stage++; return chat(JSON.stringify({ status: 'passed', evidenceRefs: results.map((r: any) => r.id), note: 'Stage checks passed' })) }
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: results.map((r: any) => r.id), rationale: 'All tests passed without changing the original baseline' })) }))
    const turn = ++turns[stage]!
    if (stage === 0 && turn === 1) return tool('fs_write', { path: 'candidate.test.mjs', content: first })
    if (stage === 1 && turn === 1) return tool('fs_apply_patch', { path: 'candidate.test.mjs', find: first, replace: second })
    if (stage < 2 && turn === 2) return tool('shell_exec', { command: 'node', args: ['--test', 'candidate.test.mjs'] })
    if (stage === 2 && turn === 1) return tool('shell_exec', { command: 'node', args: ['--test'] })
    return chat('Stage done.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false }, taskController: true, approvalMode: 'auto', maxModelCalls: 24, provider: { provider: 'openai-compatible', defaultModel: 'fixture' } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: 'accepted' })
    expect(stage).toBe(3)
    expect(await readFile(join(cwd, 'baseline.test.mjs'), 'utf8')).toBe(baseline)
    expect(await readFile(join(cwd, 'candidate.test.mjs'), 'utf8')).toBe(second)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
// Three real cold sandbox launches, observed at 105–146 seconds each on Windows.
}, process.platform === 'win32' ? 720_000 : 10_000)
