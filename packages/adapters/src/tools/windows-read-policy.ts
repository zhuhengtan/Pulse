import { readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'

/** Dependency reads do not authorize adjacent installation source or secrets. */
export function windowsReadDenyRoots(workspace: string, dependencyRoots: string[]): string[] {
  return [...new Set([dirname(workspace), ...dependencyRoots.map(root => dirname(root))])]
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Carve generated container boundaries, never user-specified explicit denies.
 * Compare filesystem targets just as the native ACL helper does: stamping a
 * junction stamps its target, not the lexical sibling discovered by readdir.
 * This does not add grants; explicit denies remain the native runtime's job.
 */
export async function carveWindowsReadDenies(denied: string[], allowed: string[]): Promise<string[]> {
  const roots = await Promise.all(allowed.map(path => realpath(path)))
  const result = new Set<string>()
  const visited = new Set<string>()
  const visit = async (input: string): Promise<void> => {
    // Resolve before both containment and deduplication. Missing, cyclic or
    // inaccessible targets abort setup rather than silently dropping a deny.
    const path = await realpath(input)
    if (visited.has(path) || roots.some(root => within(path, root))) return
    visited.add(path)
    if (!roots.some(root => within(root, path))) { result.add(path); return }
    // Windows inherited DENY ACEs are not POSIX allow-within-deny rules.
    // Deny siblings along the allowed path, keeping only ancestor metadata
    // accessible. An enumeration failure aborts setup rather than dropping a deny.
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  for (const path of denied) await visit(path)
  return [...result]
}

/** Read grants are additive; inherited Users/Everyone write rights need a deny. */
export async function windowsToolchainWriteDenies(readRoots: string[], writeRoots: string[]): Promise<string[]> {
  const canonical = await Promise.all(readRoots.map(path => realpath(path)))
  const unique = canonical.filter((path, index) => !canonical.slice(0, index).some(other => relative(path, other) === ''))
  const roots = unique.filter(path => !unique.some(other => other !== path && within(path, other)))
  return carveWindowsReadDenies(roots, writeRoots)
}
