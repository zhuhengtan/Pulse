import { constants } from 'node:fs'
import { access, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path'
import type { HostPathEntry, HostPathListing, HostPathMode, HostPathRoots } from '../protocol.js'

export class HostFilesystemError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
export function hostFilesystemError(error: unknown): HostFilesystemError {
  if (error instanceof HostFilesystemError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return new HostFilesystemError('HOST_PATH_FORBIDDEN', 403)
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return new HostFilesystemError('HOST_PATH_NOT_FOUND', 404)
  if (code === 'EEXIST') return new HostFilesystemError('HOST_PATH_EXISTS', 409)
  return new HostFilesystemError('HOST_FILESYSTEM_FAILED', 400)
}
function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value)) throw new HostFilesystemError('HOST_ABSOLUTE_PATH_REQUIRED', 400)
  return value
}
export function validateDirectoryName(name: unknown, platform = process.platform): asserts name is string {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\\/\0]/.test(name) || Buffer.byteLength(name) > 255) throw new HostFilesystemError('HOST_DIRECTORY_NAME_INVALID', 400)
  if (platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) throw new HostFilesystemError('HOST_DIRECTORY_NAME_INVALID', 400)
}
/** Breadcrumb paths are computed on the host, never using the phone's OS. */
export function hostBreadcrumbs(path: string, windows = process.platform === 'win32') {
  const api = windows ? win32 : posix
  const root = api.parse(path).root
  let current = root
  return [{ name: root, path: root }, ...path.slice(root.length).split(windows ? /[\\/]/ : /\//).filter(Boolean).map(name => { current = api.join(current, name); return { name, path: current } })]
}
async function readableDirectory(input: unknown) {
  const path = await realpath(absolutePath(input))
  if (!(await stat(path)).isDirectory()) throw new HostFilesystemError('HOST_DIRECTORY_REQUIRED', 400)
  await access(path, constants.R_OK | constants.X_OK)
  return path
}
export async function hostPathRoots(): Promise<HostPathRoots> {
  const home = await realpath(homedir())
  const candidates = process.platform === 'win32' ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`) : ['/']
  const roots: HostPathRoots['roots'] = []
  for (const path of candidates) { try { roots.push({ name: path, path: await readableDirectory(path) }) } catch { /* Offline and unreadable drives are omitted. */ } }
  return { home, roots }
}
export async function listHostPaths(input: unknown, mode: HostPathMode, hidden: boolean, offset: number): Promise<HostPathListing> {
  if (!['file', 'directory', 'both'].includes(mode) || !Number.isSafeInteger(offset) || offset < 0) throw new HostFilesystemError('HOST_LIST_INPUT_INVALID', 400)
  const path = await readableDirectory(input)
  const children = (await readdir(path, { withFileTypes: true })).filter(entry => hidden || !entry.name.startsWith('.'))
  const entries: HostPathEntry[] = []
  // Bound filesystem concurrency, including resolution of symlinks and permission checks.
  for (let index = 0; index < children.length; index += 32) {
    entries.push(...(await Promise.all(children.slice(index, index + 32).map(async entry => {
      const source = join(path, entry.name)
      try {
        const canonical = await realpath(source)
        const info = await stat(canonical)
        if (!info.isDirectory() && !info.isFile()) return null
        if (mode === 'directory' && !info.isDirectory()) return null
        await access(canonical, constants.R_OK | (info.isDirectory() ? constants.X_OK : 0))
        return { name: entry.name, path: canonical, kind: info.isDirectory() ? 'directory' : 'file', symlink: entry.isSymbolicLink() } as HostPathEntry
      } catch (error) {
        return { name: entry.name, path: source, kind: entry.isDirectory() ? 'directory' : 'file', unavailable: hostFilesystemError(error).code, symlink: entry.isSymbolicLink() } as HostPathEntry
      }
    }))).filter((entry): entry is HostPathEntry => entry !== null))
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'en', { numeric: true }) || a.name.localeCompare(b.name))
  const page = entries.slice(offset, offset + 200)
  return { path, name: basename(path) || path, parent: dirname(path) === path ? null : dirname(path), breadcrumbs: hostBreadcrumbs(path), entries: page, nextOffset: offset + page.length < entries.length ? offset + page.length : null }
}
export async function createHostDirectory(parentPath: unknown, name: unknown) {
  validateDirectoryName(name)
  const parent = await readableDirectory(parentPath)
  const path = join(parent, name)
  await mkdir(path) // No recursive creation and no overwrite, even for a symlink.
  return { path: await realpath(path), kind: 'directory' as const }
}
