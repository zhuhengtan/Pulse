import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FilesystemTool } from '../packages/adapters/src/tools/filesystem.js'
import { FileSnapshotManager } from '../packages/server/src/file-snapshots.js'
import { createSelfHostFileHistoryBinding, syncFileHistoryDirectory, validateSelfHostFileHistoryBinding } from '../packages/server/src/self-host-file-history.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
vi.mock('../packages/server/src/self-host-file-history.js', async original => {
  const actual = await original<typeof import('../packages/server/src/self-host-file-history.js')>()
  return { ...actual, syncFileHistoryDirectory: vi.fn(actual.syncFileHistoryDirectory) }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const actualHistory = await vi.importActual<typeof import('../packages/server/src/self-host-file-history.js')>('../packages/server/src/self-host-file-history.js')
let root: string, project: string, workspace: string, data: string
const owner = { conversationId: 'history-storage', runId: 'run', effectId: 'effect', laneId: 'lane', agentId: 'agent' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const failure = (code: string) => Object.assign(new Error(code), { code })
beforeEach(async () => {
  vi.mocked(open).mockImplementation(actualFs.open)
  vi.mocked(syncFileHistoryDirectory).mockImplementation(actualHistory.syncFileHistoryDirectory)
  root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-history-storage-')))
  project = join(root, 'project'); workspace = join(root, 'workspace'); data = join(root, 'data')
  await Promise.all([project, workspace, data].map(path => mkdir(path)))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockReset()
  vi.mocked(syncFileHistoryDirectory).mockReset()
  await rm(root, { recursive: true, force: true })
})

async function store() {
  const binding = await createSelfHostFileHistoryBinding(data, owner.conversationId, project, workspace)
  const manager = new FileSnapshotManager(workspace, new FilesystemTool(workspace), {
    storageRoot: binding.storageRoot,
    validate: () => validateSelfHostFileHistoryBinding(data, binding, owner.conversationId, workspace),
  })
  await writeFile(join(workspace, 'note.txt'), 'old')
  const begin = () => manager.beginJournal({ ...owner, path: 'note.txt', before: Buffer.from('old'), next: Buffer.from('new') })
  const land = async () => { await begin(); await writeFile(join(workspace, 'note.txt'), 'new'); await manager.markLanded(owner) }
  return { manager, binding, begin, land }
}

it('validates and closes the directory, and syncs it only where supported', async () => {
  const handle = await actualFs.open(root, 'r')
  const sync = vi.spyOn(handle, 'sync'), close = vi.spyOn(handle, 'close')
  vi.mocked(open).mockResolvedValueOnce(handle)
  await syncFileHistoryDirectory(root)
  expect(sync).toHaveBeenCalledTimes(process.platform === 'win32' ? 0 : 1)
  expect(close).toHaveBeenCalledTimes(1)
})

it.each(['file', 'symlink'])('refuses a %s in place of the directory', async kind => {
  const target = join(root, 'target')
  if (kind === 'file') await writeFile(target, 'not a directory')
  else await symlink(data, target, 'junction')
  await expect(syncFileHistoryDirectory(target)).rejects.toMatchObject({ code: 'SELF_HOST_FILE_HISTORY_INVALID' })
})

it.each(['EPERM', 'EACCES', 'EIO'])('propagates directory open %s', async code => {
  const error = failure(code)
  vi.mocked(open).mockRejectedValueOnce(error)
  await expect(syncFileHistoryDirectory(root)).rejects.toBe(error)
})

it.each([['stat', 'EIO'], ['identity', 'EIO'], ['close', 'EIO'], ['sync', 'EIO'], ['sync', 'EPERM'], ['sync', 'EINVAL']])('preserves directory %s validation and %s failures', async (stage, code) => {
  const handle = await actualFs.open(root, 'r'), error = failure(code!)
  const close = handle.close.bind(handle)
  const closed = vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); if (stage === 'close') throw error })
  if (stage === 'stat') vi.spyOn(handle, 'stat').mockRejectedValue(error)
  if (stage === 'identity') {
    const info = await handle.stat()
    vi.spyOn(handle, 'stat').mockResolvedValue(Object.assign(info, { ino: info.ino + 1 }))
  }
  const synced = vi.spyOn(handle, 'sync')
  if (stage === 'sync') synced.mockRejectedValue(error)
  vi.mocked(open).mockResolvedValueOnce(handle)
  if (stage === 'sync' && process.platform === 'win32') {
    await syncFileHistoryDirectory(root)
    expect(synced).not.toHaveBeenCalled()
  } else if (stage === 'identity') await expect(syncFileHistoryDirectory(root)).rejects.toMatchObject({ code: 'SELF_HOST_FILE_HISTORY_INVALID' })
  else await expect(syncFileHistoryDirectory(root)).rejects.toBe(error)
  expect(closed).toHaveBeenCalledTimes(1)
})

it.each(['EPERM', 'EIO'])('never suppresses binding file fsync %s or adopts its incomplete store', async code => {
  const error = failure(code)
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args)
    if (basename(String(args[0])) === 'binding.json') vi.spyOn(handle, 'sync').mockRejectedValue(error)
    return handle
  })
  await expect(createSelfHostFileHistoryBinding(data, owner.conversationId, project, workspace)).rejects.toBe(error)
  await expect(createSelfHostFileHistoryBinding(data, owner.conversationId, project, workspace)).rejects.toMatchObject({ code: 'EEXIST' })
})

it('does not publish WAL or mutate workspace after a blob file fsync fails', async () => {
  const { manager, begin } = await store(), error = failure('EPERM')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args)
    if (String(args[0]).includes('.tmp-')) vi.spyOn(handle, 'sync').mockRejectedValue(error)
    return handle
  })
  await expect(begin()).rejects.toBe(error)
  expect(await manager.pendingOwners()).toEqual([])
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('old')
})

it.each(['blobs', 'wal'])('propagates %s directory persistence failure after rename, including retry', async folder => {
  const { manager, binding, begin } = await store(), error = failure('EIO')
  vi.mocked(syncFileHistoryDirectory).mockImplementation(async path => {
    if (path === join(binding.storageRoot, folder)) throw error
    await actualHistory.syncFileHistoryDirectory(path)
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(begin()).rejects.toBe(error)
    expect(await readdir(join(binding.storageRoot, folder))).toHaveLength(1)
    expect(await manager.pendingOwners()).toHaveLength(folder === 'wal' ? 1 : 0)
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('old')
  }
  vi.mocked(syncFileHistoryDirectory).mockImplementation(actualHistory.syncFileHistoryDirectory)
  await begin()
  expect(await manager.pendingOwners()).toHaveLength(1)
})

it('keeps pending WAL until an already-renamed confirmed history entry is durable', async () => {
  const { manager, binding, land } = await store(), error = failure('EIO')
  await land()
  vi.mocked(syncFileHistoryDirectory).mockImplementation(async path => {
    if (path === join(binding.storageRoot, 'history')) throw error
    await actualHistory.syncFileHistoryDirectory(path)
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(manager.settleConfirmed([owner])).rejects.toBe(error)
    expect(await manager.pendingOwners()).toHaveLength(1)
    expect(await readdir(join(binding.storageRoot, 'history'))).toHaveLength(1)
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('new')
  }
  await expect(manager.reconcilePendingWal(undefined, async () => 'unknown')).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
  expect(await manager.pendingOwners()).toHaveLength(1)
  vi.mocked(syncFileHistoryDirectory).mockImplementation(actualHistory.syncFileHistoryDirectory)
  await manager.settleConfirmed([owner])
  expect(await manager.pendingOwners()).toEqual([])
})

it('preserves a landed write when the supplied recovery classifier explicitly reports unknown', async () => {
  const { manager, binding } = await store(), error = failure('EIO')
  const action = vi.fn(async () => {
    await writeFile(join(workspace, 'note.txt'), 'new')
    vi.mocked(syncFileHistoryDirectory).mockImplementation(async path => {
      if (path === join(binding.storageRoot, 'wal')) throw error
      await actualHistory.syncFileHistoryDirectory(path)
    })
  })
  await expect(manager.executeWithWal({ ...owner, path: 'note.txt', newBytes: Buffer.from('new') }, action)).rejects.toBe(error)
  await expect(manager.markLanded(owner)).rejects.toBe(error)
  await expect(manager.reconcilePendingWal(undefined, async () => 'unknown')).rejects.toMatchObject({ code: 'WAL_RECOVERY_UNKNOWN' })
  expect(action).toHaveBeenCalledTimes(1)
  expect(await manager.pendingOwners()).toHaveLength(1)
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('new')
  vi.mocked(syncFileHistoryDirectory).mockImplementation(actualHistory.syncFileHistoryDirectory)
  await manager.reconcilePendingWal(undefined, async () => 'confirmed')
  expect(await manager.pendingOwners()).toEqual([])
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('new')
})

it.each(['intent', 'completion'])('does not report rollback success after %s directory persistence fails', async phase => {
  const { manager, binding, land } = await store(), error = failure('EIO')
  await land()
  let calls = 0
  vi.mocked(syncFileHistoryDirectory).mockImplementation(async path => {
    if (path === join(binding.storageRoot, 'rollbacks') && (++calls > 1 || phase === 'intent')) throw error
    await actualHistory.syncFileHistoryDirectory(path)
  })
  const rollback = () => manager.rollback('rollback', owner.runId, [{ path: 'note.txt', expectedPostHash: hash('new') }])
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(rollback()).rejects.toBe(error)
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(phase === 'intent' ? 'new' : 'old')
    expect(await manager.pendingOwners()).toHaveLength(1)
  }
  vi.mocked(syncFileHistoryDirectory).mockImplementation(actualHistory.syncFileHistoryDirectory)
  expect((await rollback()).status).toBe('completed')
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('old')
})
