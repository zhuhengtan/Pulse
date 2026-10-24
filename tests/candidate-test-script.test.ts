import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { captureCheck, finishCheck, freezeCheckDefinitions } from '../packages/server/src/check-receipt.js'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { staleFileEvidence } from '../packages/server/src/task-controller/evidence-current.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { runShell } from '../packages/adapters/src/tools/shell.js'
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
  // Fixed fixture arguments only: Windows npm is a CMD shim, not a native image.
  const npmTest = () => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: root, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32' })
  try {
    await freezeCheckDefinitions(root, store, false, true, 3)
    await mkdir(join(root, 'test'))
    await writeFile(join(root, 'test/a.test.js'), "require('node:test')('real assertion', () => require('node:assert/strict').equal(1, 1))\n")
    await setScript('node --test test/')
    const before = await captureCheck(root, root, 'npm', ['test'], false, 3)
    expect(npmTest).toThrowError(expect.objectContaining({ status: 1 }))
    await finishCheck(root, before, store, true)
    await setScript('node --test test/*.test.js')
    const fresh = await captureCheck(root, root, 'npm', ['test'], false, 3)
    expect(npmTest()).toContain('real assertion')
    const receipt = await finishCheck(root, fresh, store, true)
    expect(receipt.definitionChanged).toBe(false)
    const runtime = new PulseRuntime()
    runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: receipt as any } })
    expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual([])
    await writeFile(join(root, 'test/a.test.js'), "require('node:test')('real assertion', () => require('node:assert/strict').equal(1, 2))\n")
    expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual(['result-1'])
    const failing = await captureCheck(root, root, 'npm', ['test'], false, 3)
    expect(npmTest).toThrowError(expect.objectContaining({ status: 1 }))
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
  let successfulWarning = false
  // npm emits this harmless deprecation on stderr even when the tests pass.
  await writeFile(join(cwd, '.npmrc'), 'cache-min=0\n')
  const reply = (value: any) => Response.json({ choices: [{ message: typeof value === 'string' ? { content: value } : value, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages), refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (request.messages.some((m: any) => m.content?.includes('You are the Pulse safety reviewer'))) return reply('APPROVE')
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [{ id: 'feature', kind: 'edit', goal: 'Create feature.js and candidate tests, fix the new test runner if necessary', check: 'npm test passes with real assertions', criterionIds: ids, dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active')) {
      const checks = suppliedRequestResults(request.messages).filter(r => r.value?.code === 0 && !r.value.timedOut && !r.value.aborted)
      successfulWarning ||= checks.some(r => Boolean(r.value.stderr?.trim()))
      return reply(JSON.stringify({ status: 'passed', evidenceRefs: checks.map(r => r.id), note: 'Corrected new runner exits successfully; stderr warnings do not invalidate a zero exit code.' }))
    }
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
    const checks = snapshot.results.map(([, result]: any) => result).filter((result: any) => typeof result.summary?.code === 'number').map((result: any) => ({ id: result.id, ...result.summary }))
    const input = JSON.parse(await readFile(join(runRoot, 'input.json'), 'utf8'))
    // Keep CI failures actionable without dumping inherited environment or
    // credentials. Compare PATH-based npm/Node launches with the trusted Node.
    const diagnostics = task?.status === 'accepted' ? undefined : await runShell('node', ['-e', `
      const {spawnSync}=require('node:child_process');
      const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8'});return {command,args,status:r.status,signal:r.signal,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}};
      console.log(JSON.stringify({node:process.version,execPath:process.execPath,probes:[
        run('node',['--version']),run('npm',['--version']),run('npm',['config','get','script-shell']),
        run(process.execPath,['--test','test/fixture.test.js']),run('npm',['test','--loglevel=verbose'])
      ]}));
    `], { cwd, timeoutMs: 20_000 })
    if (task?.status !== 'accepted') await cp(cwd, join(process.cwd(), '.pulse-dev/autonomy-failed-rerun-20261023', 'v52-unit-host-failure-' + Date.now()), { recursive: true })
    expect(task, JSON.stringify({ task, version: input.controllerVersion, failures, checks, diagnostics })).toMatchObject({ status: 'accepted' })
    expect(successfulWarning).toBe(true)
  } finally { await host.close(); vi.unstubAllGlobals(); await rm(cwd, { recursive: true, force: true }) }
// Two actual cold Windows sandbox launches plus bounded failure diagnostics.
}, process.platform === 'win32' ? 600_000 : 30_000)
