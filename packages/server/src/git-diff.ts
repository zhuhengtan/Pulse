import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { within } from './security.js'
const exec = promisify(execFile)
const options = { timeout: 8_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const }
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames']

/** Resolve the nearest existing ancestor as deleted files may have no parent directory left. */
async function checkedPath(root: string, path: string) {
  if (!path || path.includes('\0') || path.length > 4096) throw new Error('INVALID_DIFF_PATH')
  const absolute = resolve(root, path), rel = relative(resolve(root), absolute)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  let ancestor = absolute
  for (;;) {
    try { await within(root, ancestor); break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor) }
  }
  return rel.split(sep).join('/')
}

export async function readGitDiff(root: string, path?: string, staged = false) {
  const target = path ? await checkedPath(root, path) : undefined
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }
  const run = (args: string[]) => exec('git', ['-c', 'core.quotepath=false', ...args], { ...options, cwd: root, env })
  let diff = (await run(['diff', ...diffOptions, ...(staged ? ['--cached'] : []), '--', ...(target ? [target] : [])])).stdout
  // git diff does not include untracked additions; compare only the explicitly selected file.
  if (!diff && target && !staged) {
    let tracked = true
    try { await run(['ls-files', '--error-unmatch', '--', target]) }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; tracked = false }
    if (!tracked) {
      const info = await lstat(resolve(root, target))
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error('FILE_REQUIRED')
      try { diff = (await run(['diff', ...diffOptions, '--no-index', '--', '/dev/null', target])).stdout }
      catch (error) {
        if ((error as { code?: number }).code !== 1) throw error
        diff = String((error as { stdout?: string }).stdout ?? '')
      }
    }
  }
  return { diff, ...(target ? { path: target } : {}), basis: staged ? 'index' as const : 'worktree' as const }
}
