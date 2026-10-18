import { constants } from 'node:fs'
import { cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Copy local installed dependencies without hard links, downloads or lifecycle scripts. */
export async function prepareWorkspaceDependencies(projectRoot: string, worktreeRoot: string, packagePaths: string[]): Promise<void> {
  projectRoot = await realpath(projectRoot)
  worktreeRoot = await realpath(worktreeRoot)
  const trees = new Set(['node_modules'])
  for (const packagePath of packagePaths) {
    const folder = dirname(packagePath)
    trees.add(join(folder, 'node_modules'))
    const manifestPath = resolve(projectRoot, packagePath)
    if (!inside(projectRoot, manifestPath) || !inside(projectRoot, await realpath(manifestPath))) throw new Error('DEPENDENCY_PATH_INVALID')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const outputs = (value: unknown): string[] => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(outputs) : []
    for (const output of outputs([manifest.main, manifest.module, manifest.types, manifest.exports])) {
      const path = output.replace(/^\.\//, '')
      const top = path.split('/')[0]
      if (!top || !['dist', 'lib', 'build', 'out'].includes(top) || !path.includes('/')) continue
      trees.add(join(folder, top))
    }
  }
  for (const tree of trees) {
    const source = resolve(projectRoot, tree)
    const target = resolve(worktreeRoot, tree)
    if (!inside(projectRoot, source) || !inside(worktreeRoot, target)) throw new Error('DEPENDENCY_PATH_INVALID')
    const installed = await lstat(source).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!installed) continue
    if (installed.isSymbolicLink() || !installed.isDirectory()) throw new Error('DEPENDENCY_ROOT_MUST_BE_LOCAL_DIRECTORY')
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('DEPENDENCY_ROOT_MUST_BE_LOCAL_DIRECTORY')
      continue
    }
    const temporary = `${target}.pulse-${randomUUID()}`
    const relocated: Array<{ path: string; target: string; directory: boolean }> = []
    await mkdir(dirname(target), { recursive: true })
    try {
      await cp(source, temporary, {
        recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
        filter: async path => {
          if ((await lstat(path)).isSymbolicLink()) {
            const link = await readlink(path)
            // Relative internal links relocate with the project. Windows
            // junctions and absolute local links need explicit relocation.
            const resolved = resolve(dirname(path), link)
            if (!isAbsolute(link) && !inside(projectRoot, resolved)) throw new Error('DEPENDENCY_LINK_OUTSIDE_WORKSPACE')
            const canonical = await realpath(path).catch(error => { if (error.code === 'ENOENT') return resolved; throw error })
            if (!inside(projectRoot, canonical)) throw new Error('DEPENDENCY_LINK_OUTSIDE_WORKSPACE')
            if (isAbsolute(link)) relocated.push({ path: relative(source, path), target: resolve(worktreeRoot, relative(projectRoot, canonical)), directory: (await stat(path)).isDirectory() })
          }
          return true
        },
      })
      for (const link of relocated) {
        const path = resolve(temporary, link.path)
        await rm(path, { force: true })
        await symlink(process.platform === 'win32' ? link.target : relative(dirname(resolve(target, link.path)), link.target), path, process.platform === 'win32' && link.directory ? 'junction' : undefined)
      }
      await rename(temporary, target)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
