import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

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
