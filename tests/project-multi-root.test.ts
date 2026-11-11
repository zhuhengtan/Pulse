import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, relative } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defineLaneProgram, type PulseRuntime } from '@hunterzhu/pulse-runtime'
import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import { FilesystemTool, createDocumentTools, officeBinaryWriter } from '@hunterzhu/pulse-adapters'
import { createDocxCapabilityPack, createPdfCapabilityPack, createPptxCapabilityPack, createSpreadsheetCapabilityPack } from '../packages/server/src/capabilities.js'
import { LocalHost, H5Server } from '../packages/server/src/index.js'
import { H5ProjectCatalog } from '../packages/server/src/h5/projects.js'
import { buildSystemPrompt } from '../packages/server/src/prompt.js'
import { captureWorkspaceAccess, restoreWorkspaceAccess, WorkspaceReadAccess } from '../packages/server/src/workspace-access.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const context = { toolCallId: 'call', effectId: 'effect', attemptId: 'attempt', agentId: 'parent', laneId: 'parent-lane', signal: new AbortController().signal, emit: () => {} }

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pulse-project-multi-root-')))
  const primary = join(base, 'primary'), secondary = join(base, 'secondary'), outside = join(base, 'outside'), dataDir = join(base, 'data')
  await Promise.all([primary, secondary, outside].map(path => mkdir(path)))
  const options = { cwd: primary, dataDir, provider: { provider: 'mock' as const }, approvalMode: 'auto' as const, taskController: false, jarvis: { enabled: false }, providerModels: { vision: { provider: 'mock', model: 'vision', imageInput: 'supported' as const } }, taskRouting: { vision: ['vision'] } }
  const host = new LocalHost(options)
  await host.init()
  const conversation = await host.createConversation()
  disposals.push(async () => { await host.close(); await rm(base, { recursive: true, force: true }) })
  await writeFile(join(primary, 'note.txt'), 'primary note')
  await mkdir(join(secondary, 'nested'))
  await writeFile(join(secondary, 'nested/note.txt'), 'secondary needle\nsecond line\n')
  await writeFile(join(outside, 'secret.txt'), 'not authorized')
  const open = async (id = 'multi-root', restore = false) => {
    const runDir = join(dataDir, 'conversations', conversation.id, 'runs', id)
    if (!restore) {
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'input.json'), JSON.stringify({ fileSurfaceVersion: 3, patchApplyVersion: 2, shellSurfaceVersion: 1, workspaceAccess: await captureWorkspaceAccess(primary, [secondary]) }))
    }
    const opened = await (host as any)[restore ? 'restoreRuntimeFor' : 'runtimeFor'](conversation.id, id, primary, ...(restore ? [[], undefined, options] : ['read project folders', '', options])) as { runtime: PulseRuntime; registry: ToolRegistry; capabilities: { dispose(): Promise<void> }; capabilityController: AbortController }
    disposals.push(async () => { await opened.runtime.shutdown(); opened.capabilityController.abort(); await opened.capabilities.dispose() })
    return { ...opened, runDir }
  }
  return { base, primary, secondary, outside, dataDir, options, host, conversation, open }
}

it('reads added folders through every builtin file read tool with unambiguous returned paths', async () => {
  const f = await fixture(), { registry } = await f.open(), file = join(f.secondary, 'nested/note.txt')
  expect(await registry.execute('fs.read', { path: 'note.txt' }, context)).toMatchObject({ content: 'primary note' })
  expect(await registry.execute('fs.read', { path: file, startLine: 2 }, context)).toMatchObject({ content: 'second line\n', hash: digest('secondary needle\nsecond line\n') })
  expect(await registry.execute('fs.read', { path: relative(f.primary, file) }, context)).toMatchObject({ content: 'secondary needle\nsecond line\n' })
  expect(await registry.execute('fs.list', { path: f.secondary }, context)).toMatchObject({ entries: ['nested'] })
  expect(await registry.execute('fs.search', { path: f.secondary, query: 'needle' }, context)).toMatchObject({ matches: [{ path: file, line: 1, text: 'secondary needle' }] })
  expect(await registry.execute('fs.glob', { path: f.secondary, pattern: '**/*.txt' }, context)).toMatchObject({ matches: [{ path: file }] })
  const image = join(f.secondary, 'pixel.png')
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
  expect(await registry.execute('fs.view_image', { path: image }, context)).toMatchObject({ mediaType: 'image/png', bytes: 70 })
  expect(await registry.execute('artifact.record', { path: file }, context)).toMatchObject({ path: file, hash: digest('secondary needle\nsecond line\n') })
  expect(registry.get('fs.read')!.manifest.permissions!.workspaceRoots).toEqual([f.primary, f.secondary])
  expect(registry.get('fs.write')!.manifest.permissions!.workspaceRoots).toEqual([f.primary])
})

it('keeps search and glob results from duplicate names and secondary-only files directly readable', async () => {
  const f = await fixture(), { registry } = await f.open()
  await mkdir(join(f.primary, 'nested'))
  const files = [
    { root: f.primary, name: 'shared.md', content: 'multi-root-readback primary duplicate' },
    { root: f.secondary, name: 'shared.md', content: 'multi-root-readback secondary duplicate' },
    { root: f.secondary, name: 'secondary-only.md', content: 'multi-root-readback secondary only' },
  ]
  for (const file of files) await writeFile(join(file.root, 'nested', file.name), file.content)
  for (const root of [f.primary, f.secondary]) {
    const expected = files.filter(file => file.root === root).map(file => ({
      path: root === f.primary ? `nested/${file.name}` : join(root, 'nested', file.name), content: file.content,
    }))
    for (const [tool, input] of [
      ['fs.search', { path: root, query: 'multi-root-readback' }],
      ['fs.glob', { path: root, pattern: '**/*.md' }],
    ] as const) {
      const result = await registry.execute(tool, input, context) as { matches: Array<{ path: string }> }
      expect(result.matches.map(match => match.path).sort()).toEqual(expected.map(file => file.path).sort())
      for (const match of result.matches) {
        const file = expected.find(file => file.path === match.path)!
        expect(await registry.execute('fs.read', { path: match.path }, context)).toMatchObject({ content: file.content, hash: digest(file.content) })
      }
    }
  }
})

it('rejects canonical home, its aliases and ancestors before the changed-root guard', async () => {
  const f = await fixture(), home = await realpath(homedir()), alias = join(f.base, 'home-alias')
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  for (const root of new Set([homedir(), home, dirname(home), parse(home).root, alias])) {
    await expect(captureWorkspaceAccess(f.primary, [root])).rejects.toThrow('SANDBOX_READ_ROOT_TOO_BROAD')
  }
  const secondaryAlias = join(f.base, 'secondary-alias')
  await symlink(f.secondary, secondaryAlias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(captureWorkspaceAccess(f.primary, [secondaryAlias])).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
})

it('keeps creation, staged writes, edits, removal, and both move endpoints primary-only', async () => {
  const f = await fixture(), { registry } = await f.open(), file = join(f.secondary, 'nested/note.txt'), hash = digest('secondary needle\nsecond line\n')
  for (const [name, input] of [
    ['fs.write', { path: join(f.secondary, 'new.txt'), content: 'no' }],
    ['fs.stage', { path: join(f.secondary, 'new.txt'), content: 'no' }],
    ['fs.apply_patch', { path: file, expectedHash: hash, find: 'secondary', replace: 'changed' }],
    ['fs.apply_patches', { path: file, expectedHash: hash, patches: [{ find: 'secondary', replace: 'changed' }, { find: 'second line', replace: 'changed line' }] }],
    ['fs.move', { source: file, destination: 'stolen.txt' }],
    ['fs.move', { source: 'note.txt', destination: join(f.secondary, 'moved.txt') }],
  ] as const) await expect(registry.execute(name, input, context)).rejects.toThrow(/PATH_OUTSIDE_SANDBOX|PATH_OUTSIDE_WORKSPACE/)
  const writer = new FilesystemTool(f.primary)
  await expect(writer.removeIfUnchanged(file, hash)).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
  await expect(writer.write(file, 'no')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
  await expect(writer.editText(file, 1000, async () => ({ content: 'no', result: null }))).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
  await expect(writer.writeBytesIfUnchanged(file, Buffer.from('no'), hash)).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
  expect(await readFile(file, 'utf8')).toBe('secondary needle\nsecond line\n')
  expect(await readFile(join(f.primary, 'note.txt'), 'utf8')).toBe('primary note')
  expect(await registry.execute('fs.write', { path: 'new.txt', content: 'yes' }, context)).toMatchObject({ bytes: 3 })
})

it('rejects unregistered paths, secondary symlink escapes and replacement of a captured root', async () => {
  const f = await fixture(), { registry } = await f.open()
  await symlink(f.outside, join(f.secondary, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(f.secondary, join(f.primary, 'secondary-link'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [join(f.outside, 'secret.txt'), join(f.secondary, 'escape/secret.txt'), join(f.primary, 'secondary-link/nested/note.txt')]) {
    await expect(registry.execute('fs.read', { path }, context)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
  }
  await expect(registry.execute('fs.list', { path: join(f.secondary, 'escape') }, context)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
  await expect(registry.execute('fs.glob', { path: join(f.secondary, 'escape'), pattern: '**/*' }, context)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
  await expect(registry.execute('fs.search', { path: join(f.secondary, 'escape'), query: 'authorized' }, context)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
  await rename(f.secondary, f.secondary + '-old')
  await symlink(f.outside, f.secondary, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(registry.execute('fs.read', { path: join(f.secondary, 'secret.txt') }, context)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  await expect(captureWorkspaceAccess(f.primary, [f.secondary])).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
})

it('inherits the same read snapshot in a real child agent', async () => {
  const f = await fixture(), { runtime } = await f.open(), file = join(f.secondary, 'nested/note.txt')
  const child = defineLaneProgram({ id: 'multi-child', version: '1' }, builder => {
    builder.addStep('read', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child-read', toolCallId: 'child-read', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.read', arguments: { path: file }, toolCallId: 'child-read' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'overwrite' }))
    builder.addStep('overwrite', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child-overwrite', toolCallId: 'child-overwrite', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.overwrite', arguments: { path: file, content: 'not allowed', expectedHash: digest('secondary needle\nsecond line\n') }, toolCallId: 'child-overwrite' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'write' }))
    builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'child-write', toolCallId: 'child-write', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.write', arguments: { path: join(f.secondary, 'child-write.txt'), content: 'not allowed' }, toolCallId: 'child-write' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'done' }))
    builder.addStep('done', () => ({ actions: [{ type: 'complete', result: 'child completed' }], next: 'done' }))
  })
  const parent = defineLaneProgram({ id: 'multi-parent', version: '1' }, builder => {
    builder.addStep('done', () => ({ actions: [{ type: 'complete', result: 'parent completed' }], next: 'done' }))
  })
  const { agentId } = runtime.createAgent('Read with child', parent)
  const spawned = runtime.createAgent({ goal: 'Read the secondary folder', program: child, parentAgentId: agentId })
  expect((await runtime.start(spawned.agentId).outcome()).status).toBe('succeeded')
  expect(runtime.state.agents.get(spawned.agentId)?.parentAgentId).toBe(agentId)
  const read = [...runtime.state.effects.values()].find(effect => effect.toolCallId === 'child-read')!
  expect(read, JSON.stringify([...runtime.state.effects.values()])).toBeDefined()
  expect(read.agentId).not.toBe(agentId)
  expect(read.outcome?.status).toBe('succeeded')
  expect(runtime.state.results.get(read.outcome!.resultRef!)!.value).toMatchObject({ content: 'secondary needle\nsecond line\n' })
  const overwrite = [...runtime.state.effects.values()].find(effect => effect.toolCallId === 'child-overwrite')!
  // Secondary reads cannot establish a writable primary-file overwrite baseline.
  expect(overwrite.outcome).toMatchObject({ status: 'failed', error: { code: 'FULL_FILE_READ_REQUIRED_FOR_OVERWRITE' } })
  const write = [...runtime.state.effects.values()].find(effect => effect.toolCallId === 'child-write')!
  expect(write.outcome).toMatchObject({ status: 'failed', error: { code: 'PATH_OUTSIDE_SANDBOX' } })
  await expect(readFile(join(f.secondary, 'child-write.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('restores old grants unchanged, applies additions only to new runs, and drops source grants on relocation', async () => {
  const f = await fixture(), opened = await f.open()
  const finish = defineLaneProgram({ id: 'multi-finish', version: '1' }, builder => { builder.addStep('done', () => ({ actions: [{ type: 'complete', result: 'done' }], next: 'done' })) })
  const { agentId } = opened.runtime.createAgent('snapshot', finish)
  await opened.runtime.start(agentId).outcome(); await opened.runtime.flushPersistence()
  await f.host.setConversationExecutionWorkspace(f.conversation.id, f.primary, f.primary, [f.outside])
  const restored = await f.open('multi-root', true)
  expect(await restored.registry.execute('fs.read', { path: join(f.secondary, 'nested/note.txt') }, context)).toMatchObject({ content: 'secondary needle\nsecond line\n' })
  await expect(restored.registry.execute('fs.read', { path: join(f.outside, 'secret.txt') }, context)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
  const run = await f.host.sendMessage(f.conversation.id, { text: 'Say hello' })
  expect((await run.outcome()).status).toBe('succeeded')
  const saved = JSON.parse(await readFile(join(f.dataDir, 'conversations', f.conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
  expect(saved.workspaceAccess).toEqual({ version: 1, primaryRoot: f.primary, readOnlyRoots: [f.outside] })
  const previous = JSON.parse(await readFile(join(opened.runDir, 'input.json'), 'utf8')).workspaceAccess
  expect((await restoreWorkspaceAccess(f.primary, undefined)).readOnlyRoots).toEqual([])
  expect((await restoreWorkspaceAccess(f.outside, previous, true)).readOnlyRoots).toEqual([])
  await expect(restoreWorkspaceAccess(f.outside, previous)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  expect(buildSystemPrompt({ workspace: f.primary, workspaceReadRoots: previous.readOnlyRoots })).toContain('All agents in this run share this fixed snapshot')
})

it('connects H5 project folders to new run grants while preserving existing workspace and overlapping write rights', async () => {
  const f = await fixture(), catalog = new H5ProjectCatalog(f.dataDir)
  const project = await catalog.add('Multi', f.primary)
  await catalog.update(project.id, { folders: [f.primary, f.secondary] })
  const conversation = await f.host.createConversation({ cwd: f.primary, projectId: project.id })
  const server = new H5Server(f.host, { dataDir: f.dataDir, host: '127.0.0.1', port: 0 })
  disposals.push(() => server.stop())
  await (server as any).prepareWorkConversation(conversation.id)
  const run = await f.host.sendMessage(conversation.id, { text: 'Say hello' })
  expect((await run.outcome()).status).toBe('succeeded')
  const saved = JSON.parse(await readFile(join(f.dataDir, 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
  expect(saved.workspaceAccess.readOnlyRoots).toEqual([f.secondary])
  expect(await f.host.getConversationWorkspace(conversation.id)).toBe(f.primary)
  await (server as any).workspaces.finish(conversation.id, true)
  await (server as any).projects.update(project.id, { cwd: f.secondary, folders: [f.primary, f.secondary, f.outside] })
  await (server as any).prepareWorkConversation(conversation.id)
  expect(await f.host.getConversationWorkspace(conversation.id)).toBe(f.primary)
  const continued = await f.host.sendMessage(conversation.id, { text: 'Say hello again' })
  expect((await continued.outcome()).status).toBe('succeeded')
  const next = JSON.parse(await readFile(join(f.dataDir, 'conversations', conversation.id, 'runs', continued.id, 'input.json'), 'utf8'))
  expect(next.workspaceAccess).toEqual({ version: 1, primaryRoot: f.primary, readOnlyRoots: [f.secondary, f.outside] })
  const overlap = await captureWorkspaceAccess(f.primary, [f.base, f.primary, join(f.primary, '.')])
  expect(overlap.readOnlyRoots).toEqual([f.base])
  const selected = await new WorkspaceReadAccess(overlap).select(join(f.primary, 'note.txt'))
  expect(selected.primary).toBe(true)
  await expect(captureWorkspaceAccess(f.primary, [homedir()])).rejects.toThrow('SANDBOX_READ_ROOT_TOO_BROAD')
})


it('preserves validated absolute primary aliases for filesystem reads and shell cwd', async () => {
  const f = await fixture(), alias = join(f.base, 'primary-alias')
  await symlink(f.primary, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const snapshot = await captureWorkspaceAccess(alias, [f.base])
  const reads = new WorkspaceReadAccess(snapshot, alias)
  expect(await reads.select(join(alias, 'note.txt'))).toMatchObject({ path: join(f.primary, 'note.txt'), primary: true })
  const runDir = join(f.dataDir, 'conversations', f.conversation.id, 'runs', 'alias')
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'input.json'), JSON.stringify({ fileSurfaceVersion: 3, workspaceAccess: snapshot }))
  const opened = await (f.host as any).runtimeFor(f.conversation.id, 'alias', alias, 'Read', '', f.options)
  for (const pack of [createPdfCapabilityPack(), createDocxCapabilityPack(), createSpreadsheetCapabilityPack(), createPptxCapabilityPack()]) {
    const activation = await pack.activate({ workspaceRoot: alias, workspaceAccess: snapshot, config: {}, signal: context.signal })
    for (const tool of activation.tools) opened.registry.register(tool)
  }
  disposals.push(async () => { await opened.runtime.shutdown(); opened.capabilityController.abort(); await opened.capabilities.dispose() })
  expect(await opened.registry.execute('fs.read', { path: join(alias, 'note.txt') }, context)).toMatchObject({ content: 'primary note' })
  const shell = await opened.registry.execute('shell.exec', { command: process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync("note.txt","utf8"))'], cwd: alias }, context)
  expect(shell).toMatchObject({ code: 0, stdout: 'primary note' })
  await rm(alias)
  await symlink(f.outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(opened.registry.execute('fs.read', { path: 'note.txt' }, context)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  await expect(opened.registry.execute('fs.write', { path: 'redirected.txt', content: 'no' }, context)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  await expect(opened.registry.execute('fs.move', { source: join(alias, 'secret.txt'), destination: 'moved.txt' }, context)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  await expect(opened.registry.execute('shell.exec', { command: process.execPath, args: ['-e', 'process.stdout.write("should not run")'], cwd: '.' }, context)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  for (const [name, input] of [
    ['docx.write', { path: 'redirected.docx', blocks: [{ type: 'paragraph', text: 'no' }] }],
    ['spreadsheet.xlsx.write', { path: 'redirected.xlsx', sheets: [{ name: 'Sheet', rows: [['no']] }] }],
    ['pptx.write', { path: 'redirected.pptx', slides: [{ title: 'no' }] }],
    ['pdf.page.render', { path: 'redirected.png', sourcePath: 'reference.pdf', page: 1 }],
  ] as const) await expect(opened.registry.execute(name, input, context)).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  const pinned = new FilesystemTool(alias, 30_000, f.primary)
  await expect(pinned.removeIfUnchanged('secret.txt', digest('not authorized'))).rejects.toThrow('WORKSPACE_ACCESS_ROOT_CHANGED')
  expect(await readFile(join(f.outside, 'secret.txt'), 'utf8')).toBe('not authorized')

})

it('passes secondary cwd and immutable readonly roots through the real host shell and serves recorded artifacts', async () => {
  const f = await fixture(), { registry } = await f.open(), file = join(f.secondary, 'nested/note.txt')
  expect(await registry.execute('shell.exec', { command: process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync("nested/note.txt","utf8"))'], cwd: f.secondary }, context)).toMatchObject({ code: 0, stdout: 'secondary needle\nsecond line\n' })
  await f.host.setConversationExecutionWorkspace(f.conversation.id, f.primary, f.primary, [f.secondary])
  f.host.applyLiveOptions({ ...f.options, mockToolCalls: [{ name: 'artifact.record', input: { path: file } }], mockAfterToolResponse: 'Recorded file' })
  const run = await f.host.sendMessage(f.conversation.id, { text: 'Record the reference file' })
  expect((await run.outcome()).status).toBe('succeeded')
  expect(await f.host.readArtifact(f.conversation.id, file, run.id)).toMatchObject({ content: 'secondary needle\nsecond line\n', absolutePath: file })
  const download = await f.host.artifactFile(f.conversation.id, file, run.id)
  expect(download.root).toBe(f.secondary)
  expect(download.path).toBe('nested/note.txt')
  expect(download.bytes.toString()).toBe('secondary needle\nsecond line\n')
})


it('routes PDF, spreadsheet, DOCX and PPTX readers through readonly grants without extending writers', async () => {
  const f = await fixture(), snapshot = await captureWorkspaceAccess(f.primary, [f.secondary])
  await cp('tests/fixtures/document-tools.pdf', join(f.secondary, 'reference.pdf'))
  await cp('tests/fixtures/document-tools.xlsx', join(f.secondary, 'reference.xlsx'))
  const sourceWriter = new FilesystemTool(f.secondary)
  const seed = new ToolRegistry({ workspaceRoots: [f.secondary] })
  for (const tool of createDocumentTools(f.secondary)) seed.register(tool)
  await officeBinaryWriter.run({ write: async request => ({ path: request.path, ...await sourceWriter.writeBytesIfUnchanged(request.path, request.bytes, request.expectedHash, request.signal) }) }, async () => {
    await seed.execute('document.docx.write', { path: 'reference.docx', blocks: [{ type: 'paragraph', text: 'Secondary document text' }] }, context)
    await seed.execute('document.pptx.write', { path: 'reference.pptx', slides: [{ title: 'Secondary presentation text' }] }, context)
  })
  const registry = new ToolRegistry({ workspaceRoots: [f.primary, f.secondary] })
  for (const pack of [createPdfCapabilityPack(), createSpreadsheetCapabilityPack(), createDocxCapabilityPack(), createPptxCapabilityPack()]) {
    const activation = await pack.activate({ workspaceRoot: f.primary, workspaceAccess: snapshot, config: {}, signal: context.signal })
    for (const tool of activation.tools) registry.register(tool)
  }
  expect(await registry.execute('pdf.read', { path: join(f.secondary, 'reference.pdf') }, context)).toMatchObject({ totalPages: 1 })
  expect(await registry.execute('spreadsheet.inspect', { path: join(f.secondary, 'reference.xlsx') }, context)).toMatchObject({ sheetCount: 2 })
  expect(await registry.execute('docx.read', { path: join(f.secondary, 'reference.docx') }, context)).toMatchObject({ text: expect.stringContaining('Secondary document text') })
  expect(await registry.execute('pptx.read', { path: join(f.secondary, 'reference.pptx') }, context)).toMatchObject({ text: expect.stringContaining('Secondary presentation text') })
  for (const name of ['docx.write', 'spreadsheet.xlsx.write', 'pptx.write', 'pdf.page.render']) expect(registry.get(name)!.manifest.permissions!.workspaceRoots).toEqual([f.primary])
  await expect(registry.execute('pdf.read', { path: join(f.outside, 'secret.txt') }, context)).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
})
