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
async function carveWindowsDenies(denied: string[], allowed: string[], sealAncestors: boolean): Promise<string[]> {
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
    // Ancestors must reject creation even when their own DACL has an explicit
    // Users write grant or disables inheritance. Descendant grants stay intact.
    if (sealAncestors) result.add(path)
    // Retain direct denies on existing siblings along the allowed path.
    // Read boundaries leave ancestor metadata accessible; write boundaries
    // seal ancestors too. Enumeration failure aborts rather than dropping a deny.
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  for (const path of denied) await visit(path)
  return [...result]
}

export function carveWindowsReadDenies(denied: string[], allowed: string[]): Promise<string[]> {
  return carveWindowsDenies(denied, allowed, false)
}

/** Read grants are additive; inherited Users/Everyone write rights need a deny.
 * Unlike read-boundary carving, keep read-only ancestors themselves denied:
 * enumerating existing siblings leaves new files/directories writable there.
 * SRT grants the writable descendant an explicit Modify ACE. Windows orders
 * that (and its nearer inherited grants) before the ancestor's inherited deny.
 * Retain explicit sibling denies too: an existing sibling can have its own
 * Users write ALLOW or protected DACL, which an inherited deny cannot seal.
 * A read root at/below a write root must not receive an explicit deny, however.
 */
export async function windowsToolchainWriteDenies(readRoots: string[], writeRoots: string[]): Promise<string[]> {
  const canonical = await Promise.all(readRoots.map(path => realpath(path)))
  const unique = canonical.filter((path, index) => !canonical.slice(0, index).some(other => relative(path, other) === ''))
  const roots = unique.filter(path => !unique.some(other => other !== path && within(path, other)))
  return carveWindowsDenies(roots, writeRoots, true)
}
