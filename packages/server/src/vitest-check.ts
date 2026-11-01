import { posix } from 'node:path'

const portable = (value: string) => value.replaceAll('\\', '/')
const executable = (value: string) => posix.basename(portable(value)).replace(/\.(?:exe|cmd|bat)$/, '')

/** Recognize the installed runner, never a filename merely passed as script data. */
export function nodeVitestScript(script: string): boolean {
  return /(?:^|\/)node_modules\/vitest\/vitest\.mjs$/.test(portable(script))
}

/** Conservative equivalence for an explicit, unfiltered run of the same Vitest
 * files in the same project. Different filters/configs and package scripts are
 * deliberately not guessed equivalent. Inputs use receipt-relative paths. */
export function namedVitestCheck(command: string, args: readonly string[], cwd = '.'):
  { key: string; root: string; files: string[] } | undefined {
  let argv = [...args]
  const program = executable(command)
  if (program === 'node' || program === 'nodejs') {
    if (!argv[0] || !nodeVitestScript(argv[0])) return undefined
    argv.shift()
  } else if (['pnpm', 'npm', 'yarn', 'bun'].includes(program)) {
    if (argv[0] === 'exec') argv.shift()
    if (argv[0] === '--') argv.shift()
    if (argv.shift() !== 'vitest') return undefined
  } else if (program !== 'vitest') return undefined
  if (argv.shift() !== 'run') return undefined
  let root = '.', config: string | undefined
  const targets: string[] = []
  let rootSeen = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--root' || arg === '--config') {
      const value = argv[++index]
      if (!value || value.startsWith('-')) return undefined
      if (arg === '--root') { if (rootSeen) return undefined; rootSeen = true; root = value }
      else { if (config !== undefined) return undefined; config = value }
    } else if (!arg.startsWith('-') && !/[*?\[\]{}]/.test(arg) && /\.(?:[cm]?[jt]sx?)$/.test(arg)) targets.push(arg)
    else return undefined
  }
  if (!targets.length) return undefined
  if ([cwd, root, ...(config ? [config] : []), ...targets].some(path => posix.isAbsolute(portable(path)) || /^[A-Za-z]:/.test(path))) return undefined
  const project = posix.normalize(posix.join(portable(cwd), portable(root)))
  const files = [...new Set(targets.map(path => posix.normalize(posix.join(project, portable(path)))))].sort()
  return { root: project, files, key: JSON.stringify(['vitest', project, config === undefined ? null : posix.normalize(posix.join(portable(cwd), portable(config))), files]) }
}
