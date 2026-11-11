import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

export interface SelfHostFileHistoryBinding {
  version: 1
  conversationId: string
  projectRoot: string
  workspaceRoot: string
  storageRoot: string
  workspaceDev: number
  workspaceIno: number
}

function invalid(): Error { return Object.assign(new Error('SELF_HOST_FILE_HISTORY_INVALID'), { code: 'SELF_HOST_FILE_HISTORY_INVALID', retryable: false }) }
function inside(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)) }

/** File contents must already be synced. Windows cannot fsync a directory
 * through Node's read-only handle; keep validation and all other I/O failures. */
export async function syncFileHistoryDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) throw invalid()
    if (process.platform !== 'win32') await handle.sync()
  } finally { await handle.close() }
}

/** Deliberately does not canonicalize away symlink components before checking them. */
export async function assertRealHistoryDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of relative(current, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    let info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info && create) {
      try { await mkdir(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      info = await lstat(current)
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw invalid()
    const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    try { const opened = await handle.stat(); if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) throw invalid() } finally { await handle.close() }
  }
  if (await realpath(absolute) !== absolute) throw invalid()
}

function expectedStore(dataDir: string, conversationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(conversationId)) throw invalid()
  return resolve(dataDir, 'self-host-file-history', conversationId)
}

function checkSeparation(dataDir: string, project: string, workspace: string, storage: string): void {
  if (inside(project, resolve(dataDir)) || inside(workspace, resolve(dataDir)) || inside(project, storage) || inside(workspace, storage) || inside(storage, project) || inside(storage, workspace) || project === workspace) throw invalid()
}

const keys = ['version', 'conversationId', 'projectRoot', 'workspaceRoot', 'storageRoot', 'workspaceDev', 'workspaceIno'] as const
async function readBinding(storageRoot: string): Promise<SelfHostFileHistoryBinding> {
  const file = join(storageRoot, 'binding.json')
  const info = await lstat(file).catch(() => { throw invalid() })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw invalid()
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 16_384) throw invalid()
    return JSON.parse(await handle.readFile('utf8')) as SelfHostFileHistoryBinding
  } catch { throw invalid() } finally { await handle.close() }
}

export async function validateSelfHostFileHistoryBinding(dataDir: string, binding: SelfHostFileHistoryBinding, conversationId: string, cwd: string): Promise<void> {
  if (!binding || binding.version !== 1 || binding.conversationId !== conversationId || binding.workspaceRoot !== resolve(cwd) || binding.storageRoot !== expectedStore(dataDir, conversationId) || typeof binding.projectRoot !== 'string' || !isAbsolute(binding.projectRoot)) throw invalid()
  checkSeparation(dataDir, binding.projectRoot, binding.workspaceRoot, binding.storageRoot)
  for (const path of [binding.projectRoot, binding.workspaceRoot, binding.storageRoot]) await assertRealHistoryDirectory(path)
  const workspace = await lstat(binding.workspaceRoot)
  if (workspace.dev !== binding.workspaceDev || workspace.ino !== binding.workspaceIno) throw invalid()
  const saved = await readBinding(binding.storageRoot)
  if (!saved || Object.keys(saved).length !== keys.length || keys.some(key => saved[key] !== binding[key])) throw invalid()
}

export async function createSelfHostFileHistoryBinding(dataDir: string, conversationId: string, projectRoot: string, workspaceRoot: string): Promise<SelfHostFileHistoryBinding> {
  const project = resolve(projectRoot), workspace = resolve(workspaceRoot), storageRoot = expectedStore(dataDir, conversationId)
  checkSeparation(dataDir, project, workspace, storageRoot)
  await assertRealHistoryDirectory(project)
  await assertRealHistoryDirectory(workspace)
  await assertRealHistoryDirectory(dataDir)
  const info = await lstat(workspace)
  const binding: SelfHostFileHistoryBinding = { version: 1, conversationId, projectRoot: project, workspaceRoot: workspace, storageRoot, workspaceDev: info.dev, workspaceIno: info.ino }
  await assertRealHistoryDirectory(dirname(storageRoot), true)
  // A pre-existing directory may contain unbound history. Never adopt it, even
  // if binding.json is absent after an interrupted creation.
  await mkdir(storageRoot, { mode: 0o700 })
  await assertRealHistoryDirectory(storageRoot)
  // Never overwrite/rebind a store.
  const handle = await open(join(storageRoot, 'binding.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await handle.writeFile(JSON.stringify(binding)); await handle.sync() } finally { await handle.close() }
  await syncFileHistoryDirectory(storageRoot)
  await validateSelfHostFileHistoryBinding(dataDir, binding, conversationId, workspace)
  return binding
}
