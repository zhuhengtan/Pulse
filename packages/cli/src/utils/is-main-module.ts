import { realpathSync } from 'node:fs'
import { resolve, win32 } from 'node:path'

/** Compare resolved entrypoints, following package-manager shims and filesystem symlinks. */
export function isSameModulePath(
  executablePath: string,
  modulePath: string,
  platform = process.platform,
): boolean {
  const resolvePath = platform === 'win32' ? win32.resolve : resolve
  const canonicalize = (path: string) => {
    const resolved = resolvePath(path)
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }
  const executable = canonicalize(executablePath)
  const module = canonicalize(modulePath)

  return platform === 'win32'
    ? executable.toLowerCase() === module.toLowerCase()
    : executable === module
}
