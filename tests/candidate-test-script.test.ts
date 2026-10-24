import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { captureCheck, finishCheck, freezeCheckDefinitions } from '../packages/server/src/check-receipt.js'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { staleFileEvidence } from '../packages/server/src/task-controller/evidence-current.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

it.each([
  ['legacy', 'node --test test/*.test.js', true],
  ['original', 'node --test test/*.test.js', true],
  ['restricted', 'node --test test/*.test.js', true],
  ['all', 'node --test test/*.test.js', false],
  ['explicit-all', 'node --test test/a.test.js test/b.test.js', false],
  ['subset', 'node --test test/a.test.js', true],
  ['filtered', 'node --test --test-name-pattern good test/*.test.js', true],
  ['shell', 'node --test test/*.test.js || true', true],
  ['eval', 'node -e process.exit(0)', true],
  ['outside', 'node --test ../test/*.test.js', true],
  ['absolute', 'node --test /tmp/test/*.test.js', true],
  ['implicit', 'node --test', true],
  ['recursive-unknown', 'node --test test/**/*.js', true],
] as const)('permits a new runner correction only with complete bounded coverage: %s', async (mode, script, blocked) => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-new-script-')), store = join(root, '.host')
  const setScript = (test: string) => writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test } }))
  try {
    await mkdir(join(root, 'test'))
    if (mode === 'original') await setScript('node --test test/')
    await freezeCheckDefinitions(root, store, false, mode !== 'restricted', 3)
    await setScript('node --test test/')
    for (const name of ['a', 'b']) await writeFile(join(root, `test/${name}.test.js`), "require('node:test')('good', () => require('node:assert/strict').equal(1, 1))\n")
    await finishCheck(root, await captureCheck(root, root, 'npm', ['test'], false, 3), store, mode !== 'legacy')
    await setScript(script)
    const receipt = await finishCheck(root, await captureCheck(root, root, 'npm', ['test'], false, 3), store, mode !== 'legacy')
    expect(receipt.definitionChanged).toBe(blocked)
    expect(receipt.stable).toBe(true)
    if (!blocked) expect(receipt.candidateScriptCoverage).toEqual([{ schemaVersion: 1, definition: 'package.json#scripts:test', scriptHash: receipt.definitions['package.json#scripts:test'], files: ['test/a.test.js', 'test/b.test.js'] }])
    else expect(receipt.candidateScriptCoverage).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('revalidates the corrected entrypoint and detects later external changes without waiving failed tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-real-candidate-script-')), store = join(root, '.host')
  const setScript = (test: string) => writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test } }))
  try {
    await freezeCheckDefinitions(root, store, false, true, 3)
    await mkdir(join(root, 'test'))
    await writeFile(join(root, 'test/a.test.js'), "require('node:test')('real assertion', () => require('node:assert/strict').equal(1, 1))\n")
    await setScript('node --test test/')
    const before = await captureCheck(root, root, 'npm', ['test'], false, 3)
    expect(() => execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe' })).toThrow()
    await finishCheck(root, before, store, true)
    await setScript('node --test test/*.test.js')
    const fresh = await captureCheck(root, root, 'npm', ['test'], false, 3)
    expect(execFileSync('npm', ['test'], { cwd: root, encoding: 'utf8' })).toContain('real assertion')
    const receipt = await finishCheck(root, fresh, store, true)
    expect(receipt.definitionChanged).toBe(false)
    const runtime = new PulseRuntime()
    runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: receipt as any } })
    expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual([])
    await writeFile(join(root, 'test/a.test.js'), "require('node:test')('real assertion', () => require('node:assert/strict').equal(1, 2))\n")
    expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual(['result-1'])
    const failing = await captureCheck(root, root, 'npm', ['test'], false, 3)
    expect(() => execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe' })).toThrow()
    const failureReceipt = await finishCheck(root, failing, store, true)
    expect(failureReceipt.candidateScriptCoverage?.[0]?.files).toEqual(['test/a.test.js'])
    // A valid manifest is only freshness proof; actual nonzero exit remains a failure.
    expect(failureReceipt.stable).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('runs a corrected new test script through the actual sandboxed Host before accepting', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-script-host-'))
  const objective = 'Create feature.js exporting value 2 and verify behavior with tests. Do not add dependencies.'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let work = 0
  const reply = (value: any) => Response.json({ choices: [{ message: typeof value === 'string' ? { content: value } : value, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages), refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (request.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))) return reply('APPROVE')
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [{ id: 'feature', kind: 'edit', goal: 'Create feature.js and candidate tests, fix the new test runner if necessary', check: 'npm test passes with real assertions', criterionIds: ids, dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active')) return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs.filter(ref => !suppliedRequestResults(request.messages).find(r => r.id === ref)?.value?.stderr), note: 'Corrected new runner executes the same tests.' }))
    if (text.includes('Independently verify every ORIGINAL')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Actual sandboxed successful npm test.' })) }))
    const calls = ++work === 1 ? [
      { name: 'fs_write', args: { path: 'feature.js', content: 'exports.value = 2\n' } },
      { name: 'fs_write', args: { path: 'package.json', content: '{"private":true,"scripts":{"test":"node --test test/"}}\n' } },
      { name: 'fs_write', args: { path: 'test/fixture.test.js', content: "require('node:test')('feature value', () => require('node:assert/strict').equal(require('../feature.js').value, 2))\n" } },
    ] : work === 2 || work === 4 ? [{ name: 'shell_exec', args: { command: 'npm', args: ['test'] } }]
      : work === 3 ? [{ name: 'fs_apply_patch', args: { path: 'package.json', find: 'node --test test/', replace: 'node --test test/*.test.js' } }] : []
    return calls.length ? reply({ content: '', tool_calls: calls.map((call, index) => ({ id: `fixture-${work}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) }) : reply('Fixture implementation verified.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, '.host-data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, jarvis: { enabled: false }, maxModelCalls: 32 })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: objective })
    for await (const event of run.events) if (event.type === 'waiting') await run.reply(String(event.data!.effectId), { approved: true })
    await run.outcome()
    const task = await run.taskOutcome()
    const runRoot = join(cwd, '.host-data/conversations', c.id, 'runs', run.id)
    const snapshot = JSON.parse(await readFile(join(runRoot, 'runtime.json'), 'utf8')).state.state
    const failures = snapshot.effects.filter(([, e]: any) => e.state === 'failed').map(([id, e]: any) => ({ id, input: e.input, outcome: e.outcome }))
    const input = JSON.parse(await readFile(join(runRoot, 'input.json'), 'utf8'))
    if (task?.status !== 'accepted') await cp(cwd, join(process.cwd(), '.pulse-dev/autonomy-failed-rerun-20261023', 'v52-unit-host-failure-' + Date.now()), { recursive: true })
    expect(task, JSON.stringify({ task, version: input.controllerVersion, failures })).toMatchObject({ status: 'accepted' })
  } finally { await host.close(); vi.unstubAllGlobals(); await rm(cwd, { recursive: true, force: true }) }
}, 30_000)
