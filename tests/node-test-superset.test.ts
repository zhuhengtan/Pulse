import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { coversNamedNodeTests } from '../packages/server/src/task-controller/stage-checks.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
it.each([
  [['--test', 'a.test.mjs', 'b.test.mjs'], true],
  [['--test', 'b.test.mjs'], false],
  [['--test'], false],
  [['--test', '--test-name-pattern=only-one', 'a.test.mjs'], false],
  [['--test', '*.test.mjs'], false],
])('recognizes only explicit unfiltered named supersets: %j', (args, expected) => {
  expect(coversNamedNodeTests({ command: 'node', args: ['--test', 'a.test.mjs'] }, { command: 'node', args })).toBe(expected)
  expect(coversNamedNodeTests({ command: 'node', args: ['--test', 'a.test.mjs'], cwd: 'one' }, { command: 'node', args, cwd: 'two' })).toBe(false)
})

it.each([true, false])('requires the later passing suite to include every earlier failing named file (covers=%s)', async covers => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-test-superset-'))
  const objective = 'Fix feature.mjs to export value 2 and validate it with candidate tests.'
  await writeFile(join(cwd, 'feature.mjs'), 'export const value = 1\n')
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tools = (calls: Array<[string, object]>) => chat({ content: '', tool_calls: calls.map(([name, input], i) => ({ id: `call-${work}-${i}`, function: { name, arguments: JSON.stringify(input) } })) })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).filter((r: any) => r.value?.code === undefined || r.value?.code === 0).map((r: any) => r.id)
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'fix', kind: 'edit', goal: objective, check: 'Candidate tests pass', dependsOn: [], criterionIds: ids }] }))
    if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Latest suite passed' }))
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Actual updated feature and tests' })) }))
    work++
    if (work === 1) return tools([
      ['fs_write', { path: 'a.test.mjs', content: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from './feature.mjs'\ntest('value', () => assert.equal(value, 2))\n" }],
      ['fs_write', { path: 'b.test.mjs', content: "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('other', () => assert.equal(2 + 2, 4))\n" }],
    ])
    if (work === 2) return tools([['shell_exec', { command: 'node', args: ['--test', 'a.test.mjs'] }]])
    if (work === 3) return tools([['fs_apply_patch', { path: 'feature.mjs', find: 'value = 1', replace: 'value = 2' }]])
    if (work === 4) return tools([['shell_exec', { command: 'node', args: covers ? ['--test', 'a.test.mjs', 'b.test.mjs'] : ['--test', 'b.test.mjs'] }]])
    return chat('Completed with the latest actual test result.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 20 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    const outcome = await run.outcome()
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: covers ? 'accepted' : 'incomplete' })
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
