import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, parse } from 'node:path'

/** Resolve only a package manager already installed on the host's PATH.
 * The sandbox receives its package directory, never the enclosing home/NVM tree.
 * No shell startup files, Corepack download, or model-supplied PATH is used.
 */
export async function resolveHostPackageManager(command: string, node: string, hostPath = process.env.PATH ?? ''): Promise<{ executable: string; prefixArgs: string[]; readRoot: string } | undefined> {
  if (!['npm', 'npx', 'pnpm', 'pnpx'].includes(command)) return undefined
  for (const directory of hostPath.split(delimiter).filter(isAbsolute)) {
    const target = await realpath(join(directory, command)).catch(() => undefined)
    if (!target || !(await stat(target).catch(() => undefined))?.isFile()) continue
    // Stop at the first PATH hit. Never skip an unknown shim to run a different installation.
    let root = dirname(target)
    for (let depth = 0; depth < 3 && root !== homedir() && root !== parse(root).root; depth++, root = dirname(root)) {
      const manifest = await readFile(join(root, 'package.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
      const expected = command.startsWith('pn') ? 'pnpm' : 'npm'
      if (manifest?.name !== expected) continue
      const entry = typeof manifest.bin === 'object' ? manifest.bin[command] : undefined
      if (typeof entry !== 'string' || await realpath(join(root, entry)).catch(() => undefined) !== target) return undefined
      const script = /\.(?:[cm]?js)$/.test(target)
      return { executable: script ? node : target, prefixArgs: script ? [target] : [], readRoot: root }
    }
    return undefined
  }
  return undefined
}
