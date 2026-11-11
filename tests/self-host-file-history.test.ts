import { createRequire } from 'node:module'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { stageConversationBundle } from '../packages/server/src/conversation-bundle.js'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FilesystemTool } from '../packages/adapters/src/tools/filesystem.js'
import { FileSnapshotManager } from '../packages/server/src/file-snapshots.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { createSelfHostFileHistoryBinding, validateSelfHostFileHistoryBinding } from '../packages/server/src/self-host-file-history.js'

let root: string, project: string, candidate: string, data: string
const id = 'conv-synthetic-history'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-external-history-')))
  project = join(root, 'project'); candidate = join(root, 'candidate'); data = join(root, 'data')
  await Promise.all([project, candidate, data, join(root, 'home')].map(p => mkdir(p)))
  for (const key of ['HOME', 'USERPROFILE', 'PULSE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(key, join(root, 'home'))
  vi.stubEnv('PULSE_CONFIG', join(root, 'home', 'config.json'))
  vi.stubEnv('PULSE_DATA_DIR', data)
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) vi.stubEnv(key, undefined)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
async function bound() {
  const binding = await createSelfHostFileHistoryBinding(data, id, project, candidate)
  const manager = () => new FileSnapshotManager(candidate, new FilesystemTool(candidate), { storageRoot: binding.storageRoot, validate: () => validateSelfHostFileHistoryBinding(data, binding, id, candidate) })
  return { binding, manager }
}
async function landed(manager: FileSnapshotManager, conversationId = id) {
  await writeFile(join(candidate, 'note.txt'), 'old')
  await manager.beginJournal({ conversationId, runId: 'run-1', laneId: 'lane', agentId: 'agent', effectId: 'effect-1', path: 'note.txt', before: Buffer.from('old'), next: Buffer.from('new') })
  await writeFile(join(candidate, 'note.txt'), 'new')
  await manager.markLanded({ conversationId, runId: 'run-1', effectId: 'effect-1', laneId: 'lane', agentId: 'agent' })
}
it.each(['confirmed', 'unconfirmed', 'unknown', 'conflict'] as const)('reopens external WAL and safely recovers %s, repeatedly', async disposition => {
  const { binding, manager } = await bound()
  await landed(manager())
  expect(await readdir(candidate)).toEqual(['note.txt'])
  const fresh = manager()
  expect(await fresh.pendingOwners()).toHaveLength(1)
  if (disposition === 'conflict') await writeFile(join(candidate, 'note.txt'), 'human')
  if (disposition === 'unknown' || disposition === 'conflict') {
    for (let i = 0; i < 2; i++) await expect(fresh.reconcilePendingWal(undefined, async () => disposition === 'unknown' ? 'unknown' : 'unconfirmed')).rejects.toThrow(disposition === 'unknown' ? 'WAL_RECOVERY_UNKNOWN' : 'WAL_RECOVERY_EXTERNAL_CONFLICT')
    expect(await fresh.pendingOwners()).toHaveLength(1)
    expect(await readFile(join(candidate, 'note.txt'), 'utf8')).toBe(disposition === 'conflict' ? 'human' : 'new')
  } else {
    await fresh.reconcilePendingWal(undefined, async () => disposition)
    expect(await fresh.reconcilePendingWal(undefined, async () => disposition)).toEqual({ cleaned: [], restored: [], conflicts: [] })
    expect(await readFile(join(candidate, 'note.txt'), 'utf8')).toBe(disposition === 'confirmed' ? 'new' : 'old')
    expect(await readdir(join(binding.storageRoot, 'history'))).toHaveLength(disposition === 'confirmed' ? 1 : 0)
    if (disposition === 'confirmed') expect(await manager().modificationScope([{ path: 'note.txt', expectedPostHash: hash('new') }])).toEqual({ conversationId: id, runId: 'run-1' })
  }
  expect(await readdir(project)).toEqual([])
  expect(await readdir(candidate)).toEqual(['note.txt'])
})
it.each(['missing', 'tampered', 'symlink', 'removed-candidate', 'replaced-candidate', 'wrong-target'] as const)('rejects %s before reading or recovering external history', async mode => {
  const { binding, manager } = await bound(); await landed(manager())
  const file = join(binding.storageRoot, 'binding.json')
  if (mode === 'missing') await rm(file)
  if (mode === 'tampered') await writeFile(file, JSON.stringify({ ...binding, workspaceRoot: project }))
  if (mode === 'symlink') { await rename(file, join(root, 'binding-copy.json')); await symlink(join(root, 'binding-copy.json'), file) }
  if (mode === 'removed-candidate' || mode === 'replaced-candidate') { await rename(candidate, candidate + '-original'); if (mode === 'replaced-candidate') { await mkdir(candidate); await writeFile(join(candidate, 'note.txt'), 'human') } }
  if (mode === 'wrong-target') await expect(validateSelfHostFileHistoryBinding(data, binding, id, project)).rejects.toThrow()
  else {
    await expect(manager().pendingOwners()).rejects.toThrow()
    await expect(manager().reconcilePendingWal(undefined, async () => 'unconfirmed')).rejects.toThrow()
    await expect(manager().modificationScope([{ path: 'note.txt', expectedPostHash: hash('new') }])).rejects.toThrow()
  }
  expect(await readdir(project)).toEqual([])
})
it.each(['data', 'store-parent', 'store', 'wal', 'history', 'blobs', 'rollbacks'] as const)('refuses a symlink at the %s storage level', async level => {
  const { binding, manager } = await bound(); await landed(manager())
  const path = level === 'data' ? data : level === 'store-parent' ? join(data, 'self-host-file-history') : level === 'store' ? binding.storageRoot : join(binding.storageRoot, level)
  const moved = join(root, `moved-${level}`)
  await rename(path, moved); await symlink(moved, path)
  await expect(manager().beginJournal({ conversationId: id, runId: 'run-2', laneId: 'lane', agentId: 'agent', effectId: 'effect-2', path: 'second.txt', before: null, next: Buffer.from('x') })).rejects.toThrow()
  expect(await readdir(candidate)).toEqual(['note.txt'])
})
it.each(['project', 'candidate'] as const)('rejects storage inside %s before creating it', async target => {
  const nested = join(target === 'project' ? project : candidate, 'data')
  await mkdir(nested)
  await expect(createSelfHostFileHistoryBinding(nested, id, project, candidate)).rejects.toThrow()
  expect(await readdir(nested)).toEqual([])
})
it('does not replace an existing binding', async () => {
  const { binding } = await bound()
  await expect(createSelfHostFileHistoryBinding(data, id, project, candidate)).rejects.toThrow()
  await validateSelfHostFileHistoryBinding(data, binding, id, candidate)
})
async function workspaceRecord(conversationId: string, changes: Record<string, unknown> = {}) {
  await mkdir(join(data, 'workspaces', 'records'), { recursive: true })
  await writeFile(join(data, 'workspaces', 'records', `${conversationId}.json`), JSON.stringify({ schemaVersion: 1, conversationId, projectId: 'synthetic-project', projectRoot: project, worktreeRoot: candidate, projectSubdirectory: '', baselineCommit: 'synthetic', kind: 'git', externalValidation: true, status: 'running', updatedAt: new Date().toISOString(), ...changes }))
}
const hostOptions = () => ({ cwd: project, dataDir: data, approvalMode: 'auto' as const, provider: { provider: 'mock' as const }, jarvis: { enabled: false } })
const snapshots = (host: ReturnType<typeof createLocalHost>, cwd: string, conversationId: string) => (host as unknown as { fileSnapshotManager(cwd: string, id: string): Promise<FileSnapshotManager> }).fileSnapshotManager(cwd, conversationId)
it.each(['marker-only', 'store-without-manifest'] as const)('fails closed after interrupted setup: %s', async mode => {
  let host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation({ selfHostFileHistoryRequired: true })
    if (mode === 'store-without-manifest') await createSelfHostFileHistoryBinding(data, conversation.id, project, candidate)
    await host.close(); host = createLocalHost(hostOptions()); await host.init()
    await expect(snapshots(host, candidate, conversation.id)).rejects.toThrow()
    await expect(host.reconcileWorkspaceWal(project, undefined, 'run-1', conversation.id)).rejects.toThrow()
    await expect(host.rollbackFiles({ confirm: true, conversationId: conversation.id, runId: 'run-1', targets: [{ path: 'note.txt', expectedPostHash: hash('new') }] })).rejects.toThrow()
    expect(await readdir(candidate)).toEqual([]); expect(await readdir(project)).toEqual([])
  } finally { await host.close() }
})
it('reopens the same host store after restart and blocks terminal recovery into project', async () => {
  let host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation()
    await host.requireSelfHostFileHistory(conversation.id); await workspaceRecord(conversation.id); await host.bindSelfHostFileHistory(conversation.id, candidate, project)
    await landed(await snapshots(host, candidate, conversation.id), conversation.id)
    await host.close(); host = createLocalHost(hostOptions()); await host.init()
    const manager = await snapshots(host, candidate, conversation.id)
    await expect(host.reconcileWorkspaceWal(candidate, undefined, 'run-1')).rejects.toThrow('SELF_HOST_HISTORY_SCOPE_REQUIRED')
    expect(await manager.pendingOwners()).toHaveLength(1)
    await manager.reconcilePendingWal(undefined, async () => 'confirmed')
    expect(await manager.modificationScope([{ path: 'note.txt', expectedPostHash: hash('new') }])).toEqual({ conversationId: conversation.id, runId: 'run-1' })
    await host.setConversationExecutionWorkspace(conversation.id, project, project)
    await expect(manager.pendingOwners()).rejects.toThrow()
    await expect(host.reconcileWorkspaceWal(project, undefined, 'run-1', conversation.id)).rejects.toThrow()
    await expect(host.rollbackFiles({ confirm: true, conversationId: conversation.id, runId: 'run-1', targets: [{ path: 'note.txt', expectedPostHash: hash('new') }] })).rejects.toThrow()
    expect(await readdir(project)).toEqual([])
  } finally { await host.close() }
})
it('keeps ordinary task history in the legacy location', async () => {
  const host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation({ cwd: candidate })
    await landed(await snapshots(host, candidate, conversation.id), conversation.id)
    expect(await readdir(join(candidate, '.pulse', 'file-snapshots', 'wal'))).toHaveLength(1)
    await expect(readdir(join(data, 'self-host-file-history'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await host.close() }
})

it('performs explicit rollback from the persisted external store after host restart', async () => {
  let host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation({ selfHostFileHistoryRequired: true })
    await workspaceRecord(conversation.id); await host.bindSelfHostFileHistory(conversation.id, candidate, project)
    const manager = await snapshots(host, candidate, conversation.id)
    await landed(manager, conversation.id)
    await manager.reconcilePendingWal(undefined, async () => 'confirmed')
    await host.close(); host = createLocalHost(hostOptions()); await host.init()
    const journal = await host.rollbackFiles({ confirm: true, conversationId: conversation.id, runId: 'run-1', targets: [{ path: 'note.txt', expectedPostHash: hash('new') }] })
    expect(journal.status).toBe('completed')
    expect(await readFile(join(candidate, 'note.txt'), 'utf8')).toBe('old')
    expect(await readdir(project)).toEqual([])
    expect(await readdir(candidate)).toEqual(['note.txt'])
    expect(await readdir(join(data, 'self-host-file-history', conversation.id, 'rollbacks'))).toHaveLength(1)
  } finally { await host.close() }
})

it.each(['merged', 'noop', 'applying', 'missing-record', 'stripped-manifest'] as const)('refuses recovery with independent lifecycle evidence: %s', async mode => {
  const host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation({ selfHostFileHistoryRequired: true })
    await workspaceRecord(conversation.id); await host.bindSelfHostFileHistory(conversation.id, candidate, project)
    const manager = await snapshots(host, candidate, conversation.id)
    await landed(manager, conversation.id)
    if (mode === 'merged' || mode === 'noop') await workspaceRecord(conversation.id, { status: mode })
    if (mode === 'applying') await workspaceRecord(conversation.id, { mergeState: 'applying' })
    if (mode === 'missing-record') await rm(join(data, 'workspaces', 'records', `${conversation.id}.json`))
    if (mode === 'stripped-manifest') {
      const internal = host as unknown as { readManifest(id: string): Promise<Record<string, unknown>>; saveManifest(value: unknown): Promise<void> }
      const manifest = await internal.readManifest(conversation.id)
      delete manifest.selfHostFileHistoryRequired; delete manifest.selfHostFileHistory
      await internal.saveManifest(manifest)
    }
    await expect(snapshots(host, candidate, conversation.id)).rejects.toThrow()
    await expect(manager.pendingOwners()).rejects.toThrow()
    await expect(host.reconcileWorkspaceWal(candidate, undefined, 'run-1', conversation.id)).rejects.toThrow()
    expect(await readFile(join(candidate, 'note.txt'), 'utf8')).toBe('new')
    expect(await readdir(candidate)).toEqual(['note.txt']); expect(await readdir(project)).toEqual([])
  } finally { await host.close() }
})
it.each(['project', 'candidate'] as const)('rejects data hidden in the %s repo above the selected package', async location => {
  const fullRoot = location === 'project' ? project : candidate
  const nestedData = join(fullRoot, '..data')
  const selectedProject = join(project, 'pkg'), selectedCandidate = join(candidate, 'pkg')
  await Promise.all([nestedData, selectedProject, selectedCandidate].map(p => mkdir(p)))
  const host = createLocalHost({ ...hostOptions(), cwd: selectedProject, dataDir: nestedData })
  try {
    await host.init(); const conversation = await host.createConversation({ selfHostFileHistoryRequired: true })
    const records = join(nestedData, 'workspaces', 'records'); await mkdir(records, { recursive: true })
    await writeFile(join(records, `${conversation.id}.json`), JSON.stringify({ schemaVersion: 1, conversationId: conversation.id, kind: 'git', externalValidation: true, status: 'running', projectRoot: project, worktreeRoot: candidate, projectSubdirectory: 'pkg' }))
    await expect(host.bindSelfHostFileHistory(conversation.id, selectedCandidate, selectedProject)).rejects.toThrow('SELF_HOST_HISTORY_BINDING_INVALID')
    await expect(readdir(join(nestedData, 'self-host-file-history'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await host.close() }
})
it('rejects bundle export of required external history rather than silently dropping its binding', async () => {
  const host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation({ selfHostFileHistoryRequired: true })
    await expect(host.exportConversationBundle(conversation.id)).rejects.toThrow('SELF_HOST_HISTORY_NOT_PORTABLE')
    await workspaceRecord(conversation.id); await host.bindSelfHostFileHistory(conversation.id, candidate, project)
    await expect(host.exportConversationBundle(conversation.id)).rejects.toThrow('SELF_HOST_HISTORY_NOT_PORTABLE')
  } finally { await host.close() }
})

it.each(['selfHostFileHistoryRequired', 'selfHostFileHistory', 'selfHostFileHistoryClosed'])('rejects imported manifest containing %s before schema stripping', async field => {
  const require = createRequire(import.meta.url)
  const { ZipFile } = require('../packages/server/node_modules/yazl') as typeof import('../packages/server/node_modules/yazl')
  const archive = join(root, 'unsafe.zip'), zip = new ZipFile()
  const done = pipeline(zip.outputStream, createWriteStream(archive))
  const conversationId = 'conv-01234567-89ab-4cde-8fab-0123456789ab'
  zip.addBuffer(Buffer.from(JSON.stringify({ format: 'pulse-work-conversation', version: 1, exportedAt: new Date().toISOString(), conversationId, source: { cwd: project, executionCwd: candidate, stamp: { available: false, files: {} } }, files: [], blockedReasons: [], redactedFiles: [] })), 'bundle.json')
  zip.addBuffer(Buffer.from(JSON.stringify({ [field]: field === 'selfHostFileHistory' ? { version: 1 } : true })), 'conversation/manifest.json')
  zip.end(); await done
  await expect(stageConversationBundle(createReadStream(archive), join(data, 'imports'))).rejects.toThrow('SELF_HOST_HISTORY_NOT_PORTABLE')
})
it('preserves ordinary H5 tasks with a symlinked data directory', async () => {
  const dataLink = join(root, 'data-link'); await symlink(data, dataLink)
  const host = createLocalHost({ ...hostOptions(), dataDir: dataLink })
  try {
    await host.init(); const conversation = await host.createConversation({ cwd: candidate })
    await workspaceRecord(conversation.id, { externalValidation: false })
    const manager = await snapshots(host, candidate, conversation.id)
    await landed(manager, conversation.id)
    expect(await manager.pendingOwners()).toHaveLength(1)
    expect(await readdir(join(candidate, '.pulse', 'file-snapshots', 'wal'))).toHaveLength(1)
    await expect(readdir(join(data, 'self-host-file-history'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await host.close() }
})
it('refuses a symlinked ordinary-looking workspace record before legacy fallback', async () => {
  const host = createLocalHost(hostOptions())
  try {
    await host.init(); const conversation = await host.createConversation({ cwd: candidate })
    await workspaceRecord(conversation.id, { externalValidation: false })
    const record = join(data, 'workspaces', 'records', `${conversation.id}.json`), outside = join(root, 'forged-record.json')
    await rename(record, outside); await symlink(outside, record)
    await expect(snapshots(host, candidate, conversation.id)).rejects.toThrow()
    await expect(host.reconcileWorkspaceWal(candidate, undefined, 'run-1', conversation.id)).rejects.toThrow()
    expect(await readdir(candidate)).toEqual([])
  } finally { await host.close() }
})
