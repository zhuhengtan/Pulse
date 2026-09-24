import { readdir } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'

function within(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Keep denied subtrees off the ancestors Git must stat to reach an allowed workspace. */
export async function carveWindowsReadDenies(denied: string[], allowed: string[]): Promise<string[]> {
  const result = new Set<string>()
  const visited = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    if (visited.has(path) || allowed.some(root => within(path, root))) return
    visited.add(path)
    if (!allowed.some(root => within(root, path))) { result.add(path); return }
    // Windows inherited DENY ACEs are not POSIX allow-within-deny rules.
    // Deny siblings along the allowed path, keeping only ancestor metadata
    // accessible. An enumeration failure aborts setup rather than dropping a deny.
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  for (const path of denied) await visit(path)
  return [...result]
}
