import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { FilesystemTool, readRootTooBroad } from '@hunterzhu/pulse-adapters'
import { within } from './security.js'

/** Host-owned, immutable per-run grants. Additional roots never grant writes. */
export interface WorkspaceAccessSnapshot { version: 1; primaryRoot: string; readOnlyRoots: string[] }
const failure = (code: string) => Object.assign(new Error(code), { code, retryable: false })
export function containsWorkspacePath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function captureWorkspaceAccess(primary: string, folders: readonly string[] = []): Promise<WorkspaceAccessSnapshot> {
  if (folders.length > 16 || folders.some(path => typeof path !== 'string' || !path.trim())) throw failure('PROJECT_FOLDERS_INVALID')
  const primaryRoot = await realpath(primary)
  const home = await realpath(homedir()).catch(() => homedir())
  const readOnlyRoots: string[] = []
  for (const path of folders) {
    const root = await realpath(path)
    if (!(await stat(root)).isDirectory()) throw failure('PROJECT_DIRECTORY_REQUIRED')
    if (root === primaryRoot) continue
    // Classify forbidden canonical boundaries before alias changes. In
    // particular, macOS /tmp may name HOME through /private/tmp; it must still
    // fail as an overbroad grant without weakening changed-root rejection.
    if (readRootTooBroad(root, home)) throw failure('SANDBOX_READ_ROOT_TOO_BROAD')
    // The project catalog canonicalizes an explicitly selected folder. A later
    // symlink replacement must not silently authorize a different folder on
    // the next run, even though this is a fresh execution snapshot.
    if (root !== resolve(path)) throw failure('WORKSPACE_ACCESS_ROOT_CHANGED')
    if (containsWorkspacePath(primaryRoot, root) || readOnlyRoots.includes(root)) continue
    readOnlyRoots.push(root)
  }
  return { version: 1, primaryRoot, readOnlyRoots }
}

/** Legacy runs remain single-root. A cross-machine transfer cannot carry source
 * paths as authority on the destination; only its explicitly rebound cwd survives. */
export async function restoreWorkspaceAccess(primary: string, value: unknown, relocated = false): Promise<WorkspaceAccessSnapshot> {
  if (value === undefined || relocated) return captureWorkspaceAccess(primary)
  const saved = value as Partial<WorkspaceAccessSnapshot> | null
  if (!saved || saved.version !== 1 || typeof saved.primaryRoot !== 'string' || !isAbsolute(saved.primaryRoot) || !Array.isArray(saved.readOnlyRoots) || saved.readOnlyRoots.length > 16 || saved.readOnlyRoots.some(path => typeof path !== 'string' || !isAbsolute(path))) throw failure('WORKSPACE_ACCESS_SNAPSHOT_INVALID')
  if (await realpath(primary) !== saved.primaryRoot) throw failure('WORKSPACE_ACCESS_ROOT_CHANGED')
  const snapshot: WorkspaceAccessSnapshot = { version: 1, primaryRoot: saved.primaryRoot, readOnlyRoots: [...saved.readOnlyRoots] }
  await new WorkspaceReadAccess(snapshot).validate()
  return snapshot
}

export class WorkspaceReadAccess {
  readonly snapshot: WorkspaceAccessSnapshot
  readonly roots: string[]
  constructor(snapshot: WorkspaceAccessSnapshot, private readonly primaryPath = snapshot.primaryRoot) {
    this.snapshot = structuredClone(snapshot)
    this.roots = [snapshot.primaryRoot, ...snapshot.readOnlyRoots]
  }
  async validate(): Promise<void> {
    const home = await realpath(homedir()).catch(() => homedir())
    for (const root of this.roots) {
      if (await realpath(root) !== root || !(await stat(root)).isDirectory()) throw failure('WORKSPACE_ACCESS_ROOT_CHANGED')
      if (root !== this.snapshot.primaryRoot && readRootTooBroad(root, home)) throw failure('SANDBOX_READ_ROOT_TOO_BROAD')
    }
  }
  async select(path = '.'): Promise<{ root: string; path: string; primary: boolean }> {
    let target = resolve(this.snapshot.primaryRoot, path)
    const alias = resolve(this.primaryPath)
    if (alias !== this.snapshot.primaryRoot && await realpath(alias) !== this.snapshot.primaryRoot) throw failure('WORKSPACE_ACCESS_ROOT_CHANGED')
    if (alias !== this.snapshot.primaryRoot && isAbsolute(path) && containsWorkspacePath(alias, target)) target = resolve(this.snapshot.primaryRoot, relative(alias, target))
    const root = this.roots.find(root => containsWorkspacePath(root, target))
    if (!root) throw failure('PATH_OUTSIDE_WORKSPACE')
    // Recheck on each operation, not only at restore: replacing an allowed
    // directory with a symlink must not redirect the saved grant.
    if (await realpath(root) !== root) throw failure('WORKSPACE_ACCESS_ROOT_CHANGED')
    return { root, path: await within(root, target), primary: root === this.snapshot.primaryRoot }
  }
  async reader(path = '.') {
    const selected = await this.select(path)
    return { ...selected, filesystem: new FilesystemTool(selected.root, 30_000, selected.root) }
  }
  displayPath(root: string, path: string): string {
    return root === this.snapshot.primaryRoot ? path : resolve(root, path)
  }
}
