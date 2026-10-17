import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Host workspaces and linked aliases need dependencies; unrelated scripts do not. */
export async function workspaceUsesInstallationDependencies(workspace: string, roots: string[]): Promise<boolean> {
  const contains = (root: string, path: string): boolean => {
    const child = relative(root, path)
    return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }
  if (roots.some(root => contains(dirname(root), workspace))) return true
  const modules = await realpath(join(workspace, 'node_modules')).catch(() => undefined)
  if (!modules) return false
  if (roots.some(root => contains(root, modules))) return true
  // An ordinary project can link individual packages rather than its entire
  // node_modules directory. Inspect only metadata inside that workspace tree.
  if (!contains(workspace, modules)) return false
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    const path = join(modules, entry.name)
    const target = await realpath(path).catch(() => undefined)
    if (target && roots.some(root => contains(root, target))) return true
    if (entry.name.startsWith('@') && entry.isDirectory() && target && contains(workspace, target)) {
      for (const name of await readdir(path)) {
        const scoped = await realpath(join(path, name)).catch(() => undefined)
        if (scoped && roots.some(root => contains(root, scoped))) return true
      }
    }
  }
  return false
}
/** Host installation only. Never resolve grants from model argv or workspace links. */
export async function installationDependencyRoots(): Promise<string[]> {
  const roots = new Set<string>()
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 12 && directory !== homedir() && directory !== parse(directory).root; depth++) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').then(text => JSON.parse(text) as { workspaces?: unknown }).catch(() => undefined)
    const candidates = [...(manifest ? [join(directory, 'node_modules')] : []), ...(basename(directory) === 'node_modules' ? [directory] : [])]
    for (const candidate of candidates) {
      const physical = await realpath(candidate).catch(() => undefined)
      // Installation links may point to an installed module store, never a
      // source checkout, home or root. Keep the lexical module directory too:
      // Node must inspect package aliases before resolving their real targets.
      if (!physical || basename(physical) !== 'node_modules' || !(await stat(physical)).isDirectory()) continue
      roots.add(candidate); roots.add(physical)
    }
    if (manifest?.workspaces || basename(directory) === 'node_modules' && !directory.includes(`${join('node_modules', '.pnpm')}`)) break
    directory = dirname(directory)
  }
  return [...roots]
}
