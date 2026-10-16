import { expect, it } from 'vitest'
import { isUnreadFileWindow } from '../packages/runtime/src/dsl/read-continuation.js'

function context(rows: Record<string, any>): any {
  return { results: {
    meta: (ref: string) => rows[ref] ? { toolName: rows[ref].tool ?? 'fs.read', outcomeStatus: rows[ref].status ?? 'succeeded', toolArguments: rows[ref].args ?? {} } : undefined,
    read: (ref: string) => rows[ref]?.value,
  } }
}
const read = (offset: number, maxBytes = 3000) => ({ toolName: 'fs.read', input: { path: 'run.mjs', offset, maxBytes } })
it('permits LT02 bounded overlap that exposes new bytes, but not tiny sliding replay', () => {
  const ctx = context({ 'result-1': { value: { path: 'run.mjs', hash: 'v1', offset: 6000, content: 'x'.repeat(2600), nextOffset: 8600 } } })
  expect(isUnreadFileWindow(ctx, read(8400, 2400), ['result-1'])).toBe(true)
  expect(isUnreadFileWindow(ctx, read(6001, 2600), ['result-1'])).toBe(false)
  expect(isUnreadFileWindow(ctx, read(6000, 200000), ['result-1'])).toBe(false)
})
it('uses union coverage, actual EOF, and a larger requested window correctly', () => {
  const ctx = context({ 'result-1': { value: { path: 'run.mjs', hash: 'v1', offset: 0, content: 'x'.repeat(100), nextOffset: 100 } }, 'result-2': { value: { path: 'run.mjs', hash: 'v1', offset: 100, content: 'x'.repeat(2900), nextOffset: null } } })
  expect(isUnreadFileWindow(ctx, read(0, 3000), ['result-1'])).toBe(true)
  expect(isUnreadFileWindow(ctx, read(2800, 3000), ['result-1', 'result-2'])).toBe(false)
  expect(isUnreadFileWindow(ctx, read(3000), ['result-1', 'result-2'])).toBe(false)
})
it('allows an unread exact search-line anchor once for the latest file version', () => {
  const rows: Record<string, any> = {
    'result-1': { value: { path: 'run.mjs', hash: 'v1', offset: 0, content: 'head', nextOffset: 4 } },
    'result-2': { tool: 'fs.search', value: { matches: [{ path: 'run.mjs', line: 120, text: 'cost cap' }] } },
    'result-3': { args: { path: 'run.mjs', startLine: 120 }, value: { path: 'run.mjs', hash: 'v1', offset: 6000, content: 'known', nextOffset: 6005 } },
    'result-4': { tool: 'fs.apply_patch', value: { path: 'run.mjs', hash: 'v2', changed: true } },
  }
  const ctx = context(rows), call = { toolName: 'fs.read', input: { path: 'run.mjs', startLine: 120, maxBytes: 3000 } }
  expect(isUnreadFileWindow(ctx, call, ['result-1', 'result-2'])).toBe(true)
  expect(isUnreadFileWindow(ctx, call, ['result-1', 'result-2', 'result-3'])).toBe(false)
  expect(isUnreadFileWindow(ctx, call, ['result-1', 'result-2', 'result-3', 'result-4'])).toBe(false)
  expect(isUnreadFileWindow(ctx, { ...call, input: { ...call.input, startLine: 121 } }, ['result-1', 'result-2'])).toBe(false)
})

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { ExactPatchEditor } from '../packages/server/src/editing.js'
import { createLocalHost } from '@hunterzhu/pulse-server'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

it.each([false, true])('proves an exact prior post-image without another write (batch=%s)', async batch => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-proof-'))
  try {
    const original = 'alpha = old\nbeta = old\n', files = new FilesystemTool(dir), editor = new ExactPatchEditor(files)
    await writeFile(join(dir, 'a.txt'), original)
    const writes = vi.spyOn(files, 'writeIfUnchanged'), patches = [{ find: 'alpha = old', replace: 'alpha = new' }, ...(batch ? [{ find: 'beta = old', replace: 'beta = new' }] : [])]
    const input = { path: 'a.txt', expectedHash: sha(original), patches }
    const first = await editor.execute(input), restoredFiles = new FilesystemTool(dir), restoredWrites = vi.spyOn(restoredFiles, 'writeIfUnchanged'), second = await new ExactPatchEditor(restoredFiles).execute(input)
    expect(first.changed).toBe(true)
    expect(second).toMatchObject({ changed: false, alreadyApplied: true, replacements: 0, beforeHash: first.hash, hash: first.hash })
    expect(writes).toHaveBeenCalledTimes(1); expect(restoredWrites).not.toHaveBeenCalled()
    expect(await files.read('a.txt')).toBe(batch ? 'alpha = new\nbeta = new\n' : 'alpha = new\nbeta = old\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('does not mistake an unrelated replacement, partial batch, deletion, or changed comment for a completed patch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-conflict-'))
  try {
    const files = new FilesystemTool(dir), editor = new ExactPatchEditor(files), original = 'alpha = old\nbeta = old\n'
    const cases = [
      { current: 'unrelated alpha = new\n', patches: [{ find: 'alpha = old', replace: 'alpha = new' }] },
      { current: 'alpha = new\nbeta = old\n', patches: [{ find: 'alpha = old', replace: 'alpha = new' }, { find: 'beta = old', replace: 'beta = new' }] },
      { current: 'beta = old\n', patches: [{ find: 'alpha = old\n', replace: '' }] },
      { current: 'alpha = new\nbeta = old\n', patches: [{ find: 'alpha = old', replace: 'alpha = new // changed proposal' }] },
    ]
    for (const c of cases) {
      await writeFile(join(dir, 'a.txt'), c.current)
      await expect(editor.execute({ path: 'a.txt', expectedHash: sha(original), patches: c.patches })).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT', details: { currentHash: sha(c.current), suggestedRead: { path: 'a.txt', maxBytes: 3000 } } })
      expect(await files.read('a.txt')).toBe(c.current)
    }
    await expect(editor.execute({ path: 'a.txt', patches: [{ find: 'missing', replace: 'alpha = new' }] })).rejects.toMatchObject({ code: 'PATCH_CONTEXT_NOT_FOUND' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('keeps ambiguity, overlap, whole-file baseline and cancellation protections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-safe-'))
  try {
    const files = new FilesystemTool(dir), editor = new ExactPatchEditor(files)
    await writeFile(join(dir, 'a.txt'), 'old old\n')
    await expect(editor.execute({ path: 'a.txt', patches: [{ find: 'old', replace: 'new' }] })).rejects.toMatchObject({ code: 'PATCH_CONTEXT_AMBIGUOUS' })
    await expect(editor.execute({ path: 'a.txt', patches: [{ find: 'old old', replace: 'first' }, { find: 'old\n', replace: 'second' }] })).rejects.toMatchObject({ code: 'PATCH_RANGES_OVERLAP' })
    const abort = new AbortController(); abort.abort()
    await expect(editor.execute({ path: 'a.txt', patches: [{ find: 'old old', replace: 'new' }] }, abort.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(await files.read('a.txt')).toBe('old old\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('returns the recovery window on a UTF-8 codepoint boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-unicode-'))
  try {
    const files = new FilesystemTool(dir), editor = new ExactPatchEditor(files), source = '中😀'.repeat(50) + 'costValue = ready'
    await writeFile(join(dir, 'a.txt'), source)
    let error: any
    try { await editor.execute({ path: 'a.txt', expectedHash: sha('old'), patches: [{ find: 'costValue = old', replace: 'costValue = ready' }] }) } catch (e) { error = e }
    const window = error.details.suggestedRead
    const page = await files.readRange(window.path, window.maxBytes, window.offset)
    expect(page.content).toContain('costValue = ready'); expect(page.content).not.toContain('\ufffd')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

function conflict() {
  return Object.assign(new Error('FILE_BASELINE_CONFLICT'), { code: 'FILE_BASELINE_CONFLICT', retryable: false, details: {
    kind: 'patch-conflict', toolName: 'fs.apply_patch', path: 'run.mjs', currentHash: sha('current'), expectedHash: sha('old'), findHashes: [sha('old')], missingFindHashes: [sha('old')], suggestedRead: { path: 'run.mjs', offset: 0, maxBytes: 3000 },
  } })
}
it('allows one fresh recovery read despite cached first-page evidence and the editing gate, then a rebased patch', async () => {
  let models = 0, reads = 0
  const writes: any[] = [], requests: any[] = []
  const program = defineLaneProgram({ id: 'patch-read-rebase', version: '1', includeLaneHistory: true }, b => b.addReActLoopStep('work', {
    instruction: 'Fix run.mjs', toolAllow: ['fs.read', 'fs.apply_patch'], maxTurns: 10, blockReadOnlyTools: () => true, preserveReadContinuations: true, reuseSettledEvidence: true, onFinish: () => ({ complete: { value: 'verified' } }),
  }))
  const runtime = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') {
      const { name, arguments: args } = e.input as any
      if (name === 'fs.read') { reads++; return { value: { path: args.path, offset: 0, content: reads === 1 ? 'old' : 'current', hash: sha(reads === 1 ? 'old' : 'current'), nextOffset: null } } }
      writes.push(args); if (args.find === 'old') throw conflict()
      expect(args.expectedHash).toBe(sha('current')); return { value: { path: args.path, hash: sha('new'), beforeHash: sha('current'), changed: true } }
    }
    requests.push(e.input); models++
    const actions: any[] = [
      { name: 'fs.read', input: { path: 'run.mjs' } },
      { name: 'fs.apply_patch', input: { path: 'run.mjs', find: 'old', replace: 'new', expectedHash: sha('old') } },
      { name: 'fs.read', input: { path: 'run.mjs', offset: 0, maxBytes: 3000 } },
      { name: 'fs.apply_patch', input: { path: 'run.mjs', find: 'current', replace: 'new', expectedHash: sha('current') } },
    ]
    return { value: models <= actions.length ? { finishReason: 'tool_calls', toolCalls: [actions[models - 1]] } : { text: 'done', finishReason: 'stop' } }
  } })
  expect(await runtime.start(runtime.createAgent('Fix current file', program).agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(reads).toBe(2); expect(writes.map(w => w.find)).toEqual(['old', 'current'])
  expect(JSON.stringify(requests[2])).toContain('suggestedRead')
})
it.each([false, true])('stops unchanged stale fragments across read interleaving and cold restore (%s)', async cold => {
  let models = 0, badPatches = 0, reads = 0
  const requests: any[] = []
  const program = defineLaneProgram({ id: 'stale-patch-loop', version: '1', includeLaneHistory: true }, b => b.addReActLoopStep('work', { instruction: 'Fix run.mjs', toolAllow: ['fs.read', 'fs.apply_patch', 'ask.input'], maxTurns: 20, preserveReadContinuations: true, blockReadOnlyTools: () => true, onFinish: () => ({ complete: {} }) }))
  const execute = async (e: any) => {
    if (e.kind === 'tool') { const { name } = e.input; if (name === 'fs.read') { reads++; return { value: { path: 'run.mjs', offset: 0, content: 'current', nextOffset: null, hash: sha('current') } } } badPatches++; throw conflict() }
    requests.push(e.input); models++
    const action = models === 2 && cold ? { name: 'ask.input', input: { prompt: 'Continue?', defaultValue: 'stop' } } : models === (cold ? 3 : 2) ? { name: 'fs.read', input: { path: 'run.mjs', offset: 0, maxBytes: 3000 } } : { name: 'fs.apply_patch', input: { path: 'run.mjs', find: 'old', replace: models % 2 ? 'new' : 'changed comment', ...(models % 2 ? { expectedHash: sha('old') } : {}) } }
    return { value: { finishReason: 'tool_calls', toolCalls: [action] } }
  }
  let runtime = new PulseRuntime({ builtinHumanEffects: true, effectExecutor: execute }), a = runtime.createAgent('Fix file', program), session = runtime.start(a.agentId)
  if (cold) {
    const original = session.outcome()
    await expect.poll(() => [...runtime.state.effects.values()].some(e => e.kind === 'human' && !e.outcome)).toBe(true)
    const human = [...runtime.state.effects.values()].find(e => e.kind === 'human' && !e.outcome)!
    const previousSession = session
    runtime = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program], builtinHumanEffects: true, effectExecutor: execute }); session = runtime.start(a.agentId)
    await previousSession.cancel('SIMULATED_PROCESS_REPLACEMENT'); await original
    await session.reply(human.id, { text: 'continue' })
  }
  expect(await session.outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS', message: expect.stringContaining('STALE_PATCH_LOOP') } })
  expect(badPatches).toBe(1); expect(reads).toBe(1)
  expect(requests.filter(r => JSON.stringify(r).includes('Runtime patch correction'))).toHaveLength(1)
})
it('exercises the actual Host tool: exact replay is observed with no new write or fake edit receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-host-patch-replay-'))
  try {
    await writeFile(join(dir, 'a.txt'), 'new')
    const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), jarvis: { enabled: false }, approvalMode: 'auto', taskController: false, mockToolCalls: [{ name: 'fs.apply_patch', input: { path: 'a.txt', find: 'old', replace: 'new', expectedHash: sha('old') } }], mockAfterToolResponse: 'Observed existing change' })
    try {
      const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Update a.txt to new' }); await run.outcome()
      const state = JSON.parse(await readFile(join(dir, 'data/conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state
      const effect = state.effects.map(([, e]: any) => e).find((e: any) => e.kind === 'tool' && e.input.name === 'fs.apply_patch')
      expect(effect.outcome.status).toBe('succeeded')
      const bodies = join(dir, 'data/conversations', conversation.id, 'runs', run.id, 'runtime-results')
      const receipts = await Promise.all((await readdir(bodies)).filter(f => f.endsWith('.json')).map(async f => JSON.parse(await readFile(join(bodies, f), 'utf8'))))
      const body = receipts.find(r => r.ref === effect.outcome.resultRef)?.value
      expect(body).toMatchObject({ alreadyApplied: true, changed: false, replacements: 0, hash: sha('new') })
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new')
    } finally { await host.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it.each(['overlap', 'search-line'])('keeps real read progress through a mixed batch and investigation limit (%s)', async kind => {
  let models = 0, reads = 0, searches = 0
  const requests: any[] = []
  const p = defineLaneProgram({ id: 'pagination-progress-' + kind, version: '1', includeLaneHistory: true }, b => b.addReActLoopStep('work', { instruction: 'Implement', toolAllow: ['fs.read', 'fs.search', 'fs.apply_patch'], preserveReadContinuations: true, blockReadOnlyTools: () => true, maxReadOnlyRounds: 2, maxTurns: 8, onFinish: () => ({ complete: {} }) }))
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') {
      const { name, arguments: a } = e.input as any
      if (name === 'fs.search') { searches++; return { value: { matches: [{ path: 'run.mjs', line: 120, text: 'cost cap' }] } } }
      if (name === 'fs.read') { reads++; const offset = a.startLine === 120 ? 6000 : a.offset ?? 0, size = a.maxBytes ?? 3000; return { value: { path: 'run.mjs', hash: 'v1', content: 'x'.repeat(size), offset, nextOffset: offset + size } } }
      return { value: { path: 'run.mjs', hash: 'v2', changed: true } }
    }
    requests.push(e.input); models++
    if (models === 1) return { value: { finishReason: 'tool_calls', toolCalls: kind === 'overlap' ? [{ name: 'fs.read', input: { path: 'run.mjs', offset: 6000, maxBytes: 2600 } }] : [{ name: 'fs.read', input: { path: 'run.mjs', offset: 0 } }, { name: 'fs.search', input: { path: 'run.mjs', query: 'cost cap' } }] } }
    if (models === 2) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: kind === 'overlap' ? { path: 'run.mjs', offset: 8400, maxBytes: 2400 } : { path: 'run.mjs', startLine: 120 } }, { name: 'fs.search', input: { path: 'run.mjs', query: 'unnecessary' } }] } }
    if (models === 3) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.apply_patch', input: { path: 'run.mjs', find: 'old', replace: 'new' } }] } }
    return { value: { text: 'done', finishReason: 'stop' } }
  } })
  expect(await r.start(r.createAgent('Implement a change', p).agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(reads).toBe(2); expect(searches).toBe(kind === 'overlap' ? 0 : 1)
  expect(JSON.stringify(requests[2])).toContain('These other calls were NOT executed: fs.search')
})
it('never suppresses investigation limits merely because unrelated files or positive offsets were read', async () => {
  let models = 0, reads = 0
  const p = defineLaneProgram({ id: 'novel-file-loop', version: '1', includeLaneHistory: true }, b => b.addReActLoopStep('work', { instruction: 'Implement', toolAllow: ['fs.read'], maxReadOnlyRounds: 2, maxTurns: 10, preserveReadContinuations: true, onFinish: () => ({ complete: {} }) }))
  const r = new PulseRuntime({ effectExecutor: async e => {
    if (e.kind === 'tool') { reads++; const a = (e.input as any).arguments; return { value: { path: a.path, hash: sha(a.path), content: 'new source', offset: 200, nextOffset: null } } }
    return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `file-${++models}.mjs`, offset: 200 } }] } }
  } })
  expect(await r.start(r.createAgent('Implement', p).agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'INVESTIGATION_LIMIT_REACHED' } })
  expect(reads).toBe(2)
})
it('detects a concurrent external edit at commit and returns its actual hash without retrying the write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-race-'))
  try {
    const files = new FilesystemTool(dir), editor = new ExactPatchEditor(files)
    await writeFile(join(dir, 'a.txt'), 'old')
    const commit = files.writeIfUnchanged.bind(files), writes = vi.spyOn(files, 'writeIfUnchanged').mockImplementationOnce(async (...args) => { await writeFile(join(dir, 'a.txt'), 'external'); return commit(...args) })
    await expect(editor.execute({ path: 'a.txt', expectedHash: sha('old'), patches: [{ find: 'old', replace: 'new' }] })).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT', details: { currentHash: sha('external'), suggestedRead: { path: 'a.txt', offset: 0 } } })
    expect(writes).toHaveBeenCalledTimes(1); expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('external')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('bounds repeated conflicts even when callers vary relative/absolute path aliases', async () => {
  const { rememberPatchFailures, stalePatchRecord } = await import('../packages/runtime/src/dsl/patch-recovery.js')
  const e = conflict(); (e.details as any).workspaceRoot = '/workspace'
  const records = rememberPatchFailures([], [e], 1)
  for (const path of ['run.mjs', './run.mjs', '/workspace/folder/../run.mjs']) expect(stalePatchRecord({ toolName: 'fs.apply_patch', input: { path, find: 'old', replace: 'different' } }, records)).toBeTruthy()
})

import actualPatchTrace from './fixtures/lt02-stale-patch-regression.json'
it('replays real LT02 patch fragments and blocks old hash, changed comments and omitted hash without repeat dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-lt02-fragments-'))
  try {
    const operations = actualPatchTrace.operations, baseline = operations[0]!.patches.map(p => p.find).join('\n// fixture separator\n')
    await writeFile(join(dir, 'run.txt'), baseline)
    const editor = new ExactPatchEditor(new FilesystemTool(dir)); let models = 0, nativePatches = 0, postImage = ''
    const requests: any[] = []
    const p = defineLaneProgram({ id: 'actual-lt02-stale-fragments', version: '1', includeLaneHistory: true }, b => b.addReActLoopStep('work', { instruction: 'Update runner fragments', toolAllow: ['fs.apply_patches'], maxTurns: 12, onFinish: () => ({ complete: {} }) }))
    const r = new PulseRuntime({ effectExecutor: async e => {
      if (e.kind === 'tool') { nativePatches++; const value = await editor.execute((e.input as any).arguments); if (nativePatches === 1) postImage = await readFile(join(dir, 'run.txt'), 'utf8'); return { value } }
      requests.push(e.input); models++
      const operation = operations[Math.min(models - 1, 3)]!
      return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.apply_patches', input: { path: 'run.txt', patches: operation.patches, ...(operation.hadExpectedHash ? { expectedHash: sha(baseline) } : {}) } }] } }
    } })
    expect(await r.start(r.createAgent('Update runner', p).agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS', message: expect.stringContaining('STALE_PATCH_LOOP') } })
    expect(nativePatches).toBe(2); expect(models).toBe(5)
    expect(await readFile(join(dir, 'run.txt'), 'utf8')).toBe(postImage)
    const correction = requests.find(r => JSON.stringify(r).includes('Runtime patch correction'))
    expect(JSON.stringify(correction)).toMatch(/Previous successful patch refs matching that observed hash: result-\d+/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('does not repeat a prefix replacement without a hash after its replacement is already present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-prefix-'))
  try {
    const editor = new ExactPatchEditor(new FilesystemTool(dir)); await writeFile(join(dir, 'a.txt'), 'old')
    const operation = { path: 'a.txt', patches: [{ find: 'old', replace: 'oldnew' }] }
    await editor.execute(operation)
    await expect(editor.execute(operation)).rejects.toMatchObject({ code: 'PATCH_CONTEXT_AMBIGUOUS', details: { currentHash: sha('oldnew') } })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('oldnew')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it.each(['read-only', 'ask'] as const)('never uses already-applied reconciliation to bypass %s authorization', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-patch-permission-'))
  try {
    await writeFile(join(dir, 'a.txt'), 'new')
    const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), jarvis: { enabled: false }, approvalMode: mode, taskController: false, maxModelCalls: 8, mockToolCalls: [{ name: 'fs.apply_patch', input: { path: 'a.txt', find: 'old', replace: 'new', expectedHash: sha('old') } }], mockAfterToolResponse: 'never authorize silently' })
    try {
      const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Update a.txt' })
      if (mode === 'ask') for await (const e of run.events) if (e.type === 'waiting') { const pending = (await run.pendingInteractions()).flatMap(g => g.items); expect(pending.length).toBeGreaterThan(0); await run.reply(pending[0]!.effectId, { approved: false }); break }
      await run.outcome()
      const st = JSON.parse(await readFile(join(dir, 'data/conversations', c.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state
      expect(st.effects.map(([,e]: any) => e).some((e: any) => e.kind === 'tool' && e.input.name === 'fs.apply_patch' && e.outcome?.status === 'succeeded')).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new')
    } finally { await host.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('keeps recovery counters in the returned draft instead of mutating the immutable checkpoint', async () => {
  const { rememberPatchFailures, readPatchRecoveries } = await import('../packages/runtime/src/dsl/patch-recovery.js')
  const original = rememberPatchFailures([], [conflict()], 1); Object.freeze(original[0])
  const draft = readPatchRecoveries(original); draft[0]!.attempts++
  expect(original[0]!.attempts).toBe(1); expect(draft[0]!.attempts).toBe(2)
})
it('does not count an empty line beyond a trailing newline as already read', () => {
  const ctx = context({
    'result-1': { tool: 'fs.search', value: { matches: [{ path: 'run.mjs', line: 120, text: 'old line' }, { path: 'run.mjs', line: 121, text: 'unread line' }] } },
    'result-2': { args: { path: 'run.mjs', startLine: 120 }, value: { path: 'run.mjs', hash: 'v1', offset: 5000, nextOffset: 5009, content: 'old line\n' } },
  })
  expect(isUnreadFileWindow(ctx, { toolName: 'fs.read', input: { path: 'run.mjs', startLine: 120 } }, ['result-1', 'result-2'])).toBe(false)
  expect(isUnreadFileWindow(ctx, { toolName: 'fs.read', input: { path: 'run.mjs', startLine: 121 } }, ['result-1', 'result-2'])).toBe(true)
})
it('bases overlap allowance on the real EOF-bounded window, not a padded request size', () => {
  const ctx = context({
    'result-1': { value: { path: 'run.mjs', hash: 'v1', offset: 0, content: 'a'.repeat(400), nextOffset: 400 } },
    'result-2': { value: { path: 'run.mjs', hash: 'v1', offset: 401, content: 'b'.repeat(100), nextOffset: null } },
  })
  expect(isUnreadFileWindow(ctx, read(200, 3000), ['result-1', 'result-2'])).toBe(false)
  expect(isUnreadFileWindow(ctx, read(400, 1), ['result-1', 'result-2'])).toBe(true)
})
