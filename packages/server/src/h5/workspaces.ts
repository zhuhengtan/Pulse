import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open, copyFile, lstat, mkdir, readFile, realpath, rm, symlink, writeFile, readlink } from 'node:fs/promises'
import { replaceStateFile } from '../atomic-file.js'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { prepareWorkspaceDependencies } from './dependencies.js'

const exec = promisify(execFile)

export interface WorktreeRecord {
  schemaVersion: 1
  conversationId: string
  projectId: string
  projectRoot: string
  worktreeRoot: string
  projectSubdirectory: string
  baselineCommit: string
  /** Optional only for records written before workspace kind was persisted. */
  kind?: 'git' | 'shared'
  status: 'running' | 'pending' | 'merged' | 'conflict' | 'noop' | 'shared'
  updatedAt: string
  conflictPaths?: string[]
}

export interface PreparedWorkspace { cwd: string; isolated: boolean }

function workspaceKind(record: WorktreeRecord): 'git' | 'shared' {
  return record.kind ?? (record.baselineCommit === '' ? 'shared' : 'git')
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function validateRelative(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => part === '..')) throw new Error('WORKTREE_PATH_INVALID')
  return normalized
}

async function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await exec('git', args, { cwd, encoding: 'utf8', maxBuffer, windowsHide: true, ...(env ? { env } : {}) })
  return result.stdout
}

async function copyWorkingFiles(sourceRoot: string, destinationRoot: string, excludedRoot?: string): Promise<void> {
  const excluded = excludedRoot && inside(sourceRoot, excludedRoot) ? relative(sourceRoot, excludedRoot).split(sep).join('/') : undefined
  const output = await git(sourceRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  for (const raw of output.split('\0')) {
    if (!raw) continue
    const path = validateRelative(raw)
    if (excluded && (path === excluded || path.startsWith(`${excluded}/`))) continue
    const source = resolve(sourceRoot, path)
    const destination = resolve(destinationRoot, path)
    if (!inside(sourceRoot, source) || !inside(destinationRoot, destination)) throw new Error('WORKTREE_PATH_INVALID')
    // Cached index entries below a replaced directory symlink are deletions,
    // not current working files. Never follow them into another directory.
    let linkedParent = false
    for (let parent = dirname(source); inside(sourceRoot, parent) && relative(sourceRoot, parent) !== ''; parent = dirname(parent)) {
      const info = await lstat(parent).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (info?.isSymbolicLink()) { linkedParent = true; break }
    }
    if (linkedParent) continue
    for (let parent = dirname(destination); inside(destinationRoot, parent) && relative(destinationRoot, parent) !== ''; parent = dirname(parent)) {
      const info = await lstat(parent).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (info?.isSymbolicLink()) throw new Error('WORKTREE_PATH_INVALID')
    }
    const info = await lstat(source).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) continue // Tracked deletions were already applied by the patch.
    await mkdir(dirname(destination), { recursive: true })
    if (info.isSymbolicLink()) {
      const target = await readlink(source)
      await rm(destination, { force: true })
      await symlink(target, destination)
    } else if (info.isFile()) {
      await rm(destination, { force: true })
      await copyFile(source, destination)
    }
  }
}

async function applyTrackedSnapshot(sourceRoot: string, destinationRoot: string, baseline: string, scratch: string, excludedRoot?: string): Promise<void> {
  const patch = await git(sourceRoot, ['diff', '--binary', baseline, '--'], 128 * 1024 * 1024)
  if (patch) {
    const file = join(scratch, `snapshot-${randomUUID()}.patch`)
    await writeFile(file, patch, { mode: 0o600 })
    try { await git(destinationRoot, ['apply', '--binary', file], 128 * 1024 * 1024) }
    finally { await rm(file, { force: true }) }
  }
  // Git checkout filters (including core.autocrlf) can change unchanged tracked
  // bytes. Preserve the actual project content used by recovery fingerprints.
  await copyWorkingFiles(sourceRoot, destinationRoot, excludedRoot)
}

async function commitSnapshot(cwd: string, title: string): Promise<string> {
  await git(cwd, ['add', '-A'])
  const changed = (await git(cwd, ['diff', '--cached', '--name-only'])).trim()
  if (changed) await git(cwd, ['-c', 'user.name=Pulse Workspace', '-c', 'user.email=pulse-workspace@localhost', 'commit', '--quiet', '--no-gpg-sign', '-m', title])
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

async function liveVersion(projectRoot: string, excludedRoot?: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update((await git(projectRoot, ['rev-parse', 'HEAD'])).trim())
  hash.update(await git(projectRoot, ['diff', '--binary', 'HEAD', '--'], 128 * 1024 * 1024))
  const untracked = (await git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort()
  const excluded = excludedRoot && inside(projectRoot, excludedRoot) ? relative(projectRoot, excludedRoot).split(sep).join('/') : undefined
  for (const raw of untracked) {
    const path = validateRelative(raw)
    if (excluded && (path === excluded || path.startsWith(`${excluded}/`))) continue
    const file = resolve(projectRoot, path)
    const info = await lstat(file)
    hash.update(path)
    if (info.isFile()) hash.update(await readFile(file))
    else if (info.isSymbolicLink()) hash.update(await readlink(file))
  }
  return hash.digest('hex')
}

/** Snapshot the current worktree with a disposable index, leaving the user's
 * staged index and working tree metadata untouched. */
async function snapshotCurrentProject(projectRoot: string, scratch: string, parentCommit: string, excludedRoot?: string): Promise<string> {
  const indexPath = join(scratch, `index-${randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  try {
    await git(projectRoot, ['read-tree', parentCommit], 64 * 1024 * 1024, env)
    const excluded = excludedRoot && inside(projectRoot, excludedRoot) ? relative(projectRoot, excludedRoot).split(sep).join('/') : undefined
    await git(projectRoot, ['add', '-A', '--', '.', ...(excluded ? [`:(exclude)${excluded}`] : [])], 128 * 1024 * 1024, env)
    const tree = (await git(projectRoot, ['write-tree'], 64 * 1024 * 1024, env)).trim()
    return (await git(projectRoot, ['-c', 'user.name=Pulse Workspace', '-c', 'user.email=pulse-workspace@localhost', 'commit-tree', tree, '-p', parentCommit, '-m', 'Pulse latest project snapshot'])).trim()
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined)
    await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined)
  }
}

export class H5WorkspaceManager {
  private readonly root: string
  private readonly recordsRoot: string
  private readonly scratchRoot: string
  private readonly sharedLocksRoot: string
  private readonly sharedLockHandles = new Map<string, { handle: Awaited<ReturnType<typeof open>>; path: string }>()

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'workspaces')
    this.recordsRoot = join(this.root, 'records')
    this.scratchRoot = join(this.root, 'scratch')
    this.sharedLocksRoot = join(this.root, 'shared-locks')
  }

  private async canonicalWorkspaceRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    return realpath(this.root).catch(() => this.root)
  }

  private recordPath(conversationId: string): string { return join(this.recordsRoot, `${conversationId}.json`) }
  async get(conversationId: string): Promise<WorktreeRecord | undefined> {
    return readFile(this.recordPath(conversationId), 'utf8').then(text => JSON.parse(text) as WorktreeRecord).catch(() => undefined)
  }

  private async save(record: WorktreeRecord): Promise<void> {
    await mkdir(this.recordsRoot, { recursive: true })
    const path = this.recordPath(record.conversationId)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 })
    try { await replaceStateFile(temporary, path) } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  async prepare(conversationId: string, projectId: string, requestedCwd: string): Promise<PreparedWorkspace> {
    const excludedRoot = await this.canonicalWorkspaceRoot()
    const existing = await this.get(conversationId)
    if (existing && existing.status !== 'merged' && existing.status !== 'noop') {
      if (workspaceKind(existing) === 'shared') return this.prepareShared(conversationId, projectId, existing.projectRoot)
      await this.prepareDependencies(existing.projectRoot, existing.worktreeRoot)
      existing.status = 'running'; existing.updatedAt = new Date().toISOString(); await this.save(existing)
      return { cwd: join(existing.worktreeRoot, existing.projectSubdirectory), isolated: true }
    }
    const projectCwd = await realpath(requestedCwd)
    let projectRoot: string
    try { projectRoot = (await git(projectCwd, ['rev-parse', '--show-toplevel'])).trim() }
    catch { return this.prepareShared(conversationId, projectId, projectCwd) }
    projectRoot = await realpath(projectRoot)
    if (!inside(projectRoot, projectCwd)) throw new Error('PROJECT_DIRECTORY_OUTSIDE_GIT_ROOT')
    const projectSubdirectory = relative(projectRoot, projectCwd)
    // An ignored, untracked project is not represented in its ancestor repository.
    // Keep the explicitly selected directory and the existing shared-directory lock.
    if (projectSubdirectory && !(await git(projectRoot, ['ls-files', '-z', '--', projectSubdirectory])).trim()) {
      const ignored = await git(projectRoot, ['check-ignore', '--', projectSubdirectory + '/']).then(() => true, error => {
        if (error.code === 1) return false
        throw error
      })
      if (ignored) return this.prepareShared(conversationId, projectId, projectCwd)
    }
    const worktreeRoot = join(this.root, 'git', conversationId)
    const scratch = join(this.scratchRoot, conversationId)
    await mkdir(scratch, { recursive: true })
    await mkdir(dirname(worktreeRoot), { recursive: true })
    const head = (await git(projectRoot, ['rev-parse', 'HEAD'])).trim()
    try {
      await git(projectRoot, ['worktree', 'add', '--detach', worktreeRoot, head])
      await applyTrackedSnapshot(projectRoot, worktreeRoot, head, scratch, excludedRoot)
      // Git does not materialize empty project directories.
      await mkdir(join(worktreeRoot, projectSubdirectory), { recursive: true })
      const baselineCommit = await commitSnapshot(worktreeRoot, 'Pulse task starting snapshot')
      await this.prepareDependencies(projectRoot, worktreeRoot)
      const record: WorktreeRecord = { schemaVersion: 1, kind: 'git', conversationId, projectId, projectRoot, worktreeRoot, projectSubdirectory, baselineCommit, status: 'running', updatedAt: new Date().toISOString() }
      await this.save(record)
      return { cwd: join(worktreeRoot, projectSubdirectory), isolated: true }
    } catch (error) {
      await git(projectRoot, ['worktree', 'remove', '--force', worktreeRoot]).catch(() => undefined)
      throw error
    } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined) }
  }

  private async prepareDependencies(projectRoot: string, worktreeRoot: string): Promise<void> {
    const packages = (await git(projectRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'package.json', '**/package.json'])).split('\0').filter(Boolean)
    await prepareWorkspaceDependencies(projectRoot, worktreeRoot, packages)
  }

  private async prepareShared(conversationId: string, projectId: string, cwd: string): Promise<PreparedWorkspace> {
    await mkdir(this.sharedLocksRoot, { recursive: true })
    const key = createHash('sha256').update(cwd).digest('hex')
    const path = join(this.sharedLocksRoot, `${key}.lock`)
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(path, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = await readFile(path, 'utf8').catch(() => '')
      const pid = Number(previous)
      let alive = Number.isSafeInteger(pid) && pid > 0
      if (alive) { try { process.kill(pid, 0) } catch { alive = false } }
      if (alive) throw new Error('PROJECT_DIRECTORY_BUSY')
      await rm(path, { force: true })
      handle = await open(path, 'wx', 0o600)
    }
    await handle.writeFile(String(process.pid))
    this.sharedLockHandles.set(conversationId, { handle, path })
    const record: WorktreeRecord = { schemaVersion: 1, kind: 'shared', conversationId, projectId, projectRoot: cwd, worktreeRoot: cwd, projectSubdirectory: '', baselineCommit: '', status: 'shared', updatedAt: new Date().toISOString() }
    await this.save(record)
    return { cwd, isolated: false }
  }

  async finish(conversationId: string, succeeded: boolean): Promise<{ status: WorktreeRecord['status']; conflictPaths?: string[] }> {
    const record = await this.get(conversationId)
    if (!record) return { status: 'noop' }
    if (workspaceKind(record) === 'shared') {
      record.status = succeeded ? 'merged' : 'pending'; record.updatedAt = new Date().toISOString(); await this.save(record)
      await this.releaseShared(conversationId)
      return { status: record.status }
    }
    if (!succeeded) { record.status = 'pending'; record.updatedAt = new Date().toISOString(); await this.save(record); return { status: 'pending' } }
    const excludedRoot = await this.canonicalWorkspaceRoot()
    await git(record.worktreeRoot, ['add', '-A'])
    // The task or an earlier merge attempt may already have committed its output.
    if (!(await git(record.worktreeRoot, ['diff', '--cached', '--name-only', record.baselineCommit, '--'])).trim()) {
      record.status = 'noop'; record.updatedAt = new Date().toISOString(); await this.save(record)
      await git(record.projectRoot, ['worktree', 'remove', '--force', record.worktreeRoot]).catch(() => undefined)
      return { status: 'noop' }
    }
    const outputCommit = await commitSnapshot(record.worktreeRoot, 'Pulse task result')
    const commonDir = (await git(record.projectRoot, ['rev-parse', '--git-common-dir'])).trim()
    const lockPath = join(await realpath(resolve(record.projectRoot, commonDir)), 'pulse-workspace-merge.lock')
    await mkdir(dirname(lockPath), { recursive: true })
    let lock: Awaited<ReturnType<typeof open>>
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch { record.status = 'conflict'; record.updatedAt = new Date().toISOString(); await this.save(record); return { status: 'conflict', conflictPaths: [] } }
    await lock.writeFile(String(process.pid))
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const version = await liveVersion(record.projectRoot, excludedRoot)
        const scratch = join(this.scratchRoot, `merge-${conversationId}-${randomUUID()}`)
        const integration = join(this.root, 'integrations', `${conversationId}-${randomUUID()}`)
        await mkdir(scratch, { recursive: true }); await mkdir(dirname(integration), { recursive: true })
        let currentCommit = record.baselineCommit
        let mergedTree: string | undefined
        try {
          currentCommit = await snapshotCurrentProject(record.projectRoot, scratch, record.baselineCommit, excludedRoot)
          await git(record.projectRoot, ['worktree', 'add', '--detach', integration, currentCommit])
          const merge = await exec('git', ['merge', '--no-commit', '--no-ff', outputCommit], { cwd: integration, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }).catch(error => error as { code?: number; stdout?: string; stderr?: string })
          if (typeof merge === 'object' && 'code' in merge && merge.code !== undefined) {
            const conflicts = await git(integration, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
            if (!conflicts.trim()) {
              const detail = 'stderr' in merge && typeof merge.stderr === 'string' ? merge.stderr : 'git merge failed without conflict entries'
              throw new Error(`WORKSPACE_MERGE_FAILED:${detail.slice(0, 500)}`)
            }
            record.status = 'conflict'; record.conflictPaths = conflicts.split(/\r?\n/).filter(Boolean); record.updatedAt = new Date().toISOString(); await this.save(record)
            return { status: 'conflict', conflictPaths: record.conflictPaths }
          }
          mergedTree = (await git(integration, ['write-tree'])).trim()
          if (await liveVersion(record.projectRoot, excludedRoot) !== version) continue
          const patch = await git(integration, ['diff', '--binary', currentCommit, mergedTree], 128 * 1024 * 1024)
          if (patch) {
            const patchPath = join(scratch, 'merged-result.patch')
            await writeFile(patchPath, patch, { mode: 0o600 })
            await git(record.projectRoot, ['apply', '--binary', patchPath], 128 * 1024 * 1024)
          }
          record.status = 'merged'; record.updatedAt = new Date().toISOString(); delete record.conflictPaths; await this.save(record)
          await git(record.projectRoot, ['worktree', 'remove', '--force', record.worktreeRoot]).catch(() => undefined)
          return { status: 'merged' }
        } finally {
          await git(record.projectRoot, ['worktree', 'remove', '--force', integration]).catch(() => undefined)
          await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      record.status = 'conflict'; record.conflictPaths = []; record.updatedAt = new Date().toISOString(); await this.save(record)
      return { status: 'conflict', conflictPaths: [] }
    } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
  }

  async releaseShared(conversationId: string): Promise<void> {
    const lock = this.sharedLockHandles.get(conversationId)
    if (!lock) return
    this.sharedLockHandles.delete(conversationId)
    await lock.handle.close().catch(() => undefined)
    await rm(lock.path, { force: true }).catch(() => undefined)
  }

  async close(): Promise<void> {
    await Promise.all([...this.sharedLockHandles.keys()].map(conversationId => this.releaseShared(conversationId)))
  }
}
