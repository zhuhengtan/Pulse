import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, delimiter, dirname, join, win32 } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Same installation directories as TRUSTED_GIT_DIRECTORIES in adapters shell.ts.
// The first PATH hit is the binary that would run; an untrusted hit is not executed.
const TRUSTED_GIT_DIRECTORIES = ['/usr/bin', '/bin', '/Library/Developer/CommandLineTools/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/bin']

const READS = [
  ['rev-parse', '--show-toplevel'],
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
]

const unavailable = () => Object.assign(new Error('system git unavailable'), { code: 'ENOENT' })

export interface SystemGitExecOptions {
  cwd: string
  timeout: number
  maxBuffer?: number
  windowsHide: true
  encoding: 'utf8'
  env: NodeJS.ProcessEnv
}

/** Injected identity and process boundary. Production uses the real filesystem and execFile. */
export interface SystemGitIO {
  platform: NodeJS.Platform
  pathValue: string
  systemRoot?: string
  pathext?: string
  realpath(path: string): Promise<string | undefined>
  exec(file: string, args: readonly string[], options: SystemGitExecOptions): Promise<{ stdout: string }>
}

function allowed(args: readonly string[]): boolean {
  return READS.some(pattern => pattern.length === args.length && pattern.every((part, index) => part === args[index]))
}

function windowsSame(a: string, b: string): boolean {
  const normalize = (value: string) => win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

/** Default Git for Windows locations. A custom or user-writable install is not added here. */
function windowsTrustedDirectories(systemRoot: string | undefined): string[] {
  const drives = new Set<string>(['C'])
  const drive = /^([A-Za-z]):\\Windows$/i.exec(systemRoot ?? '')?.[1]
  if (drive) drives.add(drive.toUpperCase())
  const suffixes = [['Git', 'cmd'], ['Git', 'bin'], ['Git', 'mingw64', 'bin'], ['Git', 'mingw32', 'bin']]
  const directories: string[] = []
  for (const letter of drives) for (const root of ['Program Files', 'Program Files (x86)']) for (const suffix of suffixes) directories.push(win32.join(`${letter}:\\`, root, ...suffix))
  return directories
}

function windowsCandidateNames(pathext: string | undefined): string[] {
  const source = pathext?.trim() ? pathext : '.COM;.EXE;.BAT;.CMD'
  const names: string[] = []
  for (const ext of source.split(';')) {
    const trimmed = ext.trim()
    if (!trimmed || trimmed === '.') continue
    const suffix = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    const name = `git${suffix}`
    if (!names.some(item => item.toLowerCase() === name.toLowerCase())) names.push(name)
    if (names.length >= 16) break
  }
  return names.length ? names : ['git.exe']
}

async function trustedUnixGit(io: SystemGitIO, cwd: string): Promise<string | undefined> {
  const trusted = (await Promise.all(TRUSTED_GIT_DIRECTORIES.map(dir => io.realpath(dir)))).filter((dir): dir is string => dir !== undefined)
  const trustedParent = async (resolved: string): Promise<string | undefined> => {
    // The PATH name can be `git` while the canonical file is another program
    // in the same trusted directory, such as /usr/bin/true.
    if (basename(resolved) !== 'git') return undefined
    const parent = await io.realpath(dirname(resolved))
    return parent && trusted.includes(parent) ? resolved : undefined
  }
  for (const entry of io.pathValue.split(delimiter)) {
    const directory = entry === '' ? cwd : entry
    const resolved = await io.realpath(join(directory, 'git'))
    if (!resolved) continue
    return trustedParent(resolved)
  }
  return undefined
}

async function trustedWindowsGit(io: SystemGitIO, cwd: string): Promise<string | undefined> {
  const trusted = (await Promise.all(windowsTrustedDirectories(io.systemRoot).map(dir => io.realpath(dir)))).filter((dir): dir is string => dir !== undefined)
  for (const entry of io.pathValue.split(';')) {
    const directory = entry === '' ? cwd : entry
    for (const name of windowsCandidateNames(io.pathext)) {
      const resolved = await io.realpath(win32.join(directory, name))
      if (!resolved) continue
      // PATHEXT order decides the first file Windows would run. Only git.exe
      // inside a known system install may continue; anything else stops the search.
      if (win32.basename(resolved).toLowerCase() !== 'git.exe') return undefined
      const parent = await io.realpath(win32.dirname(resolved))
      if (!parent || !trusted.some(dir => windowsSame(dir, parent))) return undefined
      return resolved
    }
  }
  return undefined
}

function neutralizing(platform: NodeJS.Platform): string[] {
  const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null'
  return ['--no-pager', '-c', 'core.fsmonitor=', '-c', `core.hooksPath=${nullDevice}`, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'diff.trustExitCode=false']
}

async function filterArguments(io: SystemGitIO, cwd: string, executable: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string[]> {
  const nullDevice = io.platform === 'win32' ? 'NUL' : '/dev/null'
  const { stdout } = await io.exec(executable, ['--no-pager', '-c', 'core.fsmonitor=', '-c', `core.hooksPath=${nullDevice}`, '-c', 'core.pager=cat', 'config', '--includes', '--list', '--name-only', '-z'], {
    cwd, timeout, maxBuffer: 1 << 20, windowsHide: true, encoding: 'utf8', env,
  })
  const blanked: string[] = []
  for (const key of stdout.split('\0')) {
    if (key === '') continue
    if (!/^filter\..+\.(?:clean|process)$/.test(key)) continue
    if (key.includes('=')) throw Object.assign(new Error('GIT_HELPER_UNNEUTRALIZED'), { code: 'GIT_HELPER_UNNEUTRALIZED' })
    blanked.push('-c', `${key}=`)
  }
  return blanked
}

/** Fixed host inventory reads. Anything else, including a PATH impostor, is not executed. */
export async function readOnlySystemGitUsing(io: SystemGitIO, cwd: string, args: readonly string[], options: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  if (!allowed(args)) throw unavailable()
  const executable = io.platform === 'win32' ? await trustedWindowsGit(io, cwd) : await trustedUnixGit(io, cwd)
  if (!executable) throw unavailable()
  const nullDevice = io.platform === 'win32' ? 'NUL' : '/dev/null'
  const env = { PATH: io.pathValue, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
  const filters = await filterArguments(io, cwd, executable, env, options.timeout)
  const execOptions: SystemGitExecOptions = { cwd, timeout: options.timeout, windowsHide: true, encoding: 'utf8', env }
  if (options.maxBuffer !== undefined) execOptions.maxBuffer = options.maxBuffer
  return io.exec(executable, [...neutralizing(io.platform), ...filters, ...args], execOptions)
}

export function readOnlySystemGit(cwd: string, args: readonly string[], options: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  const io: SystemGitIO = {
    platform: process.platform,
    pathValue: process.env.PATH ?? '',
    realpath: path => realpath(path).catch(() => undefined),
    exec: (file, execArgs, execOptions) => exec(file, [...execArgs], execOptions),
  }
  if (process.env.SystemRoot !== undefined) io.systemRoot = process.env.SystemRoot
  if (process.env.PATHEXT !== undefined) io.pathext = process.env.PATHEXT
  return readOnlySystemGitUsing(io, cwd, args, options)
}
