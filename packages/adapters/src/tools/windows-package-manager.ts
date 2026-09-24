import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Resolve trusted installations without executing .cmd shims or fetching via Corepack first. */
export async function resolveWindowsPackageManager(command: string, nodeExecutable: string, pnpmHome?: string): Promise<{ executable: string; prefixArgs: string[] } | undefined> {
  if (!['npm', 'npx', 'pnpm', 'pnpx', 'corepack'].includes(command)) return undefined
  const nodeBin = dirname(nodeExecutable)
  const candidates: Array<{ path: string; native?: boolean; dlx?: boolean }> = []
  if (command === 'pnpm' || command === 'pnpx') {
    // pnpm 11+ ships a native executable and an .mjs wrapper; older versions use .cjs.
    // action-setup installs its package next to PNPM_HOME (.bin).
    const roots = [...(pnpmHome ? [pnpmHome, join(dirname(pnpmHome), 'pnpm')] : []), join(nodeBin, 'node_modules', 'pnpm')]
    for (const root of roots) {
      candidates.push(
        { path: join(root, 'pnpm.exe'), native: true, dlx: command === 'pnpx' },
        { path: join(root, 'bin', `${command}.mjs`) },
        { path: join(root, 'bin', 'pnpm.cjs'), dlx: command === 'pnpx' },
      )
    }
  } else {
    candidates.push({ path: join(nodeBin, 'node_modules', command === 'corepack' ? 'corepack/dist/corepack.js' : `npm/bin/${command}-cli.js`) })
  }
  candidates.push({ path: join(nodeBin, 'node_modules', 'corepack', 'dist', `${command}.js`) })
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate.path)
      if (!(await stat(path)).isFile()) continue
      return { executable: candidate.native ? path : nodeExecutable, prefixArgs: [...(candidate.native ? [] : [path]), ...(candidate.dlx ? ['dlx'] : [])] }
    } catch { /* Missing installations fall through to the next trusted candidate. */ }
  }
  return undefined
}
