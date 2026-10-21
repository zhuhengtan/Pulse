import { readConversationFixture, writeConversationFixture } from './conversation-fixtures.js'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createLocalHost, H5Server, type LocalHost, type LocalHostOptions } from '../packages/server/src/index.js'
import { AttachmentStore } from '../packages/server/src/attachments.js'
import { BundleError, mapTransferredArguments, readBundleRuntime, stageConversationBundle, unsafeRecoveryReasons, validateBundlePath } from '../packages/server/src/conversation-bundle.js'
import { currentRecoveryBuild } from '../packages/server/src/recovery-contract.js'
import { H5ProjectCatalog } from '../packages/server/src/h5/projects.js'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'
import { runPersistence } from '../packages/server/src/run-persistence.js'
import { withRuntimePersistenceIntegrity } from '@hunterzhu/pulse-runtime'

const require = createRequire(import.meta.url)
const { ZipFile } = require('../packages/server/node_modules/yazl') as typeof import('../packages/server/node_modules/yazl')
const exec = promisify(execFile)
const roots: string[] = [], hosts: LocalHost[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.close())); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const dir = await mkdtemp(join(tmpdir(), 'pulse-bundle-test-')); roots.push(dir); return dir }
async function project(directory: string) {
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'note.txt'), 'portable project\n')
  await exec('git', ['init', '-q', directory]); await exec('git', ['-C', directory, 'add', '.'])
  await exec('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'])
}
function host(cwd: string, dataDir: string, extra: LocalHostOptions = {}) {
  const instance = createLocalHost({ cwd, dataDir, approvalMode: 'ask', taskController: false, provider: { provider: 'mock', defaultModel: 'mock' }, activeModel: 'mock', mockResponse: 'portable answer', ...extra }); hosts.push(instance); return instance
}
async function stage(path: string, dataDir: string) { return stageConversationBundle(createReadStream(path), join(dataDir, 'conversation-imports')) }
async function zipFiles(path: string, files: Array<{ name: string; content: Buffer | string; mode?: number }>) {
  const zip = new ZipFile(), done = pipeline(zip.outputStream, createWriteStream(path))
  for (const file of files) zip.addBuffer(Buffer.from(file.content), file.name, file.mode ? { mode: file.mode } : {})
  zip.end(); await done
}
async function completed(storage: 'json' | 'sqlite' | 'external-files') {
  const dir = await root(), source = join(dir, 'source'), target = join(dir, 'target'), data = join(dir, 'data'), targetData = join(dir, 'target-data')
  await project(source); await project(target)
  const original = host(source, data, { persistenceBackend: storage, mockToolCalls: [{ name: 'fs.read', input: { path: 'note.txt' } }], mockAfterToolResponse: 'read complete' })
  const conversation = await original.createConversation({ title: '迁移测试', origin: 'assistant' })
  const attachments = await new AttachmentStore(data, conversation.id).save([{ name: 'upload.txt', size: 7, type: 'file', mediaType: 'text/plain', data: Buffer.from('payload').toString('base64') }])
  const run = await original.sendMessage(conversation.id, { text: '读取文件', attachments })
  for await (const event of run.events) if (event.type === 'waiting') { for (const group of await run.pendingInteractions()) for (const item of group.items) await run.reply(item.effectId, { approved: true }) }
  await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
  const exported = await original.exportConversationBundle(conversation.id); cleanups.push(exported.cleanup)
  return { dir, source, target, data, targetData, original, conversation, attachments, run, exported }
}

describe('work conversation transfer', () => {
  it('cleans SQLite export bytes as well as logical values without changing the source database', async () => {
    const directory = await root(), cwd = join(directory, 'project'), data = join(directory, 'data')
    await project(cwd)
    const original = host(cwd, data, { persistenceBackend: 'sqlite', jarvis: { enabled: false } })
    const conversation = await original.createConversation()
    const secret = 'FAKE_EXPORT_REGRESSION_TOKEN_7b44c488d9a91abcdef'
    // Real snapshots span overflow pages; checking SELECT results alone misses old bytes.
    const run = await original.sendMessage(conversation.id, { text: 'Context ' + 'x'.repeat(10_000) + ' Authorization: Bearer ' + secret + '\n' + 'y'.repeat(10_000) })
    await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
    const databasePath = join(data, 'conversations', conversation.id, 'runs', run.id, 'runtime.sqlite')
    const before = await readFile(databasePath)
    const exported = await original.exportConversationBundle(conversation.id); cleanups.push(exported.cleanup)
    const staged = await stage(exported.path, join(directory, 'import-data'))
    const sqlitePath = `conversation/runs/${run.id}/runtime.sqlite`
    expect(staged.metadata.redactedFiles).toContain(sqlitePath)
    for (const file of staged.metadata.files) expect((await readFile(join(staged.directory, 'content', file.path))).includes(Buffer.from(secret)), file.path).toBe(false)
    const { DatabaseSync } = require('node:sqlite')
    const copy = new DatabaseSync(join(staged.directory, 'content', sqlitePath), { readOnly: true })
    try { expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }) } finally { copy.close() }
    expect(await readFile(databasePath)).toEqual(before)
    expect((await original.getConversationMessages(conversation.id)).some(message => message.text.includes(secret))).toBe(true)
  }, 30_000)

  it.each(['json', 'h5-isolated'] as const)('resumes an approved file move only in the target workspace (%s)', async mode => {
    const directory = await root(), source = join(directory, 'source'), destination = join(directory, 'destination'), data = join(directory, 'data'), targetData = join(directory, 'target-data')
    await project(source); await project(destination)
    if (mode === 'h5-isolated') await exec('git', ['-C', destination, 'config', 'core.autocrlf', 'true'])
    const original = host(source, data, { mockToolCalls: [{ name: 'fs.move', input: { source: join(source, 'note.txt'), destination: join(source, 'renamed.txt') } }] })
    const conversation = await original.createConversation(), run = await original.sendMessage(conversation.id, { text: 'Move note.txt to renamed.txt' })
    const iterator = run.events[Symbol.asyncIterator]()
    while (true) { const event = await iterator.next(); if (event.done || event.value.type === 'waiting') break }
    expect((await run.pendingInteractions())[0]?.kind).toBe('approval')
    const conversationDir = join(data, 'conversations', conversation.id), crashImage = join(directory, 'crash-image')
    await cp(conversationDir, crashImage, { recursive: true, filter: path => !path.endsWith('.lock') && !path.includes('.tmp-') })
    await original.close(); await iterator.return?.()
    await cp(crashImage, conversationDir, { recursive: true, force: true })
    await rm(join(conversationDir, 'conversation.lock'), { force: true })
    const reader = host(source, data), target = host(destination, targetData)
    const exported = await reader.exportConversationBundle(conversation.id); cleanups.push(exported.cleanup)
    const projectEntry = await new H5ProjectCatalog(targetData).add('Target project', destination)
    const imported = await target.importConversationBundle(await stage(exported.path, targetData), projectEntry)
    expect(imported.blockedReasons).toEqual([])
    let executionDirectory = destination
    const assertApproval = async (value: unknown, cwd: string) => {
      const text = JSON.stringify(value)
      const quotedPath = (root: string, name: string) => JSON.stringify(join(root, name)).slice(1, -1)
      expect(text).toContain(quotedPath(cwd, 'note.txt'))
      expect(text).toContain(quotedPath(cwd, 'renamed.txt'))
      expect(text).not.toContain(quotedPath(source, 'note.txt'))
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('portable project\n')
      await expect(stat(join(cwd, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    if (mode === 'h5-isolated') {
      const server = new H5Server(target, { dataDir: targetData, port: 0, host: '127.0.0.1' })
      const info = await server.start(), base = `http://127.0.0.1:${info.port}`
      try {
        const auth = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
        const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
        const headers = { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }
        const resumed = await fetch(`${base}/api/conversations/${conversation.id}/runs/${run.id}/resume`, { method: 'POST', headers })
        expect(await resumed.json()).toMatchObject({ runId: run.id })
        let interaction: { groupId: string; items: Array<{ effectId: string; input: unknown }> } | undefined
        await vi.waitFor(async () => {
          const state = await (await fetch(`${base}/api/runs/${run.id}/state`, { headers })).json() as { interactions?: Array<NonNullable<typeof interaction>> }
          interaction = state.interactions?.[0]; expect(interaction).toBeTruthy()
        })
        const workspace = await new H5WorkspaceManager(targetData).get(conversation.id)
        expect(workspace?.kind).toBe('git'); executionDirectory = workspace!.worktreeRoot
        await assertApproval(interaction, executionDirectory)
        const reply = await fetch(`${base}/api/runs/${run.id}/replies`, { method: 'POST', headers, body: JSON.stringify({ conversationId: conversation.id, groupId: interaction!.groupId, requestId: 'move-after-transfer', answers: interaction!.items.map(item => ({ effectId: item.effectId, value: { approved: true } })) }) })
        expect(reply.status).toBe(200)
        await vi.waitFor(async () => {
          expect(await readFile(join(executionDirectory, 'renamed.txt'), 'utf8')).toBe('portable project\n')
          expect((await new H5WorkspaceManager(targetData).get(conversation.id))?.status, JSON.stringify(await (await fetch(`${base}/api/runs/${run.id}/state`, { headers })).json()).slice(0, 8_000)).toBe('pending')
        }, { timeout: 10_000 })
      } finally { await server.stop() }
    } else {
      const resumed = await target.resumeRun(conversation.id)
      let approvals = 0
      for await (const event of resumed.events) if (event.type === 'waiting') {
        const groups = await resumed.pendingInteractions(); await assertApproval(groups, destination)
        for (const group of groups) for (const item of group.items) { await resumed.reply(item.effectId, { approved: true }); approvals++ }
      }
      expect(approvals).toBe(1)
      await expect(resumed.outcome()).resolves.toMatchObject({ status: 'succeeded' })
    }
    expect(await readFile(join(executionDirectory, 'renamed.txt'), 'utf8')).toBe('portable project\n')
    await expect(stat(join(executionDirectory, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'note.txt'), 'utf8')).toBe('portable project\n')
    await expect(stat(join(source, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (mode === 'h5-isolated') expect(await readFile(join(destination, 'note.txt'), 'utf8')).toBe('portable project\n')
    const runtime = await readBundleRuntime(join(targetData, 'conversations', conversation.id), run.id)
    const moves = [...runtime.restored.state.effects.values()].filter(effect => effect.kind === 'tool' && (effect.input as { name?: string }).name === 'fs.move')
    expect(moves).toHaveLength(1); expect(moves[0]!.outcome?.status).toBe('succeeded')
  }, 30_000)

  it.each(['/old/project', 'C:\\old\\project'])('relocates both fs.move paths from %s while preserving non-path data', source => {
    const input = { source: source + '/note.txt', destination: source + '/nested/renamed.txt', expectedHash: 'a'.repeat(64) }
    expect(mapTransferredArguments('fs.move', input, source, '/target/project')).toEqual({ source: posix.join('/target/project', 'note.txt'), destination: posix.join('/target/project', 'nested', 'renamed.txt'), expectedHash: input.expectedHash })
    expect(input.source).toBe(source + '/note.txt')
    expect(mapTransferredArguments('fs.move', { source: 'note.txt', destination: 'nested/renamed.txt' }, source, '/target/project')).toEqual({ source: 'note.txt', destination: 'nested/renamed.txt' })
  })

  it.each([
    { source: '/outside/note.txt', destination: '/old/project/renamed.txt' },
    { source: '/old/project/note.txt', destination: '/outside/renamed.txt' },
    { source: '/old/project/../note.txt', destination: '/old/project/renamed.txt' },
    { source: '/old/project/note.txt', destination: '../renamed.txt' },
  ])('rejects non-portable fs.move paths before recovery: %j', input => {
    expect(() => mapTransferredArguments('fs.move', input, '/old/project', '/target/project')).toThrow('RECOVERY_PATH_NOT_PORTABLE')
  })

  it.each(['json', 'sqlite', 'external-files'] as const)('round trips %s storage, history and attachments without overwriting another conversation', async storage => {
    const fixture = await completed(storage)
    const target = host(fixture.target, fixture.targetData)
    const existing = await target.createConversation({ title: '目标机已有会话' })
    const before = await readConversationFixture(join(fixture.targetData, 'conversations', existing.id, 'manifest.json'))
    const staged = await stage(fixture.exported.path, fixture.targetData)
    expect(staged.metadata.redactedFiles).toEqual([])
    expect(staged.metadata.blockedReasons).toEqual([])
    const result = await target.importConversationBundle(staged, { id: 'target-project', cwd: fixture.target })
    expect(result.blockedReasons).toEqual([])
    expect(result.conversation).toMatchObject({ id: fixture.conversation.id, cwd: fixture.target, projectId: 'target-project', approvalPolicy: 'manual' })
    expect(await target.getConversationMessages(result.conversation.id)).toEqual(await fixture.original.getConversationMessages(fixture.conversation.id))
    expect(await readFile(join(fixture.targetData, 'conversations', fixture.conversation.id, 'attachments', fixture.attachments[0]!.id), 'utf8')).toBe('payload')
    const runtime = await readBundleRuntime(join(fixture.targetData, 'conversations', fixture.conversation.id), fixture.run.id)
    expect(runtime.restored.state.results.size).toBeGreaterThan(0)
    const duplicate = await stage(fixture.exported.path, fixture.targetData)
    expect((await target.importConversationBundle(duplicate, { id: 'target-project', cwd: fixture.target })).duplicate).toBe(true)
    await expect(target.importConversationBundle(await stage(fixture.exported.path, fixture.targetData), { id: 'wrong-project', cwd: fixture.source })).rejects.toThrow('BUNDLE_ID_CONFLICT')
    expect(await readConversationFixture(join(fixture.targetData, 'conversations', existing.id, 'manifest.json'))).toEqual(before)
    const next = await target.sendMessage(fixture.conversation.id, { text: '继续新消息' })
    await expect(next.outcome()).resolves.toMatchObject({ status: 'succeeded' })
  }, 30_000)

  it.each(['json', 'sqlite', 'external-files', 'h5-isolated'] as const)('resumes the same interrupted %s run at its approval boundary on another workspace', async mode => {
    const dir = await root(), source = join(dir, 'source'), destination = join(dir, 'destination'), data = join(dir, 'data'), targetData = join(dir, 'target-data')
    await project(source); await project(destination)
    if (mode === 'h5-isolated') await exec('git', ['-C', destination, 'config', 'core.autocrlf', 'true'])
    const persistenceBackend = mode === 'h5-isolated' ? 'external-files' : mode
    const original = host(source, data, { persistenceBackend, mockToolCalls: [{ name: 'fs.write', input: { path: join(source, 'result.txt'), content: 'one write' } }] })
    const conversation = await original.createConversation()
    const run = await original.sendMessage(conversation.id, { text: '创建 result.txt' })
    const iterator = run.events[Symbol.asyncIterator]()
    while (true) { const event = await iterator.next(); if (event.done || event.value.type === 'waiting') break }
    // Simulate a process crash at a durable approval boundary. Graceful Host.close cancels the task,
    // so restore the pre-shutdown fixture image after closing all live DB handles.
    const conversationDir = join(data, 'conversations', conversation.id), crashImage = join(dir, 'crash-image')
    await cp(conversationDir, crashImage, { recursive: true, filter: path => !path.endsWith('.lock') && !path.includes('.tmp-') })
    if (persistenceBackend === 'sqlite') {
      const { DatabaseSync } = require('node:sqlite')
      const database = new DatabaseSync(join(conversationDir, 'runs', run.id, 'runtime.sqlite'), { readOnly: true })
      const backup = join(dir, 'durable.sqlite')
      try { database.prepare('VACUUM INTO ?').run(backup) } finally { database.close() }
      for (const suffix of ['', '-wal', '-shm']) await rm(join(crashImage, 'runs', run.id, `runtime.sqlite${suffix}`), { force: true })
      await cp(backup, join(crashImage, 'runs', run.id, 'runtime.sqlite'))
    }
    expect((await run.pendingInteractions())[0]?.kind).toBe('approval')
    await expect(original.exportConversationBundle(conversation.id)).rejects.toThrow('CONVERSATION_BUSY')
    await original.close()
    await iterator.return?.()
    await cp(crashImage, conversationDir, { recursive: true, force: true })
    await rm(join(conversationDir, 'conversation.lock'), { force: true })
    const reader = host(source, data)
    const exported = await reader.exportConversationBundle(conversation.id); cleanups.push(exported.cleanup)
    const target = host(destination, targetData)
    const staged = await stage(exported.path, targetData)
    const destinationProject = await new H5ProjectCatalog(targetData).add('目标项目', destination)
    const result = await target.importConversationBundle(staged, destinationProject)
    expect(result.blockedReasons).toEqual([])
    await writeFile(join(destination, 'note.txt'), 'out of sync')
    expect(await target.preflightTransferredRecovery(conversation.id, destination)).toContain('WORKSPACE_CONTENT_MISMATCH')
    await writeFile(join(destination, 'note.txt'), 'portable project\n')
    expect(await target.preflightTransferredRecovery(conversation.id, destination)).toEqual([])
    const budgetBefore = JSON.parse(await readFile(join(targetData, 'conversations', conversation.id, 'runs', run.id, 'model-budget.json'), 'utf8'))
    let executionDirectory = destination
    if (mode === 'h5-isolated') {
      const server = new H5Server(target, { dataDir: targetData, port: 0, host: '127.0.0.1' })
      const info = await server.start(), base = `http://127.0.0.1:${info.port}`
      try {
        const auth = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
        const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
        const headers = { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }
        const response = await fetch(`${base}/api/conversations/${conversation.id}/runs/${run.id}/resume`, { method: 'POST', headers })
        expect(await response.json()).toMatchObject({ runId: run.id })
        let interaction: { groupId: string; items: Array<{ effectId: string; input: unknown }> } | undefined
        await vi.waitFor(async () => {
          const state = await (await fetch(`${base}/api/runs/${run.id}/state`, { headers })).json() as { interactions?: Array<NonNullable<typeof interaction>> }
          interaction = state.interactions?.[0]; expect(interaction).toBeTruthy()
        })
        const workspace = await new H5WorkspaceManager(targetData).get(conversation.id)
        expect(workspace?.kind).toBe('git')
        executionDirectory = workspace!.worktreeRoot
        expect(JSON.stringify(interaction)).toContain(JSON.stringify(workspace!.worktreeRoot).slice(1, -1))
        const reply = await fetch(`${base}/api/runs/${run.id}/replies`, { method: 'POST', headers, body: JSON.stringify({ conversationId: conversation.id, groupId: interaction!.groupId, requestId: 'migration-approval-once', answers: interaction!.items.map(item => ({ effectId: item.effectId, value: { approved: true } })) }) })
        expect(reply.status).toBe(200)
        await vi.waitFor(async () => {
          expect(await readFile(join(executionDirectory, 'result.txt'), 'utf8')).toBe('one write')
          // This simple fixture has no accepted task verifier; preserve the existing pending-integration policy.
          expect((await new H5WorkspaceManager(targetData).get(conversation.id))?.status, JSON.stringify(await (await fetch(`${base}/api/runs/${run.id}/state`, { headers })).json()).slice(0, 8_000)).toBe('pending')
        }, { timeout: 10_000 })
      } finally { await server.stop() }
    } else {
      const resumed = await target.resumeRun(conversation.id)
      expect(resumed.id).toBe(run.id)
      let approvals = 0
      for await (const event of resumed.events) if (event.type === 'waiting') {
        const groups = await resumed.pendingInteractions()
        expect(JSON.stringify(groups)).toContain(JSON.stringify(join(destination, 'result.txt')).slice(1, -1))
        expect(JSON.stringify(groups)).not.toContain(JSON.stringify(join(source, 'result.txt')).slice(1, -1))
        for (const group of groups) for (const item of group.items) { await resumed.reply(item.effectId, { approved: true }); approvals++ }
      }
      expect(approvals).toBe(1)
      await expect(resumed.outcome()).resolves.toMatchObject({ status: 'succeeded' })
    }
    expect(await readFile(join(executionDirectory, 'result.txt'), 'utf8')).toBe('one write')
    await expect(stat(join(source, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (mode === 'h5-isolated') await expect(stat(join(destination, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const runtime = await readBundleRuntime(join(targetData, 'conversations', conversation.id), run.id)
    const writes = [...runtime.restored.state.effects.values()].filter(effect => effect.kind === 'tool' && (effect.input as { name?: string }).name === 'fs.write')
    expect(writes).toHaveLength(1)
    const budgetAfter = JSON.parse(await readFile(join(targetData, 'conversations', conversation.id, 'runs', run.id, 'model-budget.json'), 'utf8'))
    expect(budgetAfter.used).toBeGreaterThanOrEqual(budgetBefore.used)
  }, 30_000)

  it('keeps debug records but blocks recovery after redaction, build drift or project changes', async () => {
    const fixture = await completed('external-files')
    const staged = await stage(fixture.exported.path, fixture.targetData)
    staged.manifest.activeRunId = fixture.run.id
    await writeFile(join(fixture.target, 'note.txt'), 'different project')
    const target = host(fixture.target, fixture.targetData)
    expect(await target.inspectConversationBundle(staged, fixture.target)).toContain('WORKSPACE_CONTENT_MISMATCH')
    const backend = await runPersistence(join(staged.directory, 'content/conversation/runs', fixture.run.id))
    const snapshot = (await backend.load())!; snapshot.compatibility!.fingerprints!.build = 'old-build'
    await backend.save(withRuntimePersistenceIntegrity(snapshot)); await backend.close?.()
    expect(await target.inspectConversationBundle(staged)).toContain('RECOVERY_BUILD_INCOMPATIBLE')
    expect(currentRecoveryBuild()).not.toBe('old-build')
    const messagesPath = join(fixture.data, 'conversations', fixture.conversation.id, 'messages.jsonl')
    await writeConversationFixture(messagesPath, JSON.stringify({ id: 'secret', role: 'user', text: 'Authorization: Bearer private-auth-value', createdAt: new Date().toISOString() }) + '\n')
    const exported = await fixture.original.exportConversationBundle(fixture.conversation.id); cleanups.push(exported.cleanup)
    const redacted = await stage(exported.path, fixture.targetData)
    expect(redacted.metadata.redactedFiles).toContain('conversation/messages.jsonl')
    expect(await readFile(join(redacted.directory, 'content/conversation/messages.jsonl'), 'utf8')).not.toContain('private-auth-value')
    expect(await readConversationFixture(messagesPath, 'utf8')).toContain('private-auth-value')
  }, 30_000)

  it('rejects symlink sources and incomplete or modified external bodies', async () => {
    const fixture = await completed('external-files')
    const conv = join(fixture.data, 'conversations', fixture.conversation.id)
    await symlink(join(fixture.source, 'note.txt'), join(conv, 'outside'))
    await expect(fixture.original.exportConversationBundle(fixture.conversation.id)).rejects.toThrow('BUNDLE_SYMLINK_FORBIDDEN')
    await rm(join(conv, 'outside'))
    const staged = await stage(fixture.exported.path, fixture.targetData)
    const directory = join(staged.directory, 'content/conversation/runs', fixture.run.id, 'runtime-results')
    await rm(directory, { recursive: true })
    await expect(readBundleRuntime(join(staged.directory, 'content/conversation'), fixture.run.id)).rejects.toThrow()
  }, 30_000)

  it('fails closed on claimed tool effects and opaque command paths', async () => {
    const fixture = await completed('json')
    const { snapshot } = await readBundleRuntime(join(fixture.data, 'conversations', fixture.conversation.id), fixture.run.id)
    const state = snapshot.state.state
    const entry = state.effects.find(([, effect]) => effect.kind === 'tool')!
    delete entry[1].outcome; entry[1].state = 'running'
    snapshot.checkpoint = undefined as never
    snapshot.outbox.entries = [{ id: `${entry[0]}:${entry[1].attemptId}`, effectId: entry[0], attemptId: entry[1].attemptId, state: 'claimed', claimCount: 1, createdAt: 0 }]
    const next = withRuntimePersistenceIntegrity(snapshot)
    expect(unsafeRecoveryReasons(next)).toContain('RECOVERY_SIDE_EFFECT_UNKNOWN')
    expect(mapTransferredArguments('fs.read', { path: '/old/project/note.txt' }, '/old/project', '/new/project')).toEqual({ path: '/new/project/note.txt' })
    expect(() => mapTransferredArguments('fs.read', { path: '/old/project/../../etc/passwd' }, '/old/project', '/new/project')).toThrow('RECOVERY_PATH_NOT_PORTABLE')
    expect(() => mapTransferredArguments('fs.read', { path: '../secret.txt' }, '/old/project', '/new/project')).toThrow('RECOVERY_PATH_NOT_PORTABLE')
    expect(() => mapTransferredArguments('shell.exec', { command: 'cat', args: ['/old/project/note.txt'], cwd: '/old/project' }, '/old/project', '/new/project')).toThrow('RECOVERY_PATH_NOT_PORTABLE')
  }, 30_000)

  it('replaces a dead import lock and keeps a live one', async () => {
    const fixture = await completed('json')
    const target = host(fixture.target, fixture.targetData)
    const staged = await stage(fixture.exported.path, fixture.targetData)
    const lock = join(fixture.targetData, 'conversation-import.lock')
    await writeFile(lock, JSON.stringify({ pid: process.pid }))
    await expect(target.importConversationBundle(staged, { id: 'target-project', cwd: fixture.target })).rejects.toThrow('BUNDLE_IMPORT_BUSY')
    await writeFile(lock, JSON.stringify({ pid: 999_999_999 }))
    await expect(target.importConversationBundle(staged, { id: 'target-project', cwd: fixture.target })).resolves.toMatchObject({ duplicate: false })
  }, 30_000)
})

describe('ZIP boundary and HTTP', () => {
  it('rejects a changed file against its checksum manifest and a ZIP with excessive declared expansion', async () => {
    const fixture = await completed('json'), staged = await stage(fixture.exported.path, fixture.targetData)
    const files = await Promise.all(staged.metadata.files.map(async file => ({ name: file.path, content: file.path === 'chat.md' ? Buffer.from('modified transcript') : await readFile(join(staged.directory, 'content', file.path)) })))
    files.push({ name: 'bundle.json', content: await readFile(join(staged.directory, 'content/bundle.json')) })
    const changed = join(fixture.dir, 'changed.zip'); await zipFiles(changed, files)
    await expect(stage(changed, fixture.targetData)).rejects.toThrow('BUNDLE_HASH_MISMATCH')
    const oversized = join(fixture.dir, 'oversized.zip'); await zipFiles(oversized, [{ name: 'large.txt', content: 'x' }])
    const bytes = await readFile(oversized), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE(1024 * 1024 * 1024 + 1, central + 24); await writeFile(oversized, bytes)
    await expect(stage(oversized, fixture.targetData)).rejects.toMatchObject({ status: 413 })
  }, 30_000)

  it('exports database history despite stale JSONL files and redacts command-line credentials', async () => {
    const fixture = await completed('json'), conversation = join(fixture.data, 'conversations', fixture.conversation.id)
    await writeFile(join(conversation, 'messages.jsonl'), '{"id":"partial","text":"incomplete', { flag: 'a' })
    await writeFile(join(conversation, 'runs', fixture.run.id, 'diagnostic.json'), JSON.stringify({ command: 'test --token private-flag-value', args: ['--api-key', 'private-argv-value'] }))
    const exported = await fixture.original.exportConversationBundle(fixture.conversation.id); cleanups.push(exported.cleanup)
    const staged = await stage(exported.path, fixture.targetData)
    expect(await readFile(join(staged.directory, 'content/chat.md'), 'utf8')).toContain('read complete')
    expect(await readFile(join(staged.directory, 'content/conversation/messages.jsonl'), 'utf8')).not.toContain('incomplete')
    const diagnostic = await readFile(join(staged.directory, 'content/conversation/runs', fixture.run.id, 'diagnostic.json'), 'utf8')
    expect(diagnostic).not.toContain('private-flag-value'); expect(diagnostic).not.toContain('private-argv-value')
  }, 30_000)

  it.each(['../escape', '/tmp/escape', 'C:/escape', 'a\\b', 'a/../b', 'a/CON.txt', 'a/file.'])('rejects unsafe portable path %s', path => { expect(() => validateBundlePath(path)).toThrow('BUNDLE_INVALID_PATH') })
  it('rejects symlinks, case collisions and path traversal without writing outside staging', async () => {
    const dir = await root()
    for (const [index, files] of [
      [{ name: 'link', content: 'outside', mode: 0o120777 }],
      [{ name: 'chat.md', content: 'one' }, { name: 'CHAT.MD', content: 'two' }],
    ].entries()) {
      const zip = join(dir, `${index}.zip`); await zipFiles(zip, files)
      await expect(stage(zip, dir)).rejects.toBeInstanceOf(BundleError)
    }
    const path = join(dir, 'traversal.zip'); await zipFiles(path, [{ name: 'xx/escape', content: 'unsafe' }])
    const bytes = await readFile(path)
    for (let offset = bytes.indexOf('xx/escape'); offset >= 0; offset = bytes.indexOf('xx/escape', offset + 1)) bytes.write('../escape', offset)
    await writeFile(path, bytes)
    await expect(stage(path, dir)).rejects.toBeInstanceOf(BundleError)
    await expect(stat(join(dir, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' })
    const imports = await readdir(join(dir, 'conversation-imports'))
    expect(imports).toEqual([])
  })

  it('requires authentication and same origin, downloads ZIP and stages/commits to a registered target project', async () => {
    const fixture = await completed('json'), target = host(fixture.target, fixture.targetData)
    const server = new H5Server(target, { dataDir: fixture.targetData, port: 0, host: '127.0.0.1' })
    const info = await server.start(), base = `http://127.0.0.1:${info.port}`
    try {
      expect((await fetch(`${base}/api/conversation-imports`, { method: 'POST' })).status).toBe(401)
      const auth = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
      const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }
      const added = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: '目标项目', cwd: fixture.target }) })
      expect(added.status).toBe(201)
      const project = await added.json() as { id: string }
      const body = await readFile(fixture.exported.path)
      expect((await fetch(`${base}/api/conversation-imports`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.invalid', 'Content-Type': 'application/zip' }, body })).status).toBe(403)
      const upload = await fetch(`${base}/api/conversation-imports`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body })
      expect(upload.status).toBe(200)
      const preview = await upload.json() as { token: string; conversationId: string }
      const committed = await fetch(`${base}/api/conversation-imports/${preview.token}`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id }) })
      expect(committed.status).toBe(200)
      expect(await committed.json()).toMatchObject({ conversation: { id: fixture.conversation.id } })
      const exported = await fetch(`${base}/api/conversations/${preview.conversationId}/export`, { method: 'POST', headers })
      expect(exported.status).toBe(200); expect(exported.headers.get('content-type')).toBe('application/zip')
      expect(Buffer.from(await exported.arrayBuffer()).readUInt32LE()).toBe(0x04034b50)
      expect((await fetch(`${base}/api/conversation-imports/${preview.token}`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id }) })).status).toBe(410)
    } finally { await server.stop() }
  }, 30_000)
})
