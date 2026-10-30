import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { createModelEffectExecutor } from '../packages/adapters/src/providers/runtime-executor.js'
import { McpStdioClient } from '../packages/adapters/src/mcp/stdio.js'
import { resolveModelCapability } from '../packages/adapters/src/providers/canonical/capabilities.js'
import { FilesystemTool } from '../packages/adapters/src/tools/filesystem.js'
import { utf8HeadTail } from '../packages/runtime/src/context/builder.js'
import { createDocxCapabilityPack, createPdfCapabilityPack, createPptxCapabilityPack, createSpreadsheetCapabilityPack, unimplementedDocumentCapabilities } from '../packages/server/src/capabilities.js'
import { ExactPatchEditor } from '../packages/server/src/editing.js'
import { FileSnapshotManager } from '../packages/server/src/file-snapshots.js'
import { hasVisibleFullRead, latestVisibleReadHash } from '../packages/server/src/file-read-evidence.js'
import { readBoundedImage, IMAGE_RAW_LIMIT } from '../packages/server/src/image-bytes.js'
import { globWorkspace, searchWorkspace } from '../packages/server/src/security.js'
import { blockAcceptanceIfShellBusy, shellAcceptanceGate } from '../packages/server/src/shell-processes.js'
import { LocalHost } from '../packages/server/src/index.js'
import { option, parse } from '../packages/cli/src/bin.js'

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_NETWORK')) })
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

function tool(key: string, name: string, args: Record<string, unknown>) {
  return { key, toolCallId: key, kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { name, arguments: args, toolCallId: key } }
}

function settled(ctx: any) {
  const deps = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution?.dependencies ?? {}) : []
  return (deps as any[]).flatMap((item) => item.state === 'settled' ? [{ error: item.outcome.error?.code ?? null, value: item.outcome.resultRef ? ctx.results.read(item.outcome.resultRef) : null }] : [])
}

async function isolatedHost(policy: 'legacy' | 'continuous' = 'legacy') {
  const root = await mkdtemp(join(tmpdir(), 'pulse-repair-'))
  vi.stubEnv('PULSE_HOME', join(root, 'home'))
  vi.stubEnv('PULSE_CONFIG', join(root, 'home', 'config.json'))
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('USERPROFILE', join(root, 'home'))
  vi.stubEnv('APPDATA', join(root, 'appdata'))
  vi.stubEnv('LOCALAPPDATA', join(root, 'localappdata'))
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg-config'))
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'xdg-cache'))
  vi.stubEnv('XDG_DATA_HOME', join(root, 'xdg-data'))
  vi.stubEnv('XDG_STATE_HOME', join(root, 'xdg-state'))
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'xdg-runtime'))
  const host = new LocalHost({
    cwd: root,
    dataDir: join(root, 'data'),
    provider: { provider: 'mock' },
    approvalMode: 'auto',
    taskController: policy === 'continuous',
    taskControllerPolicy: policy,
    jarvis: { enabled: false },
    providerModels: { vision: { provider: 'mock', model: 'vision', imageInput: 'supported' } },
    taskRouting: { vision: ['vision'] },
  })
  await host.init()
  const conversation = await host.createConversation()
  return { root, host, conversation, runDirectory: (runId: string) => join(root, 'data', 'conversations', conversation.id, 'runs', runId) }
}

async function openSurface(isolated: Awaited<ReturnType<typeof isolatedHost>>, runId: string) {
  const runDirectory = isolated.runDirectory(runId)
  await mkdir(runDirectory, { recursive: true })
  await writeFile(join(runDirectory, 'input.json'), JSON.stringify({ fileSurfaceVersion: 2 }))
  return (isolated.host as unknown as { runtimeFor: (...args: unknown[]) => Promise<{ runtime: { start: (id: string) => { outcome: () => Promise<{ status: string; resultRef?: string }> }; state: { results: Map<string, { value?: unknown }>; effects: Map<string, unknown> }; createAgent: (goal: string, program: unknown) => { agentId: string } } }> }).runtimeFor(isolated.conversation.id, runId, isolated.root, 'edit file', '', (isolated.host as unknown as { options: unknown }).options)
}

function twoWriteProgram(oldHash: string) {
  return defineLaneProgram({ id: 'two-writes', version: '1' }, (builder) => {
    builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('write-a', 'fs.write', { path: 'a.txt', content: 'old' })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'patch' }))
    builder.addStep('patch', () => ({ actions: [{ type: 'submit_effects', effects: [tool('patch-a', 'fs.apply_patch', { path: 'a.txt', find: 'old', replace: 'new', expectedHash: oldHash })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
    builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
  })
}

describe('repair round 1 production paths', () => {
  it('keeps official cache keys and drops them for compatible or custom endpoints unless overridden', () => {
    expect(resolveModelCapability('gpt-4o', 'openai').promptCache).toBe('openai_prompt_cache_key')
    expect(resolveModelCapability('claude-3-5', 'anthropic', undefined, 'https://api.anthropic.com').promptCache).toBe('anthropic_ephemeral')
    expect(resolveModelCapability('gpt-4o', 'openai-compatible').promptCache).toBe('none')
    expect(resolveModelCapability('gpt-4o', 'openai', undefined, 'https://gateway.example/v1').promptCache).toBe('none')
    expect(resolveModelCapability('claude-3-5', 'anthropic', undefined, 'not a url').promptCache).toBe('none')
    expect(resolveModelCapability('gpt-4o', 'openai-compatible', { promptCache: 'openai_prompt_cache_key' }).promptCache).toBe('openai_prompt_cache_key')
  })

  it('counts the truncation marker inside the byte budget and does not emit U+FFFD', () => {
    const preview = utf8HeadTail('汉字'.repeat(40), 10)
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(10)
    expect(preview).not.toContain('\uFFFD')
    const wide = utf8HeadTail(`${'汉'.repeat(50)}\n${'字'.repeat(50)}`, 80)
    expect(Buffer.byteLength(wide, 'utf8')).toBeLessThanOrEqual(80)
    expect(wide).not.toContain('\uFFFD')
    expect(wide).toContain('...[truncated')
  })

  it('preserves the next line when normalized matching ignores trailing whitespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-patch-'))
    try {
      const files = new FilesystemTool(root)
      await files.writeIfUnchanged('note.txt', 'alpha() \n beta()\n', null)
      const exact = new ExactPatchEditor(files)
      await expect(exact.execute({ path: 'note.txt', patches: [{ find: 'alpha()\n', replace: 'changed()\n' }] })).rejects.toThrow('PATCH_CONTEXT_NOT_FOUND')
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('alpha() \n beta()\n')
      const normalized = new ExactPatchEditor(files, undefined, 'normalized')
      const applied = await normalized.execute({ path: 'note.txt', patches: [{ find: 'alpha()\n', replace: 'changed()\n' }] })
      expect(applied.changed).toBe(true)
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('changed()\n beta()\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('anchors root globs and nested gitignore without re-including an excluded directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-glob-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await mkdir(join(root, 'secret'), { recursive: true })
      await mkdir(join(root, 'lib'), { recursive: true })
      await writeFile(join(root, '.gitignore'), 'secret/\n!secret/keep.txt\n')
      await writeFile(join(root, 'src', '.gitignore'), '*.tmp\n!keep.tmp\n')
      await writeFile(join(root, 'foo'), 'root')
      await writeFile(join(root, 'src', 'foo'), 'nested')
      await writeFile(join(root, 'secret', 'keep.txt'), 'hidden needle')
      await writeFile(join(root, 'src', 'a.tmp'), 'drop')
      await writeFile(join(root, 'src', 'keep.tmp'), 'stay')
      await writeFile(join(root, 'lib', 'a.tmp'), 'other')
      const foo = (await globWorkspace(root, '/foo')).matches.map((item) => item.path).sort()
      expect(foo).toEqual(['foo'])
      const temps = (await globWorkspace(root, '**/*.tmp')).matches.map((item) => item.path).sort()
      expect(temps).toEqual(['lib/a.tmp', 'src/keep.tmp'])
      const found = await searchWorkspace(root, 'hidden needle')
      expect(found.matches).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('requires a visible read and invalidates it after a successful normalized edit', async () => {
    const isolated = await isolatedHost()
    const runId = 'surface-read'
    try {
      const runDirectory = isolated.runDirectory(runId)
      await mkdir(runDirectory, { recursive: true })
      await writeFile(join(runDirectory, 'input.json'), JSON.stringify({ fileSurfaceVersion: 2 }))
      await writeFile(join(isolated.root, 'note.txt'), 'alpha() \n beta()\n')
      const { runtime, registry } = await (isolated.host as unknown as { runtimeFor: (...args: unknown[]) => Promise<{ runtime: { start: (id: string) => { outcome: () => Promise<{ status: string; resultRef?: string }> }; state: { results: Map<string, { value?: unknown }> }; createAgent: (goal: string, program: unknown) => { agentId: string } }; registry: { list: () => Array<{ name: string }> } }> }).runtimeFor(isolated.conversation.id, runId, isolated.root, 'edit note', '', (isolated.host as unknown as { options: unknown }).options)
      expect(registry.list().map((item) => item.name)).toEqual(expect.arrayContaining(['fs.glob', 'fs.view_image', 'fs.overwrite']))
      const program = defineLaneProgram({ id: 'surface-edit', version: '1' }, (builder) => {
        builder.addStep('read', () => ({ actions: [{ type: 'submit_effects', effects: [tool('read-note', 'fs.read', { path: 'note.txt' })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'patch' }))
        builder.addStep('patch', () => ({ actions: [{ type: 'submit_effects', effects: [tool('patch-note', 'fs.apply_patch', { path: 'note.txt', find: 'alpha()\n', replace: 'changed()\n' })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'again' }))
        builder.addStep('again', () => ({ actions: [{ type: 'submit_effects', effects: [tool('patch-again', 'fs.apply_patch', { path: 'note.txt', find: 'changed()\n', replace: 'again()\n' })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      const outcome = await runtime.start(runtime.createAgent('Edit the note', program).agentId).outcome()
      expect(outcome.status).toBe('succeeded')
      const result = runtime.state.results.get(outcome.resultRef!)?.value as Array<{ error: string | null }>
      expect(result.some((item) => item.error === 'FILE_READ_BASELINE_REQUIRED')).toBe(true)
      expect(await readFile(join(isolated.root, 'note.txt'), 'utf8')).toBe('changed()\n beta()\n')
      const reconciled = await isolated.host.reconcileWorkspaceWal(isolated.root, runtime as never, runId, isolated.conversation.id)
      expect(reconciled.restored).not.toContain('note.txt')
      expect(await readFile(join(isolated.root, 'note.txt'), 'utf8')).toBe('changed()\n beta()\n')
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('does not give old runs the new file tools or normalized matching', async () => {
    const isolated = await isolatedHost()
    const runId = 'legacy-surface'
    try {
      const { registry } = await (isolated.host as unknown as { runtimeFor: (...args: unknown[]) => Promise<{ registry: { list: () => Array<{ name: string }>; get: (name: string) => { execute: (input: unknown, context: unknown) => Promise<unknown> } } }> }).runtimeFor(isolated.conversation.id, runId, isolated.root, 'old', '', (isolated.host as unknown as { options: unknown }).options)
      const names = registry.list().map((item) => item.name)
      expect(names).not.toContain('fs.overwrite')
      expect(names).not.toContain('fs.view_image')
      await writeFile(join(isolated.root, 'note.txt'), 'alpha() \n beta()\n')
      await expect(registry.get('fs.apply_patch').execute({ path: 'note.txt', find: 'alpha()\n', replace: 'changed()\n' }, { toolCallId: 'c', effectId: 'e', attemptId: 'a', agentId: 'agent', laneId: 'lane', signal: new AbortController().signal, emit: () => undefined })).rejects.toThrow('PATCH_CONTEXT_NOT_FOUND')
      expect(await readFile(join(isolated.root, 'note.txt'), 'utf8')).toBe('alpha() \n beta()\n')
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('uses only visible full reads for overwrite coverage', () => {
    const hash = 'a'.repeat(64)
    const later = 'b'.repeat(64)
    const runtime = {
      state: {
        lanes: new Map([['lane', { visibleResultRefs: new Set(['result-1', 'result-2', 'result-3', 'result-4']) }]]),
        effects: new Map([
          ['effect-1', { agentId: 'agent', ownerLaneId: 'lane', outcome: { status: 'succeeded' }, input: { name: 'fs.read' } }],
          ['effect-2', { agentId: 'agent', ownerLaneId: 'lane', outcome: { status: 'succeeded' }, input: { name: 'fs.read' } }],
          ['effect-3', { agentId: 'agent', ownerLaneId: 'lane', outcome: { status: 'succeeded' }, input: { name: 'fs.write' } }],
          ['effect-4', { agentId: 'other', ownerLaneId: 'lane', outcome: { status: 'succeeded' }, input: { name: 'fs.read' } }],
        ]),
        results: new Map([
          ['result-1', { id: 'result-1', effectId: 'effect-1', value: { path: 'note.txt', hash, offset: 0, content: 'abc', nextOffset: 3 } }],
          ['result-2', { id: 'result-2', effectId: 'effect-2', value: { path: 'note.txt', hash, offset: 3, content: 'de', nextOffset: null } }],
          ['result-3', { id: 'result-3', effectId: 'effect-3', value: { path: 'note.txt', hash: later, changed: true } }],
          ['result-4', { id: 'result-4', effectId: 'effect-4', value: { path: 'note.txt', hash, offset: 0, content: 'abcde', nextOffset: null } }],
        ]),
      },
    }
    expect(hasVisibleFullRead(runtime, '/workspace', 'lane', 'agent', 'note.txt', hash)).toBe(false)
    expect(latestVisibleReadHash(runtime, '/workspace', 'lane', 'agent', 'note.txt', )).toBeUndefined()
  })

  it('checks vision, size, and real image structure before returning bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-image-'))
    try {
      const png = Buffer.alloc(29)
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      png.writeUInt32BE(13, 8)
      png.write('IHDR', 12)
      png.writeUInt32BE(2, 16)
      png.writeUInt32BE(3, 20)
      await writeFile(join(root, 'ok.png'), png)
      await expect(readBoundedImage(join(root, 'ok.png'))).resolves.toMatchObject({ mediaType: 'image/png' })
      png.writeUInt32BE(9000, 16)
      await writeFile(join(root, 'wide.png'), png)
      await expect(readBoundedImage(join(root, 'wide.png'))).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_INVALID' })
      await writeFile(join(root, 'big.png'), Buffer.alloc(IMAGE_RAW_LIMIT + 1))
      await expect(readBoundedImage(join(root, 'big.png'))).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])
      await writeFile(join(root, 'ok.jpg'), jpeg)
      await expect(readBoundedImage(join(root, 'ok.jpg'))).resolves.toMatchObject({ mediaType: 'image/jpeg' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('selects the vision route when the request contains images', async () => {
    const seen: Array<{ task: unknown; imageInput: boolean; model?: string }> = []
    const execute = createModelEffectExecutor({
      router: { diagnostics: () => [], routeProjection: (task: unknown, _projection: unknown, requirements: { imageInput?: boolean }) => { seen.push({ task, imageInput: requirements.imageInput === true }); return [{ id: task === 'vision' ? 'vision-model' : 'reason-model', providerId: 'mock' }] }, recordFeedback: () => undefined } as never,
      providers: new Map([['mock', { executeAttempt: async (params: { model?: string }) => { seen.push({ task: 'provider', imageInput: false, model: params.model }); return { text: 'seen', toolCalls: [], finishReason: 'stop' } } } as never]]),
    })
    const projection = { images: [{ ref: 'artifact-1', mediaType: 'image/png', data: 'aGk=' }], contextSpec: { artifactRefs: [] }, blocks: [{ kind: 'instruction', content: 'look' }], prefixHash: 'a', projectionHash: 'b', builderVersion: '1', policyVersion: '1', toolSetVersion: '1', privacy: 'local_only', privacyRefs: [] }
    const result = await execute({ id: 'effect-1', kind: 'llm', attemptNo: 1, agentId: 'agent', key: 'work', input: { request: projection, task: 'reason' } } as never, new AbortController().signal)
    expect(result.status).not.toBe('failed')
    expect(seen).toContainEqual({ task: 'vision', imageInput: true })
    expect(seen).toContainEqual({ task: 'provider', imageInput: false, model: 'vision-model' })
  })

  it('blocks continuous writes and acceptance for running or unknown shells, and leaves legacy programs alone', async () => {
    expect(shellAcceptanceGate('57')).toBe(true)
    expect(shellAcceptanceGate('56')).toBe(false)
    const isolated = await isolatedHost('continuous')
    const runId = 'shell-unknown'
    try {
      const runDirectory = isolated.runDirectory(runId)
      const shellDirectory = join(runDirectory, 'shell-processes')
      await mkdir(shellDirectory, { recursive: true })
      const processId = 'a'.repeat(64)
      await writeFile(join(shellDirectory, `${processId}.json`), JSON.stringify({ processId, agentId: 'agent', laneId: 'lane', status: 'unknown', command: { command: 'fixture' } }))
      await expect(blockAcceptanceIfShellBusy('57', runDirectory)).rejects.toThrow('SHELL_PROCESS_STATE_UNKNOWN')
      await expect(blockAcceptanceIfShellBusy('56', runDirectory)).resolves.toBeUndefined()
      const opened = await (isolated.host as unknown as { runtimeFor: (...args: unknown[]) => Promise<{ runtime: { start: Function; createAgent: Function }; registry: { list: () => Array<{ name: string }> } }> }).runtimeFor(isolated.conversation.id, runId, isolated.root, 'write', '', (isolated.host as unknown as { options: unknown }).options)
      const program = defineLaneProgram({ id: 'blocked-write', version: '57' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('write-file', 'fs.write', { path: 'racing.txt', content: 'no' })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      const outcome = await opened.runtime.start(opened.runtime.createAgent('Write', program).agentId).outcome()
      const result = (opened.runtime as unknown as { state: { results: Map<string, { value?: unknown }> } }).state.results.get((outcome as { resultRef?: string }).resultRef!)?.value as Array<{ error: string | null }>
      expect(result.some((item) => item.error === 'SHELL_PROCESS_STATE_UNKNOWN')).toBe(true)
      await expect(readFile(join(isolated.root, 'racing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('refuses a rollback that has no trustworthy preimage', async () => {
    const isolated = await isolatedHost()
    try {
      await writeFile(join(isolated.root, 'note.txt'), 'new')
      const hash = createHash('sha256').update('new').digest('hex')
      await expect(isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'note.txt', expectedPostHash: hash }] })).rejects.toThrow()
      expect(await readFile(join(isolated.root, 'note.txt'), 'utf8')).toBe('new')
      await expect(isolated.host.rollbackFiles({ confirm: false, targets: [{ path: 'note.txt', expectedPostHash: hash }] })).rejects.toThrow('ROLLBACK_CONFIRMATION_REQUIRED')
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('restores an unconfirmed landed write and keeps a confirmed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-wal-'))
    try {
      const files = new FilesystemTool(root)
      const manager = new FileSnapshotManager(root, files)
      await files.writeIfUnchanged('note.txt', 'old', null)
      const before = createHash('sha256').update('old').digest('hex')
      await manager.executeWithWal({ effectId: 'eff-landed', runId: 'run-1', laneId: 'lane', path: 'note.txt', newBytes: Buffer.from('new'), expectedHash: before }, async () => { await files.writeBytesIfUnchanged('note.txt', Buffer.from('new'), before) })
      const restored = await manager.reconcilePendingWal(undefined, async () => 'unconfirmed')
      expect(restored.restored).toContain('note.txt')
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('old')
      await manager.executeWithWal({ effectId: 'eff-kept', runId: 'run-1', laneId: 'lane', path: 'note.txt', newBytes: Buffer.from('new'), expectedHash: before }, async () => { await files.writeBytesIfUnchanged('note.txt', Buffer.from('new'), before) })
      const kept = await manager.reconcilePendingWal(undefined, async () => 'confirmed')
      expect(kept.restored).not.toContain('note.txt')
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('new')
      const current = createHash('sha256').update('new').digest('hex')
      await manager.executeWithWal({ effectId: 'eff-unknown', runId: 'run-1', laneId: 'lane', path: 'note.txt', newBytes: Buffer.from('other'), expectedHash: current }, async () => { await files.writeBytesIfUnchanged('note.txt', Buffer.from('other'), current) })
      await expect(manager.reconcilePendingWal(undefined, async () => 'unknown')).rejects.toThrow('WAL_RECOVERY_UNKNOWN')
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('other')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('enables the office packs and records that the five document operations are implemented', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-docx-'))
    try {
      const docx = await createDocxCapabilityPack().activate({ workspaceRoot: root, config: {}, signal: new AbortController().signal })
      const pdf = await createPdfCapabilityPack().activate({ workspaceRoot: root, config: {}, signal: new AbortController().signal })
      const spreadsheet = await createSpreadsheetCapabilityPack().activate({ workspaceRoot: root, config: {}, signal: new AbortController().signal })
      const pptx = await createPptxCapabilityPack().activate({ workspaceRoot: root, config: {}, signal: new AbortController().signal })
      expect(docx.tools?.map((item) => item.manifest.name)).toEqual(['docx.read', 'docx.write'])
      expect(pdf.tools?.map((item) => item.manifest.name)).toEqual(['pdf.read', 'pdf.page.render'])
      expect(spreadsheet.tools?.map((item) => item.manifest.name)).toEqual(['spreadsheet.inspect', 'spreadsheet.xlsx.write'])
      expect(pptx.tools?.map((item) => item.manifest.name)).toEqual(['pptx.read', 'pptx.write'])
      expect(unimplementedDocumentCapabilities).toEqual([])
      const bin = await readFile(new URL('../packages/cli/src/bin.ts', import.meta.url), 'utf8')
      expect(bin).toContain('createDocxCapabilityPack()')
      expect(bin).toContain('createPptxCapabilityPack()')
      expect(bin).toContain("const enabledCapabilityPacks = ['builtin-skills', ...configuredCapabilityPacks.filter((id) => id !== 'builtin-skills')]")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('spawns MCP with the temp home directories and without secrets or NODE_OPTIONS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-mcp-'))
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('APPDATA', join(root, 'appdata'))
    vi.stubEnv('LOCALAPPDATA', join(root, 'localappdata'))
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
    vi.stubEnv('NODE_OPTIONS', '--inspect')
    vi.stubEnv('SECRET_TOKEN', 'super-secret')
    const script = join(root, 'server.mjs')
    const report = join(root, 'env.json')
    await writeFile(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify({ HOME: process.env.HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null, APPDATA: process.env.APPDATA ?? null, LOCALAPPDATA: process.env.LOCALAPPDATA ?? null, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, SECRET_TOKEN: process.env.SECRET_TOKEN ?? null }))\nlet buffer = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (chunk) => {\n  buffer += chunk\n  let index\n  while ((index = buffer.indexOf('\\n')) >= 0) {\n    const line = buffer.slice(0, index)\n    buffer = buffer.slice(index + 1)\n    if (!line.trim()) continue\n    const message = JSON.parse(line)\n    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0' } } }) + '\\n')\n    if (message.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\\n')\n  }\n})\n`)
    const client = new McpStdioClient({ command: process.execPath, args: [script, report] })
    try {
      await client.connect()
      const seen = JSON.parse(await readFile(report, 'utf8')) as Record<string, string | null>
      expect(seen.HOME).toBe(home)
      expect(seen.USERPROFILE).toBe(home)
      expect(seen.APPDATA).toBe(join(root, 'appdata'))
      expect(seen.LOCALAPPDATA).toBe(join(root, 'localappdata'))
      expect(seen.XDG_CONFIG_HOME).toBe(join(root, 'xdg'))
      expect(seen.NODE_OPTIONS).toBeNull()
      expect(seen.SECRET_TOKEN).toBeNull()
    } finally { await client.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('repeats the deterministic probes for 100 rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-rounds-'))
    try {
      await writeFile(join(root, '.gitignore'), '*.log\n')
      await writeFile(join(root, 'foo'), 'a')
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'foo'), 'b')
      const files = new FilesystemTool(root)
      for (let round = 0; round < 100; round++) {
        expect(resolveModelCapability('gpt-4o', 'openai-compatible').promptCache).toBe('none')
        const preview = utf8HeadTail('汉字'.repeat(8), 10)
        expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(10)
        expect(preview).not.toContain('\uFFFD')
        const current = await readFile(join(root, 'note.txt')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
        await files.writeIfUnchanged('note.txt', 'alpha() \n beta()\n', current ? createHash('sha256').update(current).digest('hex') : null)
        const editor = new ExactPatchEditor(files, undefined, 'normalized')
        await editor.execute({ path: 'note.txt', patches: [{ find: 'alpha()\n', replace: 'changed()\n' }] })
        expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('changed()\n beta()\n')
        expect((await globWorkspace(root, '/foo')).matches.map((item) => item.path)).toEqual(['foo'])
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps both successful writes when the same file is reconciled', async () => {
    const isolated = await isolatedHost()
    const runId = 'wal-chain'
    const oldHash = createHash('sha256').update('old').digest('hex')
    const newHash = createHash('sha256').update('new').digest('hex')
    try {
      const opened = await openSurface(isolated, runId)
      const outcome = await opened.runtime.start(opened.runtime.createAgent('Write then patch', twoWriteProgram(oldHash)).agentId).outcome()
      expect(outcome.status).toBe('succeeded')
      const result = opened.runtime.state.results.get(outcome.resultRef!)?.value as Array<{ error: string | null }>
      expect(result.every((item) => item.error === null)).toBe(true)
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      const reconciled = await isolated.host.reconcileWorkspaceWal(isolated.root, opened.runtime as never, runId, isolated.conversation.id)
      expect(reconciled.restored).not.toContain('a.txt')
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      const walNames = await readdir(join(isolated.root, '.pulse', 'file-snapshots', 'wal')).catch(() => [])
      expect(walNames.filter((name) => name.endsWith('.json'))).toEqual([])
      const history = await readdir(join(isolated.root, '.pulse', 'file-snapshots', 'history'))
      expect(history.filter((name) => name.endsWith('.json')).length).toBe(2)
      await expect(isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: oldHash }] })).rejects.toMatchObject({ code: 'ROLLBACK_TARGET_MODIFIED_EXTERNALLY' })
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      const undone = await isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: newHash }] })
      expect(undone.status).toBe('completed')
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('old')
      await expect(isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: oldHash }] })).resolves.toMatchObject({ status: 'completed' })
      await expect(readFile(join(isolated.root, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('reconciles the delivered chain from a later run and restores only an unsettled tail', async () => {
    const isolated = await isolatedHost()
    const oldHash = createHash('sha256').update('old').digest('hex')
    const newHash = createHash('sha256').update('new').digest('hex')
    try {
      const first = await openSurface(isolated, 'wal-first')
      const outcome = await first.runtime.start(first.runtime.createAgent('Write then patch', twoWriteProgram(oldHash)).agentId).outcome()
      expect(outcome.status).toBe('succeeded')
      const later = await openSurface(isolated, 'wal-later')
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      const external = await isolatedHost()
      try {
        const opened = await openSurface(external, 'wal-external')
        const wrote = await opened.runtime.start(opened.runtime.createAgent('Write then patch', twoWriteProgram(oldHash)).agentId).outcome()
        expect(wrote.status).toBe('succeeded')
        await writeFile(join(external.root, 'a.txt'), 'tampered')
        const settled = await external.host.reconcileWorkspaceWal(external.root, opened.runtime as never, 'wal-external', external.conversation.id)
        expect(settled.restored).not.toContain('a.txt')
        expect(await readFile(join(external.root, 'a.txt'), 'utf8')).toBe('tampered')
        const files = new FilesystemTool(external.root)
        await new FileSnapshotManager(external.root, files).beginJournal({ effectId: 'eff-open', runId: 'wal-external', laneId: 'lane', agentId: 'agent', conversationId: external.conversation.id, path: 'a.txt', before: Buffer.from('new'), next: Buffer.from('other') })
        opened.runtime.state.effects.set('eff-open', { outcome: { status: 'failed' }, executionState: 'failed', input: { name: 'fs.write' } })
        await expect(external.host.reconcileWorkspaceWal(external.root, opened.runtime as never, 'wal-external', external.conversation.id)).rejects.toMatchObject({ code: 'WAL_RECOVERY_EXTERNAL_CONFLICT' })
        expect(await readFile(join(external.root, 'a.txt'), 'utf8')).toBe('tampered')
      } finally { await external.host.close(); await rm(external.root, { recursive: true, force: true }) }
      const tail = await isolatedHost()
      try {
        const opened = await openSurface(tail, 'wal-tail')
        const program = defineLaneProgram({ id: 'one-write', version: '1' }, (builder) => {
          builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('write-a', 'fs.write', { path: 'a.txt', content: 'old' })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
          builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
        })
        expect((await opened.runtime.start(opened.runtime.createAgent('Create', program).agentId).outcome()).status).toBe('succeeded')
        const files = new FilesystemTool(tail.root)
        const manager = new FileSnapshotManager(tail.root, files)
        await manager.executeWithWal({ effectId: 'eff-unsettled', runId: 'wal-tail', laneId: 'lane', path: 'a.txt', newBytes: Buffer.from('new'), expectedHash: oldHash, conversationId: tail.conversation.id }, async () => { await files.writeBytesIfUnchanged('a.txt', Buffer.from('new'), oldHash) })
        await expect(tail.host.reconcileWorkspaceWal(tail.root, opened.runtime as never, 'wal-tail', tail.conversation.id)).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
        expect(await readFile(join(tail.root, 'a.txt'), 'utf8')).toBe('new')
        opened.runtime.state.effects.set('eff-unsettled', { outcome: { status: 'failed' }, executionState: 'failed', input: { name: 'fs.write' } })
        const recovered = await tail.host.reconcileWorkspaceWal(tail.root, opened.runtime as never, 'wal-tail', tail.conversation.id)
        expect(recovered.restored).toContain('a.txt')
        expect(await readFile(join(tail.root, 'a.txt'), 'utf8')).toBe('old')
        expect(newHash).toHaveLength(64)
      } finally { await tail.host.close(); await rm(tail.root, { recursive: true, force: true }) }
      expect(later.runtime).toBeTruthy()
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('refuses a snapshot store reached through a workspace symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'pulse-outside-'))
    try {
      await symlink(outside, join(root, '.pulse'))
      const manager = new FileSnapshotManager(root, new FilesystemTool(root))
      await expect(manager.beginJournal({ effectId: 'eff-link', runId: 'run-1', laneId: 'lane', agentId: 'agent', conversationId: 'conv', path: 'a.txt', before: Buffer.from('old'), next: Buffer.from('new') })).rejects.toMatchObject({ code: 'WAL_PATH_ESCAPE' })
      expect(await readdir(outside)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })

  it('binds rollback to the recorded run when scope is omitted and blocks an unknown process', async () => {
    const isolated = await isolatedHost('continuous')
    const runId = 'wal-undo'
    const oldHash = createHash('sha256').update('old').digest('hex')
    const newHash = createHash('sha256').update('new').digest('hex')
    try {
      const opened = await openSurface(isolated, runId)
      const outcome = await opened.runtime.start(opened.runtime.createAgent('Write then patch', twoWriteProgram(oldHash)).agentId).outcome()
      expect(outcome.status).toBe('succeeded')
      await isolated.host.reconcileWorkspaceWal(isolated.root, opened.runtime as never, runId, isolated.conversation.id)
      const shellDirectory = join(isolated.runDirectory(runId), 'shell-processes')
      await mkdir(shellDirectory, { recursive: true })
      const processId = 'b'.repeat(64)
      const receipt = join(shellDirectory, `${processId}.json`)
      await writeFile(receipt, JSON.stringify({ processId, agentId: 'agent', laneId: 'lane', status: 'unknown', command: { command: 'fixture' } }))
      await expect(isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: newHash }] })).rejects.toMatchObject({ code: 'SHELL_PROCESS_STATE_UNKNOWN' })
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      await expect(isolated.host.rollbackFiles({ confirm: true, conversationId: 'other-conversation', runId: 'other-run', targets: [{ path: 'a.txt', expectedPostHash: newHash }] })).rejects.toMatchObject({ code: 'ROLLBACK_SCOPE_MISMATCH' })
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      await writeFile(receipt, JSON.stringify({ processId, agentId: 'agent', laneId: 'lane', status: 'exited', command: { command: 'fixture' } }))
      const undone = await isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: newHash }] })
      expect(undone.status).toBe('completed')
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('old')
      const readOnly = new LocalHost({ cwd: isolated.root, dataDir: join(isolated.root, 'readonly-data'), provider: { provider: 'mock' }, approvalMode: 'read-only', jarvis: { enabled: false } })
      await readOnly.init()
      try {
        await expect(readOnly.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: oldHash }] })).rejects.toMatchObject({ code: 'WRITE_DISABLED_READ_ONLY' })
        expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('old')
      } finally { await readOnly.close() }
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('refuses recovery and rollback through a snapshot ancestor symlink', async () => {
    const isolated = await isolatedHost()
    const outside = await mkdtemp(join(tmpdir(), 'pulse-outside-'))
    try {
      const store = join(outside, 'file-snapshots')
      await mkdir(join(store, 'wal'), { recursive: true })
      await mkdir(join(store, 'blobs'))
      const before = Buffer.from('old')
      const beforeHash = createHash('sha256').update(before).digest('hex')
      const postHash = createHash('sha256').update('new').digest('hex')
      await writeFile(join(store, 'blobs', beforeHash), before)
      await writeFile(join(isolated.root, 'a.txt'), 'new')
      await writeFile(join(store, 'wal', 'eff-symlink.json'), JSON.stringify({ effectId: 'eff-symlink', runId: 'wal-link', laneId: 'lane', conversationId: isolated.conversation.id, path: 'a.txt', preState: 'present', beforeHash, intendedPostHash: postHash, status: 'pending', kind: 'write', createdAt: 1 }))
      await symlink(outside, join(isolated.root, '.pulse'))
      await expect(isolated.host.reconcileWorkspaceWal(isolated.root, undefined, 'wal-link')).rejects.toMatchObject({ code: 'WAL_PATH_ESCAPE' })
      await expect(isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: postHash }] })).rejects.toMatchObject({ code: 'WAL_PATH_ESCAPE' })
      expect(await readFile(join(isolated.root, 'a.txt'), 'utf8')).toBe('new')
      expect(await readdir(join(store, 'wal'))).toEqual(['eff-symlink.json'])
      expect(await readFile(join(store, 'blobs', beforeHash))).toEqual(before)
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })

  it('restores the original bytes of an unsettled delete and leaves a delivered delete removed', async () => {
    const isolated = await isolatedHost()
    const runId = 'delete-run'
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x10])
    const hash = createHash('sha256').update(bytes).digest('hex')
    try {
      const opened = await openSurface(isolated, runId)
      await writeFile(join(isolated.root, 'bin.dat'), bytes)
      const files = new FilesystemTool(isolated.root)
      const manager = new FileSnapshotManager(isolated.root, files)
      await manager.beginJournal({ effectId: 'eff-delete', runId, laneId: 'lane', agentId: 'agent', conversationId: isolated.conversation.id, path: 'bin.dat', before: bytes, next: null })
      await files.removeIfUnchanged('bin.dat', hash)
      await manager.markLanded({ effectId: 'eff-delete', runId, laneId: 'lane', agentId: 'agent', conversationId: isolated.conversation.id })
      await expect(isolated.host.reconcileWorkspaceWal(isolated.root, opened.runtime as never, runId, isolated.conversation.id)).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
      await expect(readFile(join(isolated.root, 'bin.dat'))).rejects.toMatchObject({ code: 'ENOENT' })
      opened.runtime.state.effects.set('eff-delete', { outcome: { status: 'failed' }, executionState: 'failed', input: { name: 'fs.write' } })
      const recovered = await isolated.host.reconcileWorkspaceWal(isolated.root, opened.runtime as never, runId, isolated.conversation.id)
      expect(recovered.restored).toContain('bin.dat')
      expect(await readFile(join(isolated.root, 'bin.dat'))).toEqual(bytes)
      const again = await isolated.host.reconcileWorkspaceWal(isolated.root, opened.runtime as never, runId, isolated.conversation.id)
      expect(again.restored).not.toContain('bin.dat')
      expect(await readFile(join(isolated.root, 'bin.dat'))).toEqual(bytes)
      const replaced = await mkdtemp(join(tmpdir(), 'pulse-recreated-'))
      try {
        const replacedBytes = Buffer.from([0x11, 0x22])
        await writeFile(join(replaced, 'bin.dat'), bytes)
        const replacedFiles = new FilesystemTool(replaced)
        const replacedManager = new FileSnapshotManager(replaced, replacedFiles)
        await replacedManager.beginJournal({ effectId: 'eff-recreated', runId: 'other', laneId: 'lane', agentId: 'agent', conversationId: 'conv', path: 'bin.dat', before: bytes, next: null })
        await replacedFiles.removeIfUnchanged('bin.dat', hash)
        await replacedManager.markLanded({ effectId: 'eff-recreated', runId: 'other', laneId: 'lane', agentId: 'agent', conversationId: 'conv' })
        await writeFile(join(replaced, 'bin.dat'), replacedBytes)
        await expect(replacedManager.reconcilePendingWal(undefined, async () => 'unconfirmed')).rejects.toMatchObject({ code: 'WAL_RECOVERY_EXTERNAL_CONFLICT' })
        expect(await readFile(join(replaced, 'bin.dat'))).toEqual(replacedBytes)
      } finally { await rm(replaced, { recursive: true, force: true }) }
      const kept = await mkdtemp(join(tmpdir(), 'pulse-deleted-'))
      try {
        await writeFile(join(kept, 'bin.dat'), bytes)
        const keptFiles = new FilesystemTool(kept)
        const keptManager = new FileSnapshotManager(kept, keptFiles)
        await keptManager.beginJournal({ effectId: 'eff-kept', runId: 'other', laneId: 'lane', agentId: 'agent', conversationId: 'conv', path: 'bin.dat', before: bytes, next: null })
        await keptFiles.removeIfUnchanged('bin.dat', hash)
        await keptManager.markLanded({ effectId: 'eff-kept', runId: 'other', laneId: 'lane', agentId: 'agent', conversationId: 'conv' })
        const confirmed = await keptManager.reconcilePendingWal(undefined, async () => 'confirmed')
        expect(confirmed.restored).not.toContain('bin.dat')
        await expect(readFile(join(kept, 'bin.dat'))).rejects.toMatchObject({ code: 'ENOENT' })
        await keptManager.beginJournal({ effectId: 'eff-unknown', runId: 'other', laneId: 'lane', agentId: 'agent', conversationId: 'conv', path: 'bin.dat', before: Buffer.from('x'), next: null })
        await expect(keptManager.reconcilePendingWal(undefined, async () => 'unknown')).rejects.toThrow('WAL_RECOVERY_UNKNOWN')
        await expect(readFile(join(kept, 'bin.dat'))).rejects.toMatchObject({ code: 'ENOENT' })
        const keptNames = await readdir(join(kept, '.pulse', 'file-snapshots', 'wal'))
        const keptRecords = await Promise.all(keptNames.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(kept, '.pulse', 'file-snapshots', 'wal', name), 'utf8')) as { effectId?: string }))
        expect(keptRecords.map((record) => record.effectId)).toContain('eff-unknown')
      } finally { await rm(kept, { recursive: true, force: true }) }
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('creates one real snapshot store when journals and host writes start together', async () => {
    const isolated = await isolatedHost()
    try {
      const managers = Array.from({ length: 12 }, () => new FileSnapshotManager(isolated.root, new FilesystemTool(isolated.root)))
      const separate = await Promise.allSettled(managers.map((manager, index) => manager.beginJournal({ effectId: `eff-${index}`, runId: 'run-race', laneId: 'lane', agentId: 'agent', conversationId: isolated.conversation.id, path: `f${index}.txt`, before: null, next: Buffer.from(`v${index}`) })))
      expect(separate.every(item => item.status === 'fulfilled')).toBe(true)
      const shared = new FileSnapshotManager(isolated.root, new FilesystemTool(isolated.root))
      const repeated = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => shared.beginJournal({ effectId: `same-${index}`, runId: 'run-race', laneId: 'lane', agentId: 'agent', conversationId: isolated.conversation.id, path: `g${index}.txt`, before: null, next: Buffer.from(`g${index}`) })))
      expect(repeated.every(item => item.status === 'fulfilled')).toBe(true)
      expect((await readdir(join(isolated.root, '.pulse/file-snapshots/wal'))).filter((name) => name.endsWith('.json'))).toHaveLength(24)
      await rm(join(isolated.root, '.pulse/file-snapshots'), { recursive: true, force: true })
      const opened = await openSurface(isolated, 'race-host') as { registry: { get: (name: string) => { execute: (input: { path: string; content: string }, context: { toolCallId: string; effectId: string; attemptId: string; agentId: string; laneId: string; signal: AbortSignal; emit: () => void }) => Promise<{ path: string }> } } }
      await Promise.all(Array.from({ length: 3 }, (_, index) => opened.registry.get('fs.write').execute({ path: `host-${index}.txt`, content: `h${index}` }, { toolCallId: `w${index}`, effectId: `host-eff-${index}`, attemptId: '1', agentId: 'agent', laneId: 'lane', signal: AbortSignal.timeout(5000), emit: () => undefined })))
      for (const index of [0, 1, 2]) expect(await readFile(join(isolated.root, `host-${index}.txt`), 'utf8')).toBe(`h${index}`)
    } finally { await isolated.host.close(); await rm(isolated.root, { recursive: true, force: true }) }
  })

  it('settles a successful write before another host records it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-cross-host-'))
    const note = join(root, 'note.txt')
    const before = 'before\n', after = 'after\n'
    const beforeHash = createHash('sha256').update(before).digest('hex')
    const afterHash = createHash('sha256').update(after).digest('hex')
    const hosts: LocalHost[] = []
    const open = (dataDir: string, toolName: string, input: Record<string, unknown>) => {
      const host = new LocalHost({ cwd: root, dataDir, provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false }, mockToolCalls: [{ name: toolName, input }], mockAfterToolResponse: 'done' })
      hosts.push(host)
      return host
    }
    try {
      await writeFile(note, before)
      const first = open(join(root, 'data-A'), 'fs.apply_patch', { path: 'note.txt', find: 'before', replace: 'after', expectedHash: beforeHash })
      await first.init()
      const run = await first.sendMessage((await first.createConversation()).id, { text: 'patch note' })
      expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
      expect(await readFile(note, 'utf8')).toBe(after)
      expect((await readdir(join(root, '.pulse/file-snapshots/wal'))).filter((name) => name.endsWith('.json'))).toEqual([])
      expect((await readdir(join(root, '.pulse/file-snapshots/history'))).some((name) => name.endsWith('.json'))).toBe(true)
      await first.close()
      const restarted = open(join(root, 'data-A'), 'fs.read', { path: 'note.txt' })
      await restarted.init()
      expect(await (await restarted.sendMessage((await restarted.createConversation()).id, { text: 'read the settled note' })).outcome()).toMatchObject({ status: 'succeeded' })
      expect(await readFile(note, 'utf8')).toBe(after)
      await restarted.close()
      const second = open(join(root, 'data-B'), 'artifact.record', { path: 'note.txt', mediaType: 'text/plain', label: 'note' })
      await second.init()
      const other = await second.createConversation()
      expect(await (await second.sendMessage(other.id, { text: 'record the note' })).outcome()).toMatchObject({ status: 'succeeded' })
      expect(await readFile(note, 'utf8')).toBe(after)
      await expect(second.listArtifacts(other.id)).resolves.toEqual([expect.objectContaining({ path: 'note.txt', hash: afterHash, bytes: Buffer.byteLength(after) })])
      await second.close()
      const owner = new LocalHost({ cwd: root, dataDir: join(root, 'data-A'), provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false } })
      hosts.push(owner)
      await owner.init()
      expect((await owner.rollbackFiles({ confirm: true, targets: [{ path: 'note.txt', expectedPostHash: afterHash }] })).status).toBe('completed')
      expect(await readFile(note, 'utf8')).toBe(before)
    } finally { await Promise.all(hosts.map((host) => host.close())); await rm(root, { recursive: true, force: true }) }
  })

  it('blocks an unsettled write when another host has no owner receipt, then lets the owner restore it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-cross-host-open-'))
    const note = join(root, 'note.txt')
    const before = Buffer.from('before\n'), after = Buffer.from('after\n')
    const hosts: LocalHost[] = []
    try {
      await writeFile(note, before)
      const files = new FilesystemTool(root)
      const manager = new FileSnapshotManager(root, files)
      await manager.beginJournal({ effectId: 'eff-open', runId: 'run-A', laneId: 'lane', agentId: 'agent', conversationId: 'conv-01234567-89ab-4cde-8fab-0123456789ab', path: 'note.txt', before, next: after })
      await files.writeBytesIfUnchanged('note.txt', after, createHash('sha256').update(before).digest('hex'))
      await manager.markLanded({ effectId: 'eff-open', runId: 'run-A', laneId: 'lane', agentId: 'agent', conversationId: 'conv-01234567-89ab-4cde-8fab-0123456789ab' })
      const other = new LocalHost({ cwd: root, dataDir: join(root, 'data-B'), provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false }, mockToolCalls: [{ name: 'artifact.record', input: { path: 'note.txt', mediaType: 'text/plain', label: 'note' } }], mockAfterToolResponse: 'recorded' })
      hosts.push(other)
      await other.init()
      await expect(other.sendMessage((await other.createConversation()).id, { text: 'record without the owner receipt' })).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
      expect(await readFile(note, 'utf8')).toBe('after\n')
      const openNames = await readdir(join(root, '.pulse/file-snapshots/wal'))
      const openRecords = await Promise.all(openNames.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(root, '.pulse/file-snapshots/wal', name), 'utf8')) as { effectId?: string }))
      expect(openRecords.map((record) => record.effectId)).toContain('eff-open')
      const owner = new LocalHost({ cwd: root, dataDir: join(root, 'data-A'), provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false } })
      hosts.push(owner)
      const runtime = { state: { effects: new Map([['eff-open', { outcome: { status: 'failed' }, executionState: 'failed', input: { name: 'fs.apply_patch' } }]]) } }
      const recovered = await owner.reconcileWorkspaceWal(root, runtime as never, 'run-A', 'conv-01234567-89ab-4cde-8fab-0123456789ab')
      expect(recovered.restored).toContain('note.txt')
      expect(await readFile(note, 'utf8')).toBe('before\n')
    } finally { await Promise.all(hosts.map((host) => host.close())); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps another run when a saved snapshot reuses its effect id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-owner-collision-'))
    const hosts: LocalHost[] = []
    const convB = 'conv-01234567-89ab-4cde-8fab-0123456789ab'
    try {
      const first = new LocalHost({ cwd: root, dataDir: join(root, 'data-A'), provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false }, mockToolCalls: [{ name: 'fs.write', input: { path: 'a.txt', content: 'A committed' } }], mockAfterToolResponse: 'done' })
      hosts.push(first)
      await first.init()
      const conversation = await first.createConversation()
      const run = await first.sendMessage(conversation.id, { text: 'create a.txt' })
      expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A committed')
      const backend = await (first as unknown as { persistenceFor: (conversationId: string, runId: string) => Promise<{ load: () => Promise<any>; save: (snapshot: unknown) => Promise<void> }> }).persistenceFor(conversation.id, run.id)
      const snapshot = await backend.load()
      const entry = snapshot.state.state.effects.find(([, effect]) => effect.input?.name === 'fs.write' && effect.outcome?.status === 'succeeded')
      const effectId = entry?.[0]
      expect(effectId).toBeTruthy()
      const manager = new FileSnapshotManager(root, new FilesystemTool(root))
      await writeFile(join(root, 'b.txt'), 'B pending')
      let release = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const lateSave = (async () => { await gate; await backend.save(snapshot) })()
      await manager.beginJournal({ effectId: effectId!, runId: 'run-B', laneId: 'lane-1', agentId: 'agent-1', conversationId: convB, path: 'b.txt', before: Buffer.from('B original'), next: Buffer.from('B pending') })
      await manager.markLanded({ effectId: effectId!, runId: 'run-B', laneId: 'lane-1', agentId: 'agent-1', conversationId: convB })
      const walDir = join(root, '.pulse/file-snapshots/wal')
      await writeFile(join(walDir, 'effect-2.json'), JSON.stringify({ effectId, runId: run.id, laneId: entry?.[1].ownerLaneId ?? 'lane-1', agentId: entry?.[1].agentId ?? 'agent-1', conversationId: conversation.id, path: 'a.txt', preState: 'absent', beforeHash: null, intendedPostHash: createHash('sha256').update('A committed').digest('hex'), status: 'landed', kind: 'write', createdAt: 1, order: 1 }))
      const pair = join(root, 'pair')
      await mkdir(pair)
      const pairManager = new FileSnapshotManager(pair, new FilesystemTool(pair))
      await Promise.all(['run-X', 'run-Y'].map((runId) => pairManager.beginJournal({ effectId: 'effect-1', runId, laneId: 'lane-1', agentId: 'agent-1', conversationId: runId === 'run-X' ? 'conv-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' : 'conv-11111111-2222-4333-8444-555555555555', path: `${runId}.txt`, before: null, next: Buffer.from(runId) })))
      const pairDir = join(pair, '.pulse/file-snapshots/wal')
      const pairRecords = await Promise.all((await readdir(pairDir)).filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(pairDir, name), 'utf8')) as { effectId: string; runId: string }))
      expect(pairRecords).toHaveLength(2)
      expect(pairRecords.map((record) => record.effectId)).toEqual(['effect-1', 'effect-1'])
      expect(new Set(pairRecords.map((record) => record.runId))).toEqual(new Set(['run-X', 'run-Y']))
      release()
      await lateSave
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A committed')
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B pending')
      const walNames = (await readdir(walDir)).filter((name) => name.endsWith('.json'))
      expect(walNames).not.toContain('effect-2.json')
      const remaining = await Promise.all(walNames.map(async (name) => JSON.parse(await readFile(join(walDir, name), 'utf8')) as { effectId: string; runId: string; path: string }))
      expect(remaining).toEqual([expect.objectContaining({ effectId, runId: 'run-B', path: 'b.txt' })])
      const historyDir = join(root, '.pulse/file-snapshots/history')
      const history = await Promise.all((await readdir(historyDir)).filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(historyDir, name), 'utf8')) as { path: string; effectId: string }))
      expect(history.some((record) => record.path === 'a.txt' && record.effectId === effectId)).toBe(true)
      expect(history.some((record) => record.path === 'b.txt')).toBe(false)
      const other = new LocalHost({ cwd: root, dataDir: join(root, 'data-B'), provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false }, mockToolCalls: [{ name: 'artifact.record', input: { path: 'b.txt', mediaType: 'text/plain', label: 'b' } }], mockAfterToolResponse: 'recorded' })
      hosts.push(other)
      await other.init()
      await expect(other.sendMessage((await other.createConversation()).id, { text: 'record without the owner receipt' })).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B pending')
      const owner = new LocalHost({ cwd: root, dataDir: join(root, 'data-A'), provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false } })
      hosts.push(owner)
      const mismatched = { state: { effects: new Map([[effectId, { outcome: { status: 'failed' }, executionState: 'failed', input: { name: 'fs.write' }, agentId: 'agent-1', ownerLaneId: 'lane-9' }]]) } }
      await expect(owner.reconcileWorkspaceWal(root, mismatched as never, 'run-B', convB)).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B pending')
      const failed = { state: { effects: new Map([[effectId, { outcome: { status: 'failed' }, executionState: 'failed', input: { name: 'fs.write' }, agentId: 'agent-1', ownerLaneId: 'lane-1' }]]) } }
      const recovered = await owner.reconcileWorkspaceWal(root, failed as never, 'run-B', convB)
      expect(recovered.restored).toContain('b.txt')
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B original')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A committed')
    } finally { await Promise.all(hosts.map((host) => host.close())); await rm(root, { recursive: true, force: true }) }
  })

  it('settles concurrent runs that reuse effect ids and undoes only the addressed owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-owner-undo-'))
    const hosts: LocalHost[] = []
    try {
      const open = (dataDir: string, path: string, content: string) => {
        const host = new LocalHost({ cwd: root, dataDir, provider: { provider: 'mock' }, approvalMode: 'auto', jarvis: { enabled: false }, mockToolCalls: [{ name: 'fs.write', input: { path, content } }], mockAfterToolResponse: 'done' })
        hosts.push(host)
        return host
      }
      const hostA = open(join(root, 'data-A'), 'a.txt', 'A committed')
      const hostC = open(join(root, 'data-C'), 'c.txt', 'C committed')
      await Promise.all([hostA.init(), hostC.init()])
      const [runA, runC] = await Promise.all([
        hostA.createConversation().then((conversation) => hostA.sendMessage(conversation.id, { text: 'write a' })),
        hostC.createConversation().then((conversation) => hostC.sendMessage(conversation.id, { text: 'write c' })),
      ])
      expect(await runA.outcome()).toMatchObject({ status: 'succeeded' })
      expect(await runC.outcome()).toMatchObject({ status: 'succeeded' })
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A committed')
      expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('C committed')
      expect((await readdir(join(root, '.pulse/file-snapshots/wal'))).filter((name) => name.endsWith('.json'))).toEqual([])
      const historyDir = join(root, '.pulse/file-snapshots/history')
      const history = await Promise.all((await readdir(historyDir)).filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(historyDir, name), 'utf8')) as { effectId: string; runId: string; path: string }))
      const writes = history.filter((record) => record.path === 'a.txt' || record.path === 'c.txt')
      expect(writes.map((record) => record.effectId)).toEqual([writes[0]!.effectId, writes[0]!.effectId])
      expect(new Set(writes.map((record) => record.runId)).size).toBe(2)
      const hash = createHash('sha256').update(await readFile(join(root, 'a.txt'))).digest('hex')
      expect((await hostA.rollbackFiles({ confirm: true, targets: [{ path: 'a.txt', expectedPostHash: hash }] })).status).toBe('completed')
      await expect(readFile(join(root, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('C committed')
    } finally { await Promise.all(hosts.map((host) => host.close())); await rm(root, { recursive: true, force: true }) }
  })

  it('parses the files rollback entry', () => {
    const hash = 'a'.repeat(64)
    const parsed = parse(['files', 'rollback', '--confirm', `a.txt:${hash}`])
    expect(parsed.command).toBe('files')
    expect(parsed.options.confirm).toBe(true)
    expect(option(parsed.options, 'conversation')).toBeUndefined()
    expect(option(parsed.options, 'run')).toBeUndefined()
    const scoped = parse(['files', 'rollback', '--confirm', `a.txt:${hash}`, '--conversation', 'conv', '--run', 'run-1'])
    expect(option(scoped.options, 'conversation')).toBe('conv')
    expect(option(scoped.options, 'run')).toBe('run-1')
  })
})
