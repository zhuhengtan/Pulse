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
  externalValidation?: boolean
  /** An apply was about to start; only a persisted merged record clears it.
   * A crash or failed save requires inspection, never an automatic retry. */
  mergeState?: 'applying'
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

/** True when Git's ignore rules already prevent `git add` from staging this
 * path (an ignored parent directory counts). Only exit code 1 means "not
 * ignored"; every other failure is a real Git error and must surface. */
async function isGitIgnored(cwd: string, path: string): Promise<boolean> {
  try {
    await exec('git', ['check-ignore', '--quiet', '--', path], { cwd, encoding: 'utf8', windowsHide: true })
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false
    throw error
  }
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
  // File names may consist entirely of whitespace; never trim Git path output.
  const changed = await git(cwd, ['diff', '--cached', '--name-only', '-z'])
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
    // Naming a path that lives inside an ignored directory (e.g. `.pulse-dev/`)
    // as a pathspec makes `git add` treat it as an explicit request for ignored
    // content and fail with "The following paths are ignored". Ignored paths are
    // never staged without --force anyway, so such a runtime directory needs no
    // exclude pathspec; only a path git would actually add must be excluded.
    const excludePath = !!excluded && !(await isGitIgnored(projectRoot, excluded))
    await git(projectRoot, ['add', '-A', '--', '.', ...(excludePath ? [`:(exclude)${excluded}`] : [])], 128 * 1024 * 1024, env)
    const tree = (await git(projectRoot, ['write-tree'], 64 * 1024 * 1024, env)).trim()
    return (await git(projectRoot, ['-c', 'user.name=Pulse Workspace', '-c', 'user.email=pulse-workspace@localhost', 'commit-tree', tree, '-p', parentCommit, '-m', 'Pulse latest project snapshot'])).trim()
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined)
    await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined)
  }
}

/** Module-wide cap on concurrent read-only boundary probes (no caching). */
const MAX_BOUNDARY_PROBES = 4
let activeProbes = 0
const probeWaiters: Array<() => void> = []

async function limitProbe<T>(run: () => Promise<T>): Promise<T> {
  if (activeProbes >= MAX_BOUNDARY_PROBES) await new Promise<void>(resolveSlot => probeWaiters.push(resolveSlot))
  else activeProbes++
  try { return await run() }
  finally {
    // Hand the slot directly to the next waiter, otherwise release it.
    const next = probeWaiters.shift()
    if (next) next()
    else activeProbes--
  }
}

/** A known-path guard, not an object-store or OS sandbox. Linked worktrees
 * still share every Git object with the project. Do not read private file
 * contents here: inspect names and history only, and fail closed on errors. */
async function assertSelfHostDataBoundary(projectRoot: string, dataRoots: string[], excludedRoot: string): Promise<void> {
  const ownRuntime = inside(projectRoot, excludedRoot) ? excludedRoot : undefined
  const paths = [':(icase,glob)**/.pulse', ':(icase,glob)**/.pulse/**', ':(icase,glob)**/.pulse-*', ':(icase,glob)**/.pulse-*/**']
  for (const dataRoot of dataRoots) {
    if (inside(dataRoot, projectRoot)) paths.push('.')
    else if (inside(projectRoot, dataRoot)) paths.push(`:(icase,literal)${relative(projectRoot, dataRoot).split(sep).join('/')}`)
  }
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  // Every probe is fresh and read-only; concurrency is bounded module-wide.
  const inspect = (args: string[]) => limitProbe(() => git(projectRoot, args, 64 * 1024 * 1024, env))
  const unverifiable = () => new Error('SELF_HOST_HISTORY_UNVERIFIABLE')
  try {
    // Phase 1: eligibility preflight. Incomplete or substituted histories cannot
    // establish even the limited known-path guarantee. Never fetch missing
    // objects or repair the repo. All checks must finish and pass before any
    // file listing or history traversal starts. Results are evaluated in the
    // original order, so the first original failure wins.
    const preflight = await Promise.allSettled([
      inspect(['rev-parse', '--is-shallow-repository']).then(out => { if (out.trim() !== 'false') throw unverifiable() }),
      inspect(['for-each-ref', '--format=%(refname)', 'refs/replace']).then(out => { if (out.trim()) throw unverifiable() }),
      inspect(['count-objects', '-v']).then(out => { if (/^alternate:/m.test(out)) throw unverifiable() }),
      // The grafts lstat depends on the resolved path, so it stays chained.
      inspect(['rev-parse', '--git-path', 'info/grafts']).then(async out => {
        const exists = await lstat(resolve(projectRoot, out.trim())).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
        if (exists) throw unverifiable()
      }),
      // Exit code 1 only means "no matching config"; other failures surface.
      inspect(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'])
        .catch(error => { if (error.code === 1) return ''; throw error })
        .then(out => { if (out.trim()) throw unverifiable() }),
    ])
    for (const result of preflight) if (result.status === 'rejected') throw result.reason

    // Phase 2: data and history probes are independent and may overlap, but we
    // await all of them (drain) and then evaluate in the original order.
    // Tracked workspace metadata is unsafe too. Only untracked files inside
    // this manager's own runtime workspace directory may be ignored.
    const [tracked, untracked, ignoredFiles, history] = await Promise.allSettled([
      inspect(['ls-files', '--cached', '-z', '--', ...paths]),
      inspect(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]),
      inspect(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...paths]),
      // HEAD-only checks miss deleted files, other branches and reflog history.
      inspect(['log', '--all', '--reflog', '--full-history', '--format=%H', '-n', '1', '--', ...paths]),
    ])
    if (tracked.status === 'rejected') throw tracked.reason
    if (tracked.value.length) throw new Error('SELF_HOST_INTERNAL_DATA_PRESENT')
    for (const listing of [untracked, ignoredFiles]) {
      if (listing.status === 'rejected') throw listing.reason
      const files = listing.value.split('\0').filter(Boolean)
      if (files.some(file => !ownRuntime || !inside(ownRuntime, resolve(projectRoot, validateRelative(file))))) throw new Error('SELF_HOST_INTERNAL_DATA_PRESENT')
    }
    if (history.status === 'rejected') throw history.reason
    if (history.value.trim()) throw new Error('SELF_HOST_INTERNAL_HISTORY_PRESENT')
  } catch (error) {
    if (/^SELF_HOST_(INTERNAL_DATA_PRESENT|INTERNAL_HISTORY_PRESENT|HISTORY_UNVERIFIABLE)$/.test((error as Error).message)) throw error
    throw new Error('SELF_HOST_HISTORY_UNVERIFIABLE')
  }
}

export class H5WorkspaceManager {
  static readonly selfHostBeforeApply = 1
  static readonly selfHostInternalDataBoundary = 1
  private readonly root: string
  private readonly dataRoot: string
  private readonly recordsRoot: string
  private readonly scratchRoot: string
  private readonly sharedLocksRoot: string
  private readonly sharedLockHandles = new Map<string, { handle: Awaited<ReturnType<typeof open>>; path: string }>()

  constructor(dataDir: string) {
    this.dataRoot = resolve(dataDir)
    this.root = resolve(dataDir, 'workspaces')
    this.recordsRoot = join(this.root, 'records')
    this.scratchRoot = join(this.root, 'scratch')
    this.sharedLocksRoot = join(this.root, 'shared-locks')
  }

  private async canonicalWorkspaceRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    return realpath(this.root).catch(() => this.root)
  }

  private async assertSelfHostBoundary(projectRoot: string, excludedRoot: string, sourceRoot = projectRoot): Promise<void> {
    const roots = [this.dataRoot, await realpath(this.dataRoot)].flatMap(root => {
      if (inside(root, sourceRoot)) return [projectRoot]
      return inside(sourceRoot, root) ? [resolve(projectRoot, relative(sourceRoot, root))] : []
    })
    await assertSelfHostDataBoundary(projectRoot, roots, excludedRoot)
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

  /** New tasks use the selected directory, without requiring Git. Isolation is
   * an explicit caller choice after the user requests it, never an inference
   * from the presence of a repository. Retain unfinished legacy work in place. */
  async prepare(conversationId: string, projectId: string, requestedCwd: string, options?: { isolated: true; externalValidation?: boolean }): Promise<PreparedWorkspace> {
    const excludedRoot = await this.canonicalWorkspaceRoot()
    const existing = await this.get(conversationId)
    if (existing?.mergeState) throw new Error('WORKSPACE_MERGE_RESULT_UNKNOWN')
    if (existing?.externalValidation) options = { isolated: true, externalValidation: true }
    if (existing && existing.status !== 'merged' && existing.status !== 'noop') {
      if (workspaceKind(existing) === 'shared') {
        if (options?.externalValidation) throw new Error('SELF_HOST_ISOLATION_REQUIRED')
        return this.prepareShared(conversationId, projectId, existing.projectRoot)
      }
      // Resuming a workspace also writes its record. Coordinate with finalizers
      // so dependency setup cannot later overwrite applying/merged with running.
      const commonDir = (await git(existing.projectRoot, ['rev-parse', '--git-common-dir'])).trim()
      const lockPath = join(await realpath(resolve(existing.projectRoot, commonDir)), 'pulse-workspace-merge.lock')
      const lock = await open(lockPath, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new Error('WORKSPACE_MERGE_LOCKED')
        throw error
      })
      try {
        await lock.writeFile(String(process.pid))
        const current = await this.get(conversationId)
        if (!current) throw new Error('WORKSPACE_RECORD_MISSING')
        if (current.mergeState) throw new Error('WORKSPACE_MERGE_RESULT_UNKNOWN')
        if (current.status === 'merged' || current.status === 'noop') throw new Error('WORKSPACE_ALREADY_FINISHED')
        if (current.externalValidation || options?.externalValidation) {
          await this.assertSelfHostBoundary(current.projectRoot, excludedRoot)
          await this.assertSelfHostBoundary(current.worktreeRoot, excludedRoot, current.projectRoot)
        }
        await this.prepareDependencies(current.projectRoot, current.worktreeRoot)
        if (options?.externalValidation) current.externalValidation = true
        current.status = 'running'; current.updatedAt = new Date().toISOString(); await this.save(current)
        return { cwd: join(current.worktreeRoot, current.projectSubdirectory), isolated: true }
      } finally { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) }
    }
    const projectCwd = await realpath(requestedCwd)
    if (options?.isolated !== true) return this.prepareShared(conversationId, projectId, projectCwd)
    let projectRoot: string
    try { projectRoot = (await git(projectCwd, ['rev-parse', '--show-toplevel'])).trim() }
    catch { if (options?.externalValidation) throw new Error('SELF_HOST_ISOLATION_REQUIRED'); return this.prepareShared(conversationId, projectId, projectCwd) }
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
      if (ignored) { if (options?.externalValidation) throw new Error('SELF_HOST_ISOLATION_REQUIRED'); return this.prepareShared(conversationId, projectId, projectCwd) }
    }
    if (options?.externalValidation) await this.assertSelfHostBoundary(projectRoot, excludedRoot)
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
      if (options?.externalValidation) await this.assertSelfHostBoundary(worktreeRoot, excludedRoot, projectRoot)
      const record: WorktreeRecord = { schemaVersion: 1, kind: 'git', conversationId, projectId, projectRoot, worktreeRoot, projectSubdirectory, baselineCommit, ...(options?.externalValidation ? { externalValidation: true } : {}), status: 'running', updatedAt: new Date().toISOString() }
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

  /** External self-host checks run on the integrated tree before it touches the project. */
  async finishVerified(conversationId: string, validate: (cwd: string) => Promise<void>, options?: { beforeApply?: () => void }): Promise<{ status: WorktreeRecord['status']; conflictPaths?: string[]; error?: string }> {
    if (typeof validate !== 'function') throw new Error('SELF_HOST_VALIDATOR_REQUIRED')
    return this.finish(conversationId, true, validate, options)
  }

  async finish(conversationId: string, succeeded: boolean, validate?: (cwd: string) => Promise<void>, options?: { beforeApply?: () => void }): Promise<{ status: WorktreeRecord['status']; conflictPaths?: string[]; error?: string }> {
    let record = await this.get(conversationId)
    if (!record) { if (validate) throw new Error('WORKSPACE_RECORD_MISSING'); return { status: 'noop' } }
    if (record.mergeState) throw new Error('WORKSPACE_MERGE_RESULT_UNKNOWN')
    if (record.status === 'merged' || record.status === 'noop') return { status: record.status }
    if (validate && workspaceKind(record) !== 'git') throw new Error('SELF_HOST_ISOLATION_REQUIRED')
    if (workspaceKind(record) === 'shared') {
      record.status = succeeded ? 'merged' : 'pending'; record.updatedAt = new Date().toISOString(); await this.save(record)
      await this.releaseShared(conversationId)
      return { status: record.status }
    }
    const excludedRoot = await this.canonicalWorkspaceRoot()
    const commonDir = (await git(record.projectRoot, ['rev-parse', '--git-common-dir'])).trim()
    const lockPath = join(await realpath(resolve(record.projectRoot, commonDir)), 'pulse-workspace-merge.lock')
    await mkdir(dirname(lockPath), { recursive: true })
    let lock: Awaited<ReturnType<typeof open>>
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch (error) {
      // A PID alone cannot establish machine identity or exclude PID reuse.
      // Never steal this lock or overwrite a concurrently completed record.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'conflict', conflictPaths: [], error: 'WORKSPACE_MERGE_LOCKED' }
      throw Object.assign(error as Error, { selfHostMerge: 'not_applied' })
    }
    let applyStarted = false
    try {
      await lock.writeFile(String(process.pid))
      // All Git finalizers share the lock, including late stream completion.
      // Re-read after acquiring it rather than saving the stale initial read.
      record = await this.get(conversationId)
      if (!record) throw new Error('WORKSPACE_RECORD_MISSING')
      if (record.mergeState) { applyStarted = true; throw new Error('WORKSPACE_MERGE_RESULT_UNKNOWN') }
      if (record.status === 'merged' || record.status === 'noop') return { status: record.status }
      if (!succeeded || (record.externalValidation && !validate)) {
        record.status = 'pending'; record.updatedAt = new Date().toISOString(); await this.save(record); return { status: 'pending' }
      }
      if (validate) {
        await this.assertSelfHostBoundary(record.projectRoot, excludedRoot)
        await this.assertSelfHostBoundary(record.worktreeRoot, excludedRoot, record.projectRoot)
      }
      await git(record.worktreeRoot, ['add', '-A'])
      // The task or an earlier merge attempt may already have committed its output.
      if (!validate && !(await git(record.worktreeRoot, ['diff', '--cached', '--name-only', '-z', record.baselineCommit, '--'])).length) {
        record.status = 'noop'; record.updatedAt = new Date().toISOString(); await this.save(record)
        await git(record.projectRoot, ['worktree', 'remove', '--force', record.worktreeRoot]).catch(() => undefined)
        return { status: 'noop' }
      }
      const outputCommit = await commitSnapshot(record.worktreeRoot, 'Pulse task result')
      const outputVersion = validate ? await liveVersion(record.worktreeRoot, excludedRoot) : null
      for (let attempt = 0; attempt < 3; attempt++) {
        const version = await liveVersion(record.projectRoot, excludedRoot)
        const scratch = join(this.scratchRoot, `merge-${conversationId}-${randomUUID()}`)
        const integration = join(this.root, 'integrations', `${conversationId}-${randomUUID()}`)
        await mkdir(scratch, { recursive: true }); await mkdir(dirname(integration), { recursive: true })
        let currentCommit = record.baselineCommit
        let mergedTree: string | undefined
        try {
          if (validate) await this.assertSelfHostBoundary(record.projectRoot, excludedRoot)
          currentCommit = await snapshotCurrentProject(record.projectRoot, scratch, record.baselineCommit, excludedRoot)
          await git(record.projectRoot, ['worktree', 'add', '--detach', integration, currentCommit])
          const merge = await exec('git', ['merge', '--no-commit', '--no-ff', outputCommit], { cwd: integration, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }).catch(error => error as { code?: number; stdout?: string; stderr?: string })
          if (typeof merge === 'object' && 'code' in merge && merge.code !== undefined) {
            const conflicts = await git(integration, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '')
            if (!conflicts.length) {
              const detail = 'stderr' in merge && typeof merge.stderr === 'string' ? merge.stderr : 'git merge failed without conflict entries'
              throw new Error(`WORKSPACE_MERGE_FAILED:${detail.slice(0, 500)}`)
            }
            record.status = 'conflict'; record.conflictPaths = conflicts.split('\0').filter(Boolean); record.updatedAt = new Date().toISOString(); await this.save(record)
            return { status: 'conflict', conflictPaths: record.conflictPaths }
          }
          mergedTree = (await git(integration, ['write-tree'])).trim()
          if (validate) {
            await this.prepareDependencies(record.projectRoot, integration)
            await this.assertSelfHostBoundary(integration, excludedRoot, record.projectRoot)
            const integratedVersion = await liveVersion(integration, excludedRoot)
            await validate(join(integration, record.projectSubdirectory))
            await this.assertSelfHostBoundary(integration, excludedRoot, record.projectRoot)
            await this.assertSelfHostBoundary(record.worktreeRoot, excludedRoot, record.projectRoot)
            await this.assertSelfHostBoundary(record.projectRoot, excludedRoot)
            if (await liveVersion(integration, excludedRoot) !== integratedVersion) throw new Error('SELF_HOST_VALIDATION_CHANGED_SOURCE')
            if (await liveVersion(record.worktreeRoot, excludedRoot) !== outputVersion) throw new Error('SELF_HOST_CANDIDATE_CHANGED')
          }
          if (await liveVersion(record.projectRoot, excludedRoot) !== version) continue
          const patch = await git(integration, ['diff', '--binary', currentCommit, mergedTree], 128 * 1024 * 1024)
          if (patch) {
            const patchPath = join(scratch, 'merged-result.patch')
            await writeFile(patchPath, patch, { mode: 0o600 })
            record.mergeState = 'applying'; record.updatedAt = new Date().toISOString(); await this.save(record)
            // Synchronous cancellation checkpoint: no await between it and
            // spawning apply. A rejected checkpoint is known not to have applied.
            try { options?.beforeApply?.() }
            catch (error) {
              delete record.mergeState
              try { await this.save(record) }
              catch (saveError) { applyStarted = true; throw saveError }
              throw error
            }
            applyStarted = true
            await git(record.projectRoot, ['apply', '--binary', patchPath], 128 * 1024 * 1024)
          } else options?.beforeApply?.()
          record.status = 'merged'; record.updatedAt = new Date().toISOString(); delete record.conflictPaths; delete record.mergeState; await this.save(record)
          await git(record.projectRoot, ['worktree', 'remove', '--force', record.worktreeRoot]).catch(() => undefined)
          return { status: 'merged' }
        } finally {
          await git(record.projectRoot, ['worktree', 'remove', '--force', integration]).catch(() => undefined)
          await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      record.status = 'conflict'; record.conflictPaths = []; record.updatedAt = new Date().toISOString(); await this.save(record)
      return { status: 'conflict', conflictPaths: [] }
    } catch (error) {
      if (!applyStarted) Object.assign(error as Error, { selfHostMerge: 'not_applied' })
      throw error
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
