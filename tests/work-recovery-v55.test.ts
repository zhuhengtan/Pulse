import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { PulseRuntime, VirtualClock, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { captureCheck, finishCheck } from '../packages/server/src/check-receipt.js'
import { staleFileEvidence, mismatchedArtifactChecks } from '../packages/server/src/task-controller/evidence-current.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { controllerFromGlobal, initialController } from '../packages/server/src/task-controller/state.js'
import { currentCompletionArtifacts, fallbackCompletionReply } from '../packages/server/src/completion-reply.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'pulse-work-recovery-')); dirs.push(dir); return dir }
function receipts(values: Array<{ name: string; value: any }>) {
  const runtime = new PulseRuntime()
  values.forEach(({ name, value }, i) => {
    const id = `effect-${i + 1}`, ref = `result-${i + 1}`
    runtime.state.effects.set(id, { id, kind: 'tool', input: { name }, outcome: { status: 'succeeded', resultRef: ref } } as any)
    runtime.state.results.set(ref, { id: ref, privacy: 'public', producer: { kind: 'effect', id }, derivedFrom: [], value } as any)
  })
  return runtime
}
const passed = (checkReceipt: any) => ({ code: 0, truncated: false, aborted: false, timedOut: false, checkReceipt })

it('reproduces the production old-artifact false alarm and refreshes only a current successful receipt', async () => {
  const root = await directory()
  await writeFile(join(root, 'introduction.pptx'), 'new deck')
  await writeFile(join(root, 'verify.py'), 'import sys\nopen(sys.argv[1], "rb").read()\n')
  const check = await captureCheck(root, root, 'python3', ['verify.py', 'introduction.pptx'], false, 4)
  const runtime = receipts([{ name: 'artifact.record', value: { path: 'introduction.pptx', hash: hash('old deck') } }, { name: 'shell.exec', value: passed(check) }])
  expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toEqual(['result-1'])
  expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime, undefined, [], '', true)).toEqual([])
  expect(await currentCompletionArtifacts(runtime, ['result-2', 'result-1'], root)).toEqual([{ path: join(root, 'introduction.pptx'), hash: hash('new deck') }])
  await writeFile(join(root, 'introduction.pptx'), 'external change')
  expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime, undefined, [], '', true)).toEqual(expect.arrayContaining(['result-1', 'result-2']))
})

it('binds a Python checker to its actual resolved target, including a conflicting default and ignored argv', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/work-recovery/ppt-failures.json', import.meta.url), 'utf8'))
  const root = await directory(), old = fixture.olderDeck.path, current = fixture.currentDeck.path
  await writeFile(join(root, old), '12 slides'); await writeFile(join(root, current), '27 slides')
  const source = `import sys,zipfile\nPATH = sys.argv[1] if len(sys.argv)>1 else ${JSON.stringify(old)}\nz=zipfile.ZipFile(PATH)\n`
  await writeFile(join(root, 'check_fit.py'), source)
  const before = await captureCheck(root, root, 'python3', ['check_fit.py'], false, 4)
  expect(before.readInputs).toEqual([old]); expect(before.files[old]).toBe(hash('12 slides'))
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(before) }]), [current])).toEqual(['result-1'])
  const explicit = await captureCheck(root, root, 'python3', ['check_fit.py', current], false, 4)
  expect(explicit.readInputs).toEqual([current]); expect(explicit.unresolvedInputs).toBe(false)
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(explicit) }]), [current])).toEqual([])
  await writeFile(join(root, 'check_fit.py'), `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(old)})\n`)
  const ignored = await captureCheck(root, root, 'python3', ['check_fit.py', current], false, 4)
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(ignored) }]), [current])).toEqual(['result-1'])
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(ignored) }]), [old, current])).toEqual(['result-1'])
  await writeFile(join(root, 'check_fit.py'), 'import os,zipfile\nz=zipfile.ZipFile(os.environ.get("DECK"))\n')
  const unresolved = await captureCheck(root, root, 'python3', ['check_fit.py', current], false, 4)
  expect(unresolved.unresolvedInputs).toBe(true)
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(unresolved) }]), [current])).toEqual(['result-1'])
})

it('rejects an unresolved document check with no document argv and still accepts a resolved source-only check', async () => {
  const root = await directory(), current = 'current.pptx'
  await writeFile(join(root, current), '27 slides')
  await writeFile(join(root, 'check_fit.py'), 'import os,zipfile\nzipfile.ZipFile(os.environ.get("DECK"))\n')
  const dynamic = await finishCheck(root, await captureCheck(root, root, 'python3', ['check_fit.py'], false, 4))
  expect(dynamic.unresolvedInputs).toBe(true)
  expect(dynamic.readInputs).toEqual([])
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(dynamic) }]), [current])).toEqual(['result-1'])
  await writeFile(join(root, 'check_src.py'), 'print("source only")\n')
  const source = await captureCheck(root, root, 'python3', ['check_src.py'], false, 4)
  expect(source.unresolvedInputs).toBe(false)
  expect(source.readInputs).toEqual([])
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(source) }]), [current])).toEqual([])
})

it('resolves aliased readers and reachable bindings without treating dead or unknown branches as reads', async () => {
  const root = await directory(), current = 'current.pptx', old = 'old.pptx'
  await writeFile(join(root, current), 'current'); await writeFile(join(root, old), 'old'); await writeFile(join(root, 'secret.pptx'), 'secret')
  const gate = async (name: string, source: string, args = [name]) => {
    await writeFile(join(root, name), source)
    const receipt = await finishCheck(root, await captureCheck(root, root, 'python3', args, false, 4))
    return { receipt, mismatch: mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(receipt) }]), [current]) }
  }
  const alias = await gate('check_alias.py', 'import zipfile as zf\nzf.ZipFile("old.pptx")\n')
  expect(alias.receipt.readInputs).toEqual([old]); expect(alias.receipt.unresolvedInputs).toBe(false); expect(alias.mismatch).toEqual(['result-1'])
  const renamed = await gate('check_renamed.py', 'from zipfile import ZipFile as Z\nZ("old.pptx")\n')
  expect(renamed.receipt.readInputs).toEqual([old]); expect(renamed.mismatch).toEqual(['result-1'])
  const pathAlias = await gate('check_path.py', 'from pathlib import Path as P\nP("old.pptx").read_bytes()\n')
  expect(pathAlias.receipt.readInputs).toEqual([old]); expect(pathAlias.receipt.unresolvedInputs).toBe(false); expect(pathAlias.mismatch).toEqual(['result-1'])
  const presentation = await gate('check_deck.py', 'from pptx import Presentation as Deck\nDeck("old.pptx")\n')
  expect(presentation.receipt.readInputs).toEqual([old]); expect(presentation.receipt.unresolvedInputs).toBe(false); expect(presentation.mismatch).toEqual(['result-1'])
  const dead = await gate('check_dead.py', 'if False:\n open("current.pptx")\nelse:\n open("old.pptx")\n')
  expect(dead.receipt.readInputs).toEqual([old]); expect(dead.receipt.unresolvedInputs).toBe(false); expect(dead.mismatch).toEqual(['result-1'])
  const rebound = await gate('check_rebind.py', 'p="old.pptx"\nif True:\n p="current.pptx"\nopen(p)\n')
  expect(rebound.receipt.readInputs).toEqual([current]); expect(rebound.receipt.unresolvedInputs).toBe(false); expect(rebound.mismatch).toEqual([])
  const unsure = await gate('check_unsure.py', 'import os\nif os.environ.get("FLAG"):\n open("current.pptx")\nelse:\n open("old.pptx")\n')
  expect(unsure.receipt.unresolvedInputs).toBe(true); expect(unsure.receipt.readInputs).not.toEqual([current, old]); expect(unsure.mismatch).toEqual(['result-1'])
  const entry = await gate('check_main.py', 'import zipfile\ndef load(path):\n zipfile.ZipFile(path)\ndef main():\n load("current.pptx")\nif __name__=="__main__":\n main()\n')
  expect(entry.receipt.readInputs).toEqual([current]); expect(entry.receipt.unresolvedInputs).toBe(false); expect(entry.mismatch).toEqual([])
  await writeFile(join(root, 'helper.py'), 'import zipfile\ndef unused():\n zipfile.ZipFile("secret.pptx")\nif __name__=="__main__":\n unused()\n')
  const imported = await gate('check_import.py', 'import helper\nprint("source only")\n')
  expect(imported.receipt.readInputs).toEqual([]); expect(imported.receipt.unresolvedInputs).toBe(false); expect(imported.mismatch).toEqual([])
  const condition = await gate('check_condition.py', 'if open("old.pptx","rb").read():\n print("checked")\n')
  expect(condition.receipt.readInputs).toEqual([old]); expect(condition.receipt.unresolvedInputs).toBe(false); expect(condition.mismatch).toEqual(['result-1'])
  const deadLoop = await gate('check_loop.py', 'while False:\n open("current.pptx","rb").read()\nopen("old.pptx","rb").read()\n')
  expect(deadLoop.receipt.readInputs).toEqual([old]); expect(deadLoop.receipt.unresolvedInputs).toBe(false); expect(deadLoop.mismatch).toEqual(['result-1'])
  const shadow = await gate('check_shadow.py', 'def open(path):\n pass\nopen("current.pptx")\n')
  expect(shadow.receipt.readInputs).toEqual([]); expect(shadow.receipt.unresolvedInputs).toBe(false); expect(shadow.mismatch).toEqual([])
  const decoded = await gate('check_decode.py', 'p="old.pptx"\nif True:\n p="current.pptx"\nprint(open(p,"rb").read().decode())\n')
  expect(decoded.receipt.readInputs).toEqual([current]); expect(decoded.receipt.unresolvedInputs).toBe(false); expect(decoded.mismatch).toEqual([])
  const source = await readFile(new URL('./fixtures/work-recovery/stdlib-zip-check.py', import.meta.url), 'utf8')
  const stdlib = await gate('check_stdlib.py', source, ['check_stdlib.py', current])
  expect(stdlib.receipt.readInputs).toEqual([current]); expect(stdlib.receipt.unresolvedInputs).toBe(false); expect(stdlib.mismatch).toEqual([])
  const deadComp = await gate('check_comp.py', '[open("current.pptx") for _ in []]\nopen("old.pptx")\n')
  expect(deadComp.receipt.readInputs).toEqual([old]); expect(deadComp.receipt.unresolvedInputs).toBe(true); expect(deadComp.mismatch).toEqual(['result-1'])
  const pathOpen = await gate('check_path_open.py', 'from pathlib import Path\nPath("old.pptx").open().read()\n')
  expect(pathOpen.receipt.readInputs).toEqual([old]); expect(pathOpen.receipt.unresolvedInputs).toBe(false); expect(pathOpen.mismatch).toEqual(['result-1'])
  const digit = await gate('check_digit.py', 'if "123".isdigit():\n open("old.pptx")\nelse:\n open("current.pptx")\n')
  expect(digit.receipt.readInputs).toEqual([old]); expect(digit.receipt.unresolvedInputs).toBe(false); expect(digit.mismatch).toEqual(['result-1'])
  const named = await gate('check_named.py', 'if (p := open("old.pptx","rb").read()):\n print("checked")\n')
  expect(named.receipt.readInputs).toEqual([old]); expect(named.receipt.unresolvedInputs).toBe(false); expect(named.mismatch).toEqual(['result-1'])
  const returned = await gate('check_return.py', 'def load():\n return\n open("current.pptx")\nload()\nopen("old.pptx")\n')
  expect(returned.receipt.readInputs).toEqual([old]); expect(returned.receipt.unresolvedInputs).toBe(false); expect(returned.mismatch).toEqual(['result-1'])
})

it('invalidates a check when an imported source or implicitly read document changes', async () => {
  const root = await directory()
  await writeFile(join(root, 'deck.py'), 'READY=True\n')
  await writeFile(join(root, 'verify.py'), 'import deck\nfrom pathlib import Path\nPath("introduction.pptx").read_bytes()\n')
  await writeFile(join(root, 'introduction.pptx'), 'current')
  const before = await captureCheck(root, root, 'python3', ['verify.py'], false, 4)
  const runtime = receipts([{ name: 'shell.exec', value: passed(before) }])
  await writeFile(join(root, 'deck.py'), 'READY=False\n')
  expect((await finishCheck(root, structuredClone(before))).stable).toBe(false)
  expect(await staleFileEvidence(root, ['result-1'], runtime, undefined, [], '', true)).toEqual(['result-1'])
  const fresh = await captureCheck(root, root, 'python3', ['verify.py'], false, 4)
  expect(await staleFileEvidence(root, ['result-1', 'result-2'], receipts([{ name: 'shell.exec', value: passed(before) }, { name: 'shell.exec', value: passed(fresh) }]), undefined, [], '', true)).toEqual([])
})

it('refreshes a bound document artifact without clearing a stale source read or a failed check', async () => {
  const root = await directory()
  await writeFile(join(root, 'feature.py'), 'NEW=True\n')
  await writeFile(join(root, 'current.pptx'), 'current deck')
  await writeFile(join(root, 'verify.py'), 'import feature\nfrom pathlib import Path\nPath("current.pptx").read_bytes()\n')
  const check = await captureCheck(root, root, 'python3', ['verify.py'], false, 4)
  expect(check.readInputs).toEqual(['current.pptx'])
  expect(check.files['feature.py']).toBe(hash('NEW=True\n'))
  const runtime = receipts([
    { name: 'fs.read', value: { path: 'feature.py', hash: hash('OLD=True\n') } },
    { name: 'artifact.record', value: { path: 'current.pptx', hash: hash('stale deck') } },
    { name: 'shell.exec', value: passed(check) },
  ])
  const stale = await staleFileEvidence(root, ['result-1', 'result-2', 'result-3'], runtime, undefined, [], '', true)
  expect(stale).toContain('result-1')
  expect(stale).not.toContain('result-2')
  const failed = receipts([
    { name: 'artifact.record', value: { path: 'current.pptx', hash: hash('stale deck') } },
    { name: 'shell.exec', value: { code: 1, truncated: false, aborted: false, timedOut: false, checkReceipt: check } },
  ])
  expect(await staleFileEvidence(root, ['result-1', 'result-2'], failed, undefined, [], '', true)).toContain('result-1')
})

it('links current artifact receipts and excludes an artifact changed after its final check', async () => {
  const root = await directory(); await writeFile(join(root, 'introduction.pptx'), 'current')
  const runtime = receipts([{ name: 'artifact.record', value: { path: 'introduction.pptx', hash: hash('current') } }])
  const files = (await currentCompletionArtifacts(runtime, ['result-1'], root)).map(artifact => artifact.path)
  const reply = fallbackCompletionReply({ presentationVersion: 2, request: '制作自我介绍PPT', status: 'accepted', files, completed: [{ goal: '阶段', text: 'I will now generate a presentation' }], pending: [], checks: [], internalIds: [] })
  expect(reply).toContain('已完成 introduction.pptx'); expect(reply).toContain(join(root, 'introduction.pptx')); expect(reply).not.toContain('I will')
  await writeFile(join(root, 'introduction.pptx'), 'changed')
  expect(await currentCompletionArtifacts(runtime, ['result-1'], root)).toEqual([])
})

it('refreshes registered deliveries from a check and does not publish comparison inputs', async () => {
  const root = await directory()
  await writeFile(join(root, 'current.pptx'), 'current deck')
  await writeFile(join(root, 'notes.pptx'), 'speaker notes')
  await writeFile(join(root, 'template.pptx'), 'old template')
  await writeFile(join(root, 'check_fit.py'), 'import zipfile\nzipfile.ZipFile("template.pptx")\nzipfile.ZipFile("current.pptx")\n')
  const check = await captureCheck(root, root, 'python3', ['check_fit.py'], false, 4)
  expect(check.readInputs).toEqual(['current.pptx', 'template.pptx'])
  expect(mismatchedArtifactChecks(root, ['result-1'], receipts([{ name: 'shell.exec', value: passed(check) }]), ['current.pptx'])).toEqual([])
  const runtime = receipts([
    { name: 'artifact.record', value: { path: 'current.pptx', hash: hash('stale deck') } },
    { name: 'artifact.record', value: { path: 'notes.pptx', hash: hash('speaker notes') } },
    { name: 'shell.exec', value: passed(check) },
  ])
  expect(await currentCompletionArtifacts(runtime, ['result-1', 'result-2', 'result-3'], root)).toEqual([
    { path: join(root, 'current.pptx'), hash: hash('current deck') },
    { path: join(root, 'notes.pptx'), hash: hash('speaker notes') },
  ])
})

it.each(['EVIDENCE_CHANGED', 'VERIFICATION_TARGET_MISMATCH'])('reopens only the affected check with durable bounds: %s', code => {
  const program = buildTaskControllerProgram({ version: '55', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 32 })
  const state = initialController(32)
  state.activeId = 'check'; state.tasks = [{ id: 'edit', kind: 'edit', goal: 'Create deck', check: 'Saved', criterionIds: ['c'], dependsOn: [], status: 'passed', attempts: 1, evidenceRefs: ['result-1'] }, { id: 'check', kind: 'verify', goal: 'Check deck', check: 'Current inputs', criterionIds: ['c'], dependsOn: ['edit'], status: 'verifying', attempts: 1, evidenceRefs: ['result-2'] }]
  const runtime = new PulseRuntime(), { laneId, agentId } = runtime.createAgent({ goal: 'Create deck', program, initialGlobal: { taskController: state } as any })
  const lane = runtime.state.lanes.get(laneId)!; lane.resume.step = 'verify-stage:decode'
  const failure = { type: 'wait', resolution: { dependencies: { review: { state: 'settled', target: { type: 'effect', id: 'review' }, outcome: { status: 'failed', error: { code, retryable: false, message: code, details: { staleRefs: ['result-2'] } } } } } } } as any
  const out = program.step({ lane, state: runtime.state, now: 0, resumeInput: failure })
  expect(out.next.step).toBe('dispatch')
  const global = (out.contextDelta as any).ops.find((op: any) => op.path[0] === 'taskController').value
  const saved = controllerFromGlobal({ taskController: global })!
  expect(saved.tasks[0].status).toBe('passed'); expect(saved.tasks[1]).toMatchObject({ status: 'pending', correctionKind: 'verify', freshnessRecoveries: 1 })
  // Schema round-trip is the state persisted in a cold Runtime snapshot.
  expect(controllerFromGlobal(JSON.parse(JSON.stringify({ taskController: saved })))?.tasks[1].freshnessRecoveries).toBe(1)
  const agent = runtime.state.agents.get(agentId)!; saved.activeId = 'check'; saved.tasks[1].status = 'verifying'; saved.tasks[1].freshnessRecoveries = 2; agent.globalVersions.set(agent.latestGlobalVersion, { taskController: saved } as any)
  const stopped = program.step({ lane, state: runtime.state, now: 0, resumeInput: failure })
  const stoppedState = (stopped.contextDelta as any).ops.find((op: any) => op.path[0] === 'taskController').value
  expect(stoppedState.tasks[1]).toMatchObject({ status: 'blocked', freshnessRecoveries: 2 })
})

it.each([true, false])('uses a focused read-only recovery without executing a truncated proposal (reasoning=%s)', async reasoningOnly => {
  let calls = 0, reads = 0, recoveries = 0
  const program = defineLaneProgram({ id: 'read-recovery', version: '1', includeLaneHistory: true }, b => b.addReActLoopStep('read', {
    instruction: 'Read the existing file only', toolAllow: ['fs.read'], maxTurns: 8, maxTruncationRetries: 2,
    reasoningRecovery: () => ++recoveries <= 2 ? 'Read one missing fact or return the existing conclusion. Never edit.' : undefined,
    onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') { reads++; return { value: { content: 'ready' } } }
    calls++
    if (calls === 2) { if (reasoningOnly) { expect((effect.input as any).includeLaneHistory).toBeUndefined(); expect((effect.input as any).requirements.reasoningEffort).toBe('low') } expect(JSON.stringify(effect.input)).not.toContain('ONE minimal fs.apply_patch'); expect(JSON.stringify(effect.input)).not.toContain('Split large') }
    return { value: calls === 1 ? { text: reasoningOnly ? '' : 'Partial conclusion', finishReason: 'length', toolCalls: [], usage: { outputTokens: 16384, reasoningTokens: reasoningOnly ? 16384 : 0 } } : calls === 2 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'deck.py' } }] } : { text: 'Existing file checked', finishReason: 'stop' } }
  } })
  expect((await runtime.start(runtime.createAgent('Read only', program).agentId).outcome()).status).toBe('succeeded')
  expect(reads).toBe(1); expect(recoveries).toBe(reasoningOnly ? 1 : 0)
})

it('retains the per-stage reasoning recovery count across a cold snapshot and stops at two', () => {
  const program = buildTaskControllerProgram({ version: '55', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 32 })
  const controller = initialController(32); controller.activeId = 'inspect'
  controller.tasks = [{ id: 'inspect', kind: 'analyze', goal: '只读核查已有产物', check: '报告当前事实，不修改文件', criterionIds: ['c'], dependsOn: [], status: 'running', attempts: 1, evidenceRefs: [] }]
  let runtime = new PulseRuntime(), { laneId, agentId } = runtime.createAgent({ goal: 'Inspect only', program, initialGlobal: { taskController: controller } as any })
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ref = `truncated-${attempt}`, lane = runtime.state.lanes.get(laneId)!, agent = runtime.state.agents.get(agentId)!
    runtime.state.results.set(ref, { id: ref, value: { text: '', finishReason: 'length', toolCalls: [], usage: { outputTokens: 16384, reasoningTokens: 16384 } }, privacy: 'public', derivedFrom: [] })
    lane.visibleResultRefs?.add(ref); lane.resume.step = 'work:decode'
    const resumeInput = { type: 'wait', resolution: { dependencies: { model: { state: 'settled', target: { type: 'effect', id: `model-${attempt}` }, outcome: { status: 'succeeded', resultRef: ref } } } } } as any
    const out = program.step({ lane, state: runtime.state, now: 0, resumeInput })
    const saved = (out.contextDelta as any).ops.find((op: any) => op.path[0] === 'taskController').value
    expect(saved.tasks[0].reasoningRecoveries).toBe(Math.min(attempt, 2))
    if (attempt === 3) { expect(saved.tasks[0].status).toBe('blocked'); expect(out.actions.some((a: any) => a.type === 'submit_effects')).toBe(false); break }
    agent.globalVersions.set(agent.latestGlobalVersion, { taskController: saved } as any)
    lane.resume = { ...lane.resume, ...out.next }
    runtime = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program] })
  }
})

it('retries one same-model disconnect within the shared budget without replaying the preceding write', async () => {
  const root = await directory(); let work = 0, disconnected = false, requests = 0
  const response = (content: any) => Response.json({ choices: [{ message: typeof content === 'string' ? { content } : content, finish_reason: content.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    requests++
    const body = JSON.parse(String(init?.body)), text = currentRequestText(body.messages), refs = suppliedRequestResults(body.messages).map(r => r.id)
    if (text.includes("You write Pulse's final")) return response('File saved.')
    if (text.includes('Create an executable plan')) return response(JSON.stringify({ tasks: [{ id: 'save', kind: 'edit', goal: 'Write ready.txt', check: 'File saved', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    if (text.includes('Verify ONLY')) return response(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Saved' }))
    if (text.includes('Independently verify every ORIGINAL')) return response(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Saved' }] }))
    work++
    if (work === 1) return response({ content: '', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'ready.txt', content: 'ready' }) } }] })
    if (!disconnected) { disconnected = true; throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) }
    return response('Saved.')
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 20, provider: { provider: 'openai-compatible', baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'one-model' } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Write ready.txt containing ready' })
    expect((await run.taskOutcome())?.status).toBe('accepted')
    const snapshot = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
    const effects = snapshot.state.state.effects.map(([, effect]: any) => effect)
    expect(effects.filter((effect: any) => effect.kind === 'tool' && effect.input.name === 'fs.write')).toHaveLength(1)
    const retry = effects.find((effect: any) => effect.attemptNo === 2)
    expect(retry.retryPolicy).toMatchObject({ sameModel: true, maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 3 })
    expect((await run.usage()).modelCalls).toBe(requests)
  } finally { await host.close() }
}, 20_000)

it('really reruns a stale artifact check instead of recycling the old cached success', async () => {
  const root = await directory(), artifact = 'report.pptx'
  await writeFile(join(root, artifact), 'old bytes')
  await writeFile(join(root, 'verify.py'), 'import sys\nassert len(open(sys.argv[1],"rb").read()) > 0\nprint("verified")\n')
  let work = 0, changed = false, recheck = false
  const response = (content: any) => Response.json({ choices: [{ message: typeof content === 'string' ? { content } : content, finish_reason: content.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, args: object) => response({ content: '', tool_calls: [{ id: `call-${work}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), text = currentRequestText(body.messages), refs = suppliedRequestResults(body.messages).map(r => r.id)
    if (text.includes("You write Pulse's final")) return response('Verified report.pptx.')
    if (text.includes('Create an executable plan')) return response(JSON.stringify({ tasks: [{ id: 'check', kind: 'verify', goal: 'Inspect report.pptx', check: 'python3 verify.py report.pptx exits zero', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    if (text.includes('Verify ONLY')) return response(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Current check passed' }))
    if (text.includes('Independently verify every ORIGINAL')) {
      if (!changed) { changed = true; await writeFile(join(root, artifact), 'new bytes') }
      return response(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Checked current artifact' }] }))
    }
    work++
    if (text.includes('EVIDENCE_RECHECK') && !recheck) { recheck = true; return tool('shell_exec', { command: 'python3', args: ['verify.py', artifact] }) }
    if (work === 1) return tool('artifact_record', { path: artifact, mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
    if (work === 2) return tool('shell_exec', { command: 'python3', args: ['verify.py', artifact] })
    return response('Verified existing artifact.')
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), jarvis: { enabled: false }, approvalMode: 'ask', maxModelCalls: 32, provider: { provider: 'openai-compatible', baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Inspect existing report.pptx and verify it with verify.py.' })
    for await (const event of run.events) if (event.type === 'waiting') await run.reply(String(event.data!.effectId), { approved: true })
    expect(await run.taskOutcome(), (await run.outcome()).text).toMatchObject({ status: 'accepted' })
    const snapshot = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8'))
    const checks = snapshot.state.state.effects.map(([, e]: any) => e).filter((e: any) => e.kind === 'tool' && e.input.name === 'shell.exec' && e.outcome?.status === 'succeeded')
    expect(recheck).toBe(true); expect(checks).toHaveLength(2)
    expect(snapshot.state.state.effects.some(([, e]: any) => e.kind === 'tool' && e.input.name === 'fs.write')).toBe(false)
    expect((await run.outcome()).text).toContain(artifact)
    const registered = await host.listArtifacts(conversation.id, 'turn')
    expect(registered.find(item => item.path === artifact)?.hash).toBe(hash('new bytes'))
    expect(await host.artifactFile(conversation.id, artifact, run.id)).toMatchObject({ hash: hash('new bytes') })
    expect((await host.listArtifacts(conversation.id, 'turn')).filter(item => item.path === artifact && item.runId === run.id)).toEqual([expect.objectContaining({ hash: hash('new bytes') })])
  } finally { await host.close() }
}, 20_000)

it('defers a successor check failure without hiding it from that successor', () => {
  const program = buildTaskControllerProgram({ version: '55', system: 'test', toolNames: ['fs.read', 'shell.exec'], approvalMode: 'auto', maxTurns: 32 })
  const state = initialController(32); state.activeId = 'inventory'
  state.tasks = [
    { id: 'inventory', kind: 'verify', goal: '只读核查图片链路，列出当前缺口', check: '列出缺口清单，不做任何写入', dependsOn: [], criterionIds: ['c'], status: 'verifying', attempts: 1, evidenceRefs: ['result-1', 'result-2'] },
    { id: 'repair', kind: 'edit', goal: '修复并验收PPT', check: 'check_fit.py 必须通过', dependsOn: ['inventory'], criterionIds: ['c'], status: 'pending', attempts: 0, evidenceRefs: [] },
  ]
  const runtime = receipts([{ name: 'fs.read', value: { path: 'deck.py', content: 'Current image chain' } }, { name: 'shell.exec', value: { code: 1, stderr: 'overflow' } }])
  ;(runtime.state.effects.get('effect-2')!.input as any).arguments = { command: 'python3', args: ['check_fit.py', 'introduction.pptx'] }
  runtime.state.results.set('review', { id: 'review', value: { status: 'passed', evidenceRefs: ['result-1'], note: 'Inventory complete; layout belongs to the successor.' }, privacy: 'public', derivedFrom: [] })
  const { laneId } = runtime.createAgent({ goal: 'Fix PPT', program, initialGlobal: { taskController: state } as any })
  const lane = runtime.state.lanes.get(laneId)!; lane.resume.step = 'verify-stage:decode'
  for (const ref of ['result-1', 'result-2', 'review']) lane.visibleResultRefs?.add(ref)
  const resumeInput = { type: 'wait', resolution: { dependencies: { review: { state: 'settled', target: { type: 'effect', id: 'review' }, outcome: { status: 'succeeded', resultRef: 'review' } } } } } as any
  const result = program.step({ lane, state: runtime.state, now: 0, resumeInput })
  const saved = (result.contextDelta as any).ops.find((op: any) => op.path[0] === 'taskController').value
  expect(saved.tasks[0].status).toBe('passed')
  expect(saved.tasks[1].evidenceRefs).toContain('result-2')
})

it('rejects a write shell during read-only inventory before dispatch and still allows later edits', () => {
  const tools = ['fs.read', 'fs.write', 'shell.exec', 'artifact.record']
  const program = buildTaskControllerProgram({ version: '55', system: 'test', toolNames: tools, readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 32 })
  const writeShell = { name: 'shell.exec', input: { command: 'node', args: ['-e', 'require("fs").writeFileSync("out.txt","x")'] } }
  const proposed = (task: { id: string; kind: 'verify' | 'edit'; goal: string; check: string }, call: { name: string; input: object }) => {
    const state = initialController(32)
    state.activeId = task.id
    state.tasks = [{ ...task, criterionIds: ['c'], dependsOn: [], status: 'running', attempts: 1, evidenceRefs: [] }]
    const runtime = new PulseRuntime()
    const { laneId } = runtime.createAgent({ goal: task.goal, program, initialGlobal: { taskController: state } as any })
    const lane = runtime.state.lanes.get(laneId)!
    runtime.state.results.set('proposal-1', { id: 'proposal-1', value: { text: '', finishReason: 'tool_calls', toolCalls: [call] }, privacy: 'public', derivedFrom: [] } as any)
    lane.visibleResultRefs?.add('proposal-1')
    lane.resume.step = 'work:decode'
    const resumeInput = { type: 'wait', resolution: { dependencies: { model: { state: 'settled', target: { type: 'effect', id: 'model-1' }, outcome: { status: 'succeeded', resultRef: 'proposal-1' } } } } } as any
    const out = program.step({ lane, state: runtime.state, now: 0, resumeInput })
    return out.actions.flatMap((action: any) => action.type === 'submit_effects' ? action.effects : []).filter((effect: any) => effect.kind === 'tool')
  }
  const inventory = { id: 'inventory', kind: 'verify' as const, goal: '只读核查图片链路，列出当前缺口', check: '列出缺口清单，不做任何写入' }
  expect(proposed(inventory, writeShell)).toEqual([])
  expect(proposed(inventory, { name: 'artifact.record', input: { path: 'current.pptx' } }).map((effect: any) => effect.input.name)).toEqual(['artifact.record'])
  expect(proposed({ id: 'edit', kind: 'edit', goal: '修改并保存 deck.pptx', check: '文件已写入' }, writeShell).map((effect: any) => effect.input.name)).toEqual(['shell.exec'])
})

const retryPolicy = { maxAttempts: 3, initialBackoffMs: 1000, maxBackoffMs: 3000, backoffMultiplier: 3, sameModel: true, jitter: false, retryableCodes: ['PROVIDER_NETWORK_ERROR'] }
const flush = async (runtime: PulseRuntime) => { for (let i = 0; i < 20; i++) { await Promise.resolve(); runtime.tick() } }
it.each(['recover', 'exhaust', 'cancel', 'auth', 'budget'] as const)('persists bounded native model retries and respects stop conditions: %s', async mode => {
  let calls = 0
  const program = defineLaneProgram({ id: 'retry-native', version: '1', modelRetryPolicy: retryPolicy }, b => b.addReActLoopStep('work', { instruction: 'Inspect', maxTurns: 4, onFinish: () => ({ complete: {} }) }))
  const execute = async () => {
    calls++
    if (mode === 'recover' && calls === 3) return { value: { text: 'Done', finishReason: 'stop' } }
    return { value: null, status: 'failed' as const, executionState: 'failed' as const, error: { code: mode === 'auth' ? 'PROVIDER_HTTP_401' : mode === 'budget' ? 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' : 'PROVIDER_NETWORK_ERROR', message: 'Unavailable', retryable: true } }
  }
  const clock = new VirtualClock(), runtime = new PulseRuntime({ clock, effectExecutor: execute })
  const { agentId } = runtime.createAgent('Inspect', program)
  runtime.tick(); await flush(runtime)
  if (mode === 'auth' || mode === 'budget') { expect(calls).toBe(1); expect(runtime.state.effects.get('effect-1')?.state).toBe('failed'); return }
  expect(runtime.state.effects.get('effect-1')).toMatchObject({ state: 'retry_wait', attemptNo: 2, retryAt: 1000 })
  const restoredClock = new VirtualClock(), restored = new PulseRuntime({ clock: restoredClock, persistence: runtime.exportPersistence(), programs: [program], effectExecutor: execute })
  if (mode === 'cancel') {
    restored.cancelAgent(agentId); restoredClock.advance(10000); await flush(restored)
    expect(calls).toBe(1); expect(restored.state.agents.get(agentId)?.state).toBe('cancelled'); return
  }
  restoredClock.advance(999); await flush(restored); expect(calls).toBe(1)
  restoredClock.advance(1); await flush(restored); expect(calls).toBe(2)
  expect(restored.state.effects.get('effect-1')).toMatchObject({ state: 'retry_wait', attemptNo: 3, retryAt: 4000 })
  restoredClock.advance(3000); await flush(restored); expect(calls).toBe(3)
  expect((await restored.start(agentId).outcome()).status).toBe(mode === 'recover' ? 'succeeded' : 'failed')
})
