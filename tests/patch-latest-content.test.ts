import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { FilesystemTool } from '../packages/adapters/src/tools/filesystem.js'
import { ExactPatchEditor, PATCH_FILE_BYTES } from '../packages/server/src/editing.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { defineLaneProgram, PulseRuntime } from '../packages/runtime/src/index.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function fixture(content = 'alpha=old\nbeta=old\n') {
  const root = await mkdtemp(join(tmpdir(), 'pulse-latest-patch-')); roots.push(root)
  await writeFile(join(root, 'a.txt'), content)
  const files = new FilesystemTool(root)
  return { root, files, baseline: content, input: { path: 'a.txt', expectedHash: sha(content), patches: [{ find: 'alpha=old', replace: 'alpha=new' }, { find: 'beta=old', replace: 'beta=new' }] }, editor: new ExactPatchEditor(files, undefined, 'normalized', 2) }
}

it('rebases the entire batch once, journals the actual bytes, and reports both versions', async () => {
  const f = await fixture(), current = '// caller change\n' + f.baseline
  await writeFile(join(f.root, 'a.txt'), current)
  const begin = vi.fn(), landed = vi.fn(); f.files.setFileJournal({ begin, landed })
  const result = await f.editor.execute(f.input)
  expect(result).toMatchObject({ changed: true, rebased: true, requestedBaseHash: sha(f.baseline), beforeHash: sha(current), hash: sha('// caller change\nalpha=new\nbeta=new\n'), replacements: 2 })
  expect(begin).toHaveBeenCalledTimes(1); expect(landed).toHaveBeenCalledTimes(1)
  expect(begin.mock.calls[0]![0].before).toEqual(Buffer.from(current))
  expect(Buffer.from(begin.mock.calls[0]![0].next).toString()).toBe('// caller change\nalpha=new\nbeta=new\n')
})

it.each([
  ['alpha=caller\nbeta=old\n', 'PATCH_CONTEXT_NOT_FOUND'],
  ['alpha=old\nalpha=old\nbeta=old\n', 'PATCH_CONTEXT_AMBIGUOUS'],
  ['alpha=new\nbeta=old\n', 'PATCH_CONTEXT_NOT_FOUND'],
])('leaves the entire file intact on a real batch conflict: %s', async (current, code) => {
  const f = await fixture(); await writeFile(join(f.root, 'a.txt'), current)
  const begin = vi.fn(); f.files.setFileJournal({ begin, landed: vi.fn() })
  await expect(f.editor.execute(f.input)).rejects.toMatchObject({ code, details: { currentHash: sha(current), suggestedRead: { path: 'a.txt', maxBytes: 3000 } } })
  expect(await f.files.read('a.txt')).toBe(current); expect(begin).not.toHaveBeenCalled()
})

it('retains overlap rejection and refuses to use all=true to resolve stale ambiguity', async () => {
  const f = await fixture('alpha=old alpha=old\n')
  await expect(f.editor.execute({ path: 'a.txt', expectedHash: sha('old baseline'), all: true, patches: [{ find: 'alpha=old', replace: 'new' }] })).rejects.toMatchObject({ code: 'PATCH_CONTEXT_AMBIGUOUS' })
  await expect(f.editor.execute({ path: 'a.txt', expectedHash: sha(f.baseline), patches: [{ find: 'alpha=old alpha=old', replace: 'x' }, { find: 'old alpha=old', replace: 'y' }] })).rejects.toMatchObject({ code: 'PATCH_RANGES_OVERLAP' })
  expect(await f.files.read('a.txt')).toBe(f.baseline)
})

it('preserves Chinese, CRLF and unrelated indentation while applying unique normalized fragments', async () => {
  const f = await fixture('  标题=旧值\r\n  beta=old\r\n')
  await writeFile(join(f.root, 'a.txt'), '// 保留\r\n' + f.baseline)
  await f.editor.execute({ path: 'a.txt', expectedHash: sha(f.baseline), patches: [{ find: '标题=旧值', replace: '标题=新值' }, { find: 'beta=old', replace: 'beta=new' }] })
  expect(await f.files.read('a.txt')).toBe('// 保留\r\n  标题=新值\r\n  beta=new\r\n')
})

it('supports a deletion against a uniquely matching latest file', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'a.txt'), f.baseline + '// keep\n')
  await f.editor.execute({ path: 'a.txt', expectedHash: sha(f.baseline), patches: [{ find: 'alpha=old\n', replace: '' }] })
  expect(await f.files.read('a.txt')).toBe('beta=old\n// keep\n')
})

it('proves unchanged replays but does not append a replacement inside an already-applied fragment', async () => {
  const f = await fixture('alpha=old\n'), input = { path: 'a.txt', expectedHash: sha(f.baseline), patches: [{ find: 'alpha=old', replace: 'alpha=old+new' }] }
  const begin = vi.fn(); f.files.setFileJournal({ begin, landed: vi.fn() })
  await f.editor.execute(input)
  expect(await new ExactPatchEditor(new FilesystemTool(f.root), undefined, 'normalized', 2).execute(input)).toMatchObject({ alreadyApplied: true, changed: false })
  await writeFile(join(f.root, 'a.txt'), 'alpha=old+new\n// external\n')
  await expect(f.editor.execute(input)).rejects.toMatchObject({ code: 'PATCH_CONTEXT_AMBIGUOUS' })
  expect(await f.files.read('a.txt')).toBe('alpha=old+new\n// external\n'); expect(begin).toHaveBeenCalledTimes(1)
})

it.each([false, true])('revalidates once after an external edit, then stops if it keeps changing (%s)', async keepChanging => {
  const f = await fixture(); let validations = 0
  const begin = vi.fn(); f.files.setFileJournal({ begin, landed: vi.fn() })
  const editor = new ExactPatchEditor(f.files, async () => { validations++; if (validations === 1 || keepChanging) await writeFile(join(f.root, 'a.txt'), f.baseline + `// caller ${validations}\n`) }, 'normalized', 2)
  if (keepChanging) {
    await expect(editor.execute(f.input)).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT', details: { currentHash: sha(f.baseline + '// caller 2\n') } })
    expect(await f.files.read('a.txt')).toBe(f.baseline + '// caller 2\n'); expect(begin).not.toHaveBeenCalled()
  } else {
    expect(await editor.execute(f.input)).toMatchObject({ rebased: true, beforeHash: sha(f.baseline + '// caller 1\n') })
    expect(await f.files.read('a.txt')).toBe('alpha=new\nbeta=new\n// caller 1\n'); expect(begin).toHaveBeenCalledTimes(1)
  }
  expect(validations).toBe(2)
})

it('rechecks after WAL preparation and keeps the final WAL pre-image current', async () => {
  const f = await fixture(); let preparations = 0
  const before: string[] = [], landed = vi.fn()
  f.files.setFileJournal({ begin: async info => { before.push(info.before!.toString()); if (++preparations === 1) await writeFile(join(f.root, 'a.txt'), f.baseline + '// WAL-time edit\n') }, landed })
  await f.editor.execute(f.input)
  expect(before).toEqual([f.baseline, f.baseline + '// WAL-time edit\n']); expect(landed).toHaveBeenCalledTimes(1)
  expect(await f.files.read('a.txt')).toBe('alpha=new\nbeta=new\n// WAL-time edit\n')
  expect((await readdir(f.root)).filter(p => p.includes('.tmp-') || p.endsWith('.pulse.lock'))).toEqual([])
})

it('serializes same-file editors while allowing another file to finish independently', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'b.txt'), 'old')
  let release!: () => void, enter!: () => void
  const entered = new Promise<void>(r => { enter = r }), gate = new Promise<void>(r => { release = r })
  const first = new ExactPatchEditor(f.files, async () => { enter(); await gate }, 'normalized', 2)
  const a = first.execute({ ...f.input, patches: [f.input.patches[0]!] })
  await entered
  const secondValidation = vi.fn()
  const b = new ExactPatchEditor(new FilesystemTool(f.root), async () => { secondValidation() }, 'normalized', 2).execute({ ...f.input, patches: [f.input.patches[1]!] })
  try {
    await new ExactPatchEditor(new FilesystemTool(f.root), undefined, 'normalized', 2).execute({ path: 'b.txt', expectedHash: sha('old'), patches: [{ find: 'old', replace: 'new' }] })
    expect(secondValidation).not.toHaveBeenCalled()
  } finally { release() }
  await a; expect(await b).toMatchObject({ rebased: true })
  expect(await f.files.read('a.txt')).toBe('alpha=new\nbeta=new\n')
})

it('cancels before commit and keeps strict CAS writers strict', async () => {
  const f = await fixture(), abort = new AbortController(), begin = vi.fn()
  f.files.setFileJournal({ begin, landed: vi.fn() })
  await expect(new ExactPatchEditor(f.files, async () => { abort.abort() }, 'normalized', 2).execute(f.input, abort.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  await writeFile(join(f.root, 'a.txt'), f.baseline + '// caller\n')
  await expect(f.files.writeIfUnchanged('a.txt', 'overwrite', sha(f.baseline))).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT' })
  await expect(new ExactPatchEditor(f.files).execute(f.input)).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT' })
  expect(begin).not.toHaveBeenCalled()
})

it('does not retry an uncertain post-write journal failure, even if its code resembles a conflict', async () => {
  const f = await fixture(), begin = vi.fn(), failure = Object.assign(new Error('Receipt persistence failed after write'), { code: 'FILE_BASELINE_CONFLICT' })
  const landed = vi.fn(async () => { throw failure })
  f.files.setFileJournal({ begin, landed })
  await expect(f.editor.execute(f.input)).rejects.toBe(failure)
  expect(begin).toHaveBeenCalledTimes(1); expect(landed).toHaveBeenCalledTimes(1)
  expect(await f.files.read('a.txt')).toBe('alpha=new\nbeta=new\n')
})

it('honors cancellation while waiting for the shared path lock', async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void
  const gate = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { entered = r })
  const first = new ExactPatchEditor(f.files, async () => { entered(); await gate }, 'normalized', 2).execute(f.input)
  await ready
  const abort = new AbortController(), validate = vi.fn()
  const second = new ExactPatchEditor(new FilesystemTool(f.root), validate, 'normalized', 2).execute(f.input, abort.signal)
  abort.abort()
  try { await expect(second).rejects.toMatchObject({ code: 'ABORTED' }); expect(validate).not.toHaveBeenCalled() }
  finally { release(); await first }
  expect((await readdir(f.root)).filter(p => p.endsWith('.pulse.lock'))).toEqual([])
})

it('leaves the target unchanged when cancellation happens after WAL preparation', async () => {
  const f = await fixture(), abort = new AbortController(), landed = vi.fn()
  f.files.setFileJournal({ begin: async () => { abort.abort() }, landed })
  await expect(f.editor.execute(f.input, abort.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  expect(await f.files.read('a.txt')).toBe(f.baseline); expect(landed).not.toHaveBeenCalled()
  expect((await readdir(f.root)).filter(p => p.includes('.tmp-') || p.endsWith('.pulse.lock'))).toEqual([])
})

it('bounds its latest-content read and refuses invalid UTF-8 before any write', async () => {
  const f = await fixture(), begin = vi.fn(); f.files.setFileJournal({ begin, landed: vi.fn() })
  await writeFile(join(f.root, 'a.txt'), 'x'.repeat(PATCH_FILE_BYTES+1))
  await expect(f.editor.execute(f.input)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', message:expect.stringContaining('not the patch fragment'), details:{kind:'patch-target-limit',path:'a.txt',bytes:PATCH_FILE_BYTES+1,maxBytes:PATCH_FILE_BYTES} })
  const binary = Buffer.from([0xff, 0xfe, 0x41]); await writeFile(join(f.root, 'a.txt'), binary)
  await expect(f.editor.execute(f.input)).rejects.toMatchObject({ code: 'FILE_NOT_UTF8' })
  expect(await readFile(join(f.root, 'a.txt'))).toEqual(binary); expect(begin).not.toHaveBeenCalled()
})

it.each([1,2] as const)('applies a small batch to a large UTF-8 source while preserving every untouched byte (version=%s)',async version=>{
 const source='// 保留中文与换行\r\n'.repeat(35000)+'alpha=old\r\n'+'// unchanged tail\r\n'.repeat(4000)+'beta=old\r\n'
 expect(Buffer.byteLength(source)).toBeGreaterThan(500000)
 const f=await fixture(source),begin=vi.fn(),landed=vi.fn();f.files.setFileJournal({begin,landed})
 const result=await new ExactPatchEditor(f.files,undefined,'normalized',version).execute(f.input)
 const expected=source.replace('alpha=old','alpha=new').replace('beta=old','beta=new')
 expect(await readFile(join(f.root,'a.txt'))).toEqual(Buffer.from(expected))
 expect(result).toMatchObject({changed:true,replacements:2,beforeHash:sha(source),hash:sha(expected),bytes:Buffer.byteLength(expected)})
 expect(begin).toHaveBeenCalledOnce();expect(landed).toHaveBeenCalledOnce()
 expect(begin.mock.calls[0]![0].before).toEqual(Buffer.from(source))
 await expect(new ExactPatchEditor(f.files,undefined,'normalized',version).execute(f.input)).resolves.toMatchObject({alreadyApplied:true,changed:false})
 expect(begin).toHaveBeenCalledOnce()
})

it('rebases a large-file patch onto an unrelated concurrent edit and leaves conflicts intact',async()=>{
 const source='// padding\n'.repeat(50000)+'alpha=old\nbeta=old\n',f=await fixture(source)
 let checks=0
 const editor=new ExactPatchEditor(f.files,async()=>{if(++checks===1)await writeFile(join(f.root,'a.txt'),source+'// user edit\n')},'normalized',2)
 await expect(editor.execute(f.input)).resolves.toMatchObject({rebased:true,beforeHash:sha(source+'// user edit\n')})
 const saved=source.replace('alpha=old','alpha=new').replace('beta=old','beta=new')+'// user edit\n'
 expect(await readFile(join(f.root,'a.txt'),'utf8')).toBe(saved)
 await expect(editor.execute({...f.input,patches:[{find:'missing fragment',replace:'never write'}]})).rejects.toMatchObject({code:'PATCH_CONTEXT_NOT_FOUND'})
 expect(await readFile(join(f.root,'a.txt'),'utf8')).toBe(saved)
})

it.each([false,true])('rejects repetitive large-file targets without collecting unbounded matches (all=%s)',async all=>{
 const f=await fixture('x'.repeat(2000000))
 await expect(f.editor.execute({path:'a.txt',expectedHash:sha(f.baseline),all,patches:[{find:'x',replace:'y'}]})).rejects.toMatchObject({code:all?'PATCH_TOO_BROAD':'PATCH_CONTEXT_AMBIGUOUS'})
 expect(await readFile(join(f.root,'a.txt'),'utf8')).toBe(f.baseline)
})

it('never creates a missing patch target or its parent directories', async () => {
  const f = await fixture()
  await expect(f.editor.execute({ ...f.input, path: 'missing/child/a.txt' })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(f.root)).toEqual(['a.txt'])
})

it('coordinates real separate Node processes writing disjoint patches from one old baseline', async () => {
  const original = 'lineA=old\nlineB=old\nlineC=old\n', f = await fixture(original)
  const script = `import { FilesystemTool } from ${JSON.stringify(new URL('../packages/adapters/dist/tools/filesystem.js', import.meta.url).href)}; import { ExactPatchEditor } from ${JSON.stringify(new URL('../packages/server/dist/editing.js', import.meta.url).href)}; const e = new ExactPatchEditor(new FilesystemTool(process.argv[1]), async()=>new Promise(r=>setTimeout(r,30)), 'normalized', 2); console.log(JSON.stringify(await e.execute({path:'a.txt',expectedHash:process.argv[3],patches:[{find:process.argv[2]+'=old',replace:process.argv[2]+'=new'}]})));`
  const results = await Promise.all(['lineA', 'lineB', 'lineC'].map(line => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.root, line, sha(original)])))
  expect(results.map(r => JSON.parse(r.stdout)).filter(r => r.rebased)).toHaveLength(2)
  expect(await f.files.read('a.txt')).toBe('lineA=new\nlineB=new\nlineC=new\n')
}, 15_000)

it.each([undefined, 2])('uses the persisted patch contract in the actual Host registry (version=%s)', async patchApplyVersion => {
  const f = await fixture('alpha=old\n'+'// keep\n'.repeat(70000)+'beta=old\n'), dataDir = join(f.root, 'data'), host = createLocalHost({ cwd: f.root, dataDir, provider: { provider: 'mock' }, taskController: false, approvalMode: 'auto', jarvis: { enabled: false } })
  try {
    const conv = await host.createConversation(), runId = 'fixture-run', runDir = join(dataDir, 'conversations', conv.id, 'runs', runId)
    await mkdir(runDir, { recursive: true }); await writeFile(join(runDir, 'input.json'), JSON.stringify({ fileSurfaceVersion: 3, patchApplyVersion }))
    await writeFile(join(f.root, 'a.txt'), '// caller\n' + f.baseline)
    const { runtime } = await (host as any).runtimeFor(conv.id, runId, f.root, 'Update both settings', '', (host as any).options)
    const program = defineLaneProgram({ id: 'host-patch-version', version: '1' }, b => {
      b.addStep('patch', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'p', kind: 'tool', concurrencyClass: 'tool', toolCallId: 'p', input: { name: 'fs.apply_patches', arguments: f.input, toolCallId: 'p' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'done' }))
      b.addStep('done', ctx => ({ actions: [{ type: 'complete', result: ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies).map((d: any) => ({ error: d.outcome.error?.code ?? null, value: d.outcome.resultRef ? ctx.results.read(d.outcome.resultRef) : null })) : [] }], next: 'done' }))
    })
    const { agentId } = runtime.createAgent('Update both settings', program), outcome = await runtime.start(agentId).outcome(), results = runtime.state.results.get(outcome.resultRef!)!.value as any[]
    if (patchApplyVersion === 2) {
      expect(results[0]).toMatchObject({ error: null, value: { rebased: true, beforeHash: sha('// caller\n' + f.baseline), requestedBaseHash: sha(f.baseline) } })
      expect(await f.files.read('a.txt')).toBe('// caller\n'+f.baseline.replace('alpha=old','alpha=new').replace('beta=old','beta=new'))
    } else { expect(results[0].error).toBe('FILE_BASELINE_CONFLICT'); expect(await f.files.read('a.txt')).toBe('// caller\n' + f.baseline) }
  } finally { await host.close() }
})

it.each(['intervening-read', 'different-baseline'] as const)('does not coalesce patches across %s', async kind => {
  const executed: string[] = []; let models = 0
  const program = defineLaneProgram({ id: 'patch-order-' + kind, version: '1' }, b => b.addReActLoopStep('work', { instruction: 'Update settings', toolAllow: ['fs.read', 'fs.apply_patch', 'fs.apply_patches'], maxTurns: 4, onFinish: () => ({ complete: {} }) }))
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') { const i = effect.input as any; executed.push(i.name); return { value: { path: 'a.txt', hash: sha('updated'), changed: true } } }
    if (++models > 1) return { value: { text: 'Done', finishReason: 'stop', toolCalls: [] } }
    return { value: { finishReason: 'tool_calls', toolCalls: [
      { name: 'fs.apply_patch', input: { path: 'a.txt', find: 'alpha', replace: 'one', expectedHash: sha('base') } },
      ...(kind === 'intervening-read' ? [{ name: 'fs.read', input: { path: 'a.txt' } }] : []),
      { name: 'fs.apply_patch', input: { path: 'a.txt', find: 'beta', replace: 'two', expectedHash: sha(kind === 'different-baseline' ? 'changed' : 'base') } },
    ] } }
  } })
  const { agentId } = runtime.createAgent('Update settings', program)
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(executed.filter(name => name === 'fs.apply_patch')).toHaveLength(2); expect(executed).not.toContain('fs.apply_patches')
})

it.each([false, true])('restores a human-approved batch with the saved patch version, without renewing its budget (old run=%s)', async oldRun => {
  const f = await fixture(), dataDir = join(f.root, 'data'); let models = 0
  const tool = (name: string, args: object, id: string) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  vi.stubGlobal('fetch', vi.fn(async () => {
    models++
    const tools = models === 1 ? [tool('fs_read', { path: 'a.txt' }, 'read-before')] : models === 2 ? f.input.patches.map((p, i) => tool('fs_apply_patch', { path: 'a.txt', expectedHash: sha(f.baseline), ...p }, `patch-${i}`)) : []
    return Response.json({ choices: [{ message: tools.length ? { content: '', tool_calls: tools } : { content: 'Finished the bounded update.' }, finish_reason: tools.length ? 'tool_calls' : 'stop' }] })
  }))
  const options = { cwd: f.root, dataDir, provider: { provider: 'openai-compatible', defaultModel: 'scripted' }, taskController: false, approvalMode: 'ask' as const, maxModelCalls: 12, jarvis: { enabled: false } }
  let host = createLocalHost(options)
  // Build an actual old-surface fixture before any registry/fingerprints are created.
  if (oldRun) {
    const runtimeFor = (host as any).runtimeFor.bind(host)
    ;(host as any).runtimeFor = async (...args: any[]) => {
      const path = join(dataDir, 'conversations', args[0], 'runs', args[1], 'input.json'), input = JSON.parse(await readFile(path, 'utf8'))
      delete input.patchApplyVersion; await writeFile(path, JSON.stringify(input))
      return runtimeFor(...args)
    }
  }
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Update alpha and beta settings together, preserving unrelated changes.' })
    const iterator = run.events[Symbol.asyncIterator](); let approvals = 0
    while (true) {
      const event = await iterator.next(); if (event.done) throw new Error('No patch approval was reached')
      if (event.value.type !== 'waiting') continue
      const pending = await run.pendingInteractions(), batch = pending.find(g => g.kind === 'approval')
      if (!batch) continue
      const tools = JSON.stringify(batch)
      if (tools.includes('fs.apply_patches')) break
      for (const item of batch.items) { await run.reply(item.effectId, { approved: true }); approvals++ }
    }
    const runDir = join(dataDir, 'conversations', conversation.id, 'runs', run.id), budget = await readFile(join(runDir, 'model-budget.json'), 'utf8')
    await host.close({ preserveHumanWaits: true }); await iterator.return?.()
    await writeFile(join(f.root, 'a.txt'), '// external edit during approval\n' + f.baseline)
    host = createLocalHost(options)
    const restored = await host.resumeRun(conversation.id), groups = await restored.pendingInteractions()
    expect(JSON.stringify(groups)).toContain('fs.apply_patches')
    for (const group of groups) for (const item of group.items) { await restored.reply(item.effectId, { approved: true }); approvals++ }
    await restored.outcome()
    const after = JSON.parse(await readFile(join(runDir, 'model-budget.json'), 'utf8')), before = JSON.parse(budget)
    expect(after.limit).toBe(before.limit); expect(after.used).toBeGreaterThanOrEqual(before.used)
    const operations = JSON.parse(await readFile(join(runDir, 'operations.json'), 'utf8')).operations
    expect(operations.filter((o: any) => o.tool === 'fs.apply_patches')).toHaveLength(1)
    expect(await f.files.read('a.txt')).toBe('// external edit during approval\n' + (oldRun ? f.baseline : 'alpha=new\nbeta=new\n'))
    const saved = JSON.parse(await readFile(join(runDir, 'input.json'), 'utf8'))
    expect(saved.patchApplyVersion).toBe(oldRun ? undefined : 2)
    // The returned current hash alone never grants full-file read coverage.
    expect(operations.some((o: any) => o.tool === 'fs.overwrite')).toBe(false)
    expect(approvals).toBeGreaterThanOrEqual(1)
  } finally { await host.close({ preserveHumanWaits: true }) }
}, 20_000)
