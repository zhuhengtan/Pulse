import { windowsSystemExecutable } from './windows-system.js'
import { ShellOutput } from './shell-output.js'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, parse, posix, resolve, sep, win32 } from 'node:path'
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { windowsPtyCommand, type WindowsPty } from './windows-pty.js'
import { windowsPtyProtocol } from './windows-pty-protocol.js'
import { SandboxManager, checkWindowsDependenciesAsync, resolveSrtWin, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { resolveWindowsPackageManager } from './windows-package-manager.js'
import { resolveHostPackageManager } from './host-package-manager.js'
import { windowsShellEnvironment } from './windows-shell-environment.js'
import { carveWindowsReadDenies, windowsReadDenyRoots, windowsToolchainWriteDenies } from './windows-read-policy.js'
import { shellSandboxManager, withWindowsSandboxLease } from './shell-sandbox.js'
import { installationDependencyRoots, workspaceUsesInstallationDependencies } from './installation-dependencies.js'
import { verifiedWindowsSrt } from './windows-srt-path.js'

export interface ShellResult { code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; aborted: boolean; outputArchive?: ReturnType<ShellOutput['finish']> }
/** Host-only injection, after sandbox wrapping and the final executable check. */
export interface ShellChild {
  readonly pid?: number | undefined
  readonly exitCode?: number | null
  readonly signalCode?: NodeJS.Signals | null
  readonly stdin?: { end(data?: string, callback?: (error?: Error | null) => void): unknown; on?(event: 'error', listener: (error: Error) => void): unknown; destroy?(): void } | null
  readonly stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  /** Set only by the Windows broker transport. Absent means the close code is the result. */
  readonly windowsPtyExit?: { framed: boolean; unknown: boolean; code?: number }
}
export type ShellSpawn = (sandboxArgv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ShellChild

export interface ShellIdentity { executable: string; prefixArgs: string[]; path: string; fingerprint: string; trusted: boolean }
/** Resolve the same host wrappers and search path used by runShell, without
 * launching the requested command or reading shell startup files. */
export async function resolveShellIdentity(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<ShellIdentity> {
  validateShellInvocation(command, args)
  cwd = await realpath(cwd)
  const node = await realpath(process.execPath)
  let executable = command, prefixArgs: string[] = []
  if (command === 'node') executable = node
  else if (process.platform === 'darwin' && command === 'git') executable = (await promisify(execFile)('/usr/bin/xcrun', ['--find', 'git'], { timeout: 5000, env: shellEnvironment(env) })).stdout.trim()
  else {
    const mapped = process.platform === 'win32' ? await resolveWindowsPackageManager(command, node, process.env.PNPM_HOME) : await resolveHostPackageManager(command, node)
    if (mapped) { executable = mapped.executable; prefixArgs = mapped.prefixArgs }
  }
  if (!isAbsolute(executable)) {
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
    const directories = [process.env.PNPM_HOME, dirname(node), join(cwd, 'node_modules', '.bin'), ...(env[pathKey] ?? '').split(delimiter)].filter((s): s is string => s !== undefined)
    const names = process.platform === 'win32' && !/\.[a-z]+$/i.test(executable) ? [executable + '.exe', executable + '.cmd', executable] : [executable]
    const candidates = /[\\/]/.test(executable) ? [resolve(cwd, executable)] : directories.flatMap(d => names.map(n => resolve(cwd, d, n)))
    let found: string | undefined
    for (const candidate of candidates) if ((await stat(candidate).catch(() => undefined))?.isFile()) { found = candidate; break }
    if (!found) throw shellError('EXEC_POLICY_PROGRAM_UNRESOLVED')
    executable = found
  }
  executable = await realpath(executable)
  const files = [executable, ...prefixArgs.filter(isAbsolute)]
  const stamps = await Promise.all(files.map(async file => {
    const path = await realpath(file), s = await stat(path)
    if (!s.isFile()) throw shellError('EXEC_POLICY_PROGRAM_UNRESOLVED')
    const stamp = { path, dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs }
    if (process.platform !== 'win32') return { ...stamp, ctime: s.ctimeMs }
    // Windows SRT updates ACLs on declared read roots. That can change ctime
    // without changing the approved program. Bind its actual bytes instead;
    // never cache by mtime alone (an in-place replacement can restore it).
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length
      if (bytes > s.size) throw shellError('EXEC_POLICY_PROGRAM_CHANGED')
      digest.update(chunk)
    }
    const after = await stat(path)
    if (bytes !== s.size || after.dev !== s.dev || after.ino !== s.ino || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) throw shellError('EXEC_POLICY_PROGRAM_CHANGED')
    return { ...stamp, sha256: digest.digest('hex') }
  }))
  const path = stamps.at(-1)!.path
  const trusted = files.every(file => file === node || /^\/(?:usr\/bin|bin|usr\/local|opt\/homebrew|Library\/Developer)\//.test(file)) && !(path === cwd || path.startsWith(cwd + sep))
  return { executable, prefixArgs, path, fingerprint: createHash('sha256').update(JSON.stringify({ stamps, prefixArgs })).digest('hex'), trusted }
}

function shellError(code: string, retryable = false, cause?: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  return Object.assign(new Error(code), { code, retryable, ...(cause === undefined ? {} : { cause }) })
}

// SandboxManager owns process-global proxy and policy state. A per-invocation
// policy is installed for exactly one child at a time to avoid one concurrent
// call widening another call's filesystem grants.
let sandboxTail: Promise<void> = Promise.resolve()
function withSandboxLease<T>(work: () => Promise<T>): Promise<T> {
  if (process.platform === 'win32') return withWindowsSandboxLease(work)
  const result = sandboxTail.then(work, work)
  sandboxTail = result.then(() => undefined, () => undefined)
  return result
}

/** Read-only prerequisite probe; never provisions accounts or changes permissions. */
export async function checkShellSandbox(): Promise<{ errors: string[]; warnings: string[] }> {
  // doctor runs before initialize(), so the manager has no Windows config yet.
  // Probe the same packaged helper used for execution without provisioning it.
  return withSandboxLease(() => process.platform === 'win32'
    ? checkWindowsDependenciesAsync({ srtWin: resolveSrtWin({ path: verifiedWindowsSrt() }) })
    : SandboxManager.checkDependenciesAsync())
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value
  let output = '"'
  let slashes = 0
  for (const character of value) {
    if (character === '\\') { slashes++; continue }
    if (character === '"') output += '\\'.repeat(slashes * 2 + 1) + '"'
    else output += '\\'.repeat(slashes) + character
    slashes = 0
  }
  return output + '\\'.repeat(slashes * 2) + '"'
}

const powershellArgvRunner = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PULSE_ARGV_JSON__'))
$spec = ConvertFrom-Json -InputObject $payload
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = [string]$spec.command
$psi.Arguments = [string]$spec.arguments
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.RedirectStandardInput = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$child = [System.Diagnostics.Process]::new()
$child.StartInfo = $psi
try { if (-not $child.Start()) { exit 127 } }
catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  [Console]::Error.WriteLine($cause.Message)
  if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in 2,3) { exit 127 }
  exit 126
}
$outTask = $child.StandardOutput.ReadToEndAsync()
$errTask = $child.StandardError.ReadToEndAsync()
$inTask = [Console]::OpenStandardInput().CopyToAsync($child.StandardInput.BaseStream)
[void]$inTask.GetAwaiter().GetResult()
$child.StandardInput.Close()
$child.WaitForExit()
try { [Console]::Out.Write([string]$outTask.GetAwaiter().GetResult()) } catch {}
try { [Console]::Error.Write([string]$errTask.GetAwaiter().GetResult()) } catch {}
exit $child.ExitCode
`.trim()

/** Build the command text expected by srt without interpreting model argv as shell syntax. */
export function encodeSandboxCommand(command: string, args: string[], platform: NodeJS.Platform = process.platform): string {
  if ([command, ...args].some((value) => value.includes('\0'))) throw shellError('INVALID_SHELL_ARGUMENT')
  if (platform === 'win32') {
    // The only bytes placed in cmd.exe's command string are fixed tokens and
    // base64. PowerShell decodes JSON and ProcessStartInfo.Arguments uses a
    // Windows CRT-compatible encoder, preserving argv without a shell parse.
    const payload = Buffer.from(JSON.stringify({ command, arguments: args.map(quoteWindowsArgument).join(' ') }), 'utf8').toString('base64')
    const encoded = Buffer.from(powershellArgvRunner.replace('__PULSE_ARGV_JSON__', payload), 'utf16le').toString('base64')
    const commandText = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
    // SRT's default inner shell is cmd.exe, whose command text limit is 8,191
    // characters; leave headroom for its fixed invocation/outer quotes.
    if (commandText.length > 8_000) throw shellError('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
    return commandText
  }
  return `exec ${[command, ...args].map(quotePosix).join(' ')}`
}

/**
 * Read-only git commands in a linked worktree need the main repository's
 * metadata: `.git/worktrees/<id>` plus the common directory (`objects`, `refs`,
 * `HEAD`). Both live outside the worktree, so the sandbox hides them and git
 * reports "not a git repository". Granting a parent directory instead would
 * expose sibling projects, and trusting the `.git` file alone would let any
 * forged file redirect the grant. Ownership is therefore proven with git's own
 * backlinks, which can only be written by a process that already holds write
 * access inside the main repository - something this sandbox never grants.
 */
async function worktreeGitMetadataRoots(cwd: string): Promise<string[]> {
  const dotGit = join(cwd, '.git')
  // `lstat` never follows the marker. A symlink pointing at another worktree's
  // `.git` file would otherwise satisfy the backlink comparison below and be
  // mistaken for ownership of that worktree's metadata.
  const dotGitStat = await lstat(dotGit).catch(() => undefined)
  // A regular repository keeps metadata inside the workspace, which is already
  // readable; a directory grant must not be widened by this helper.
  if (!dotGitStat?.isFile()) return []
  const marker = /^gitdir:[ \t]*(\S.*?)[ \t\r]*$/mu.exec(await readFile(dotGit, 'utf8').catch(() => ''))
  const declared = marker?.[1]
  if (!declared) return []
  const worktreeAdmin = await realpath(resolve(cwd, declared)).catch(() => undefined)
  if (!worktreeAdmin) return []
  const adminRoot = dirname(worktreeAdmin)
  if (basename(adminRoot) !== 'worktrees' || !basename(dirname(adminRoot)).endsWith('.git')) return []
  const commonDir = await realpath(dirname(adminRoot)).catch(() => undefined)
  if (!commonDir) return []
  // `commondir` must resolve to exactly the parent that contains the
  // `worktrees` directory, so it cannot point at an unrelated tree.
  const commondirFile = await readFile(join(worktreeAdmin, 'commondir'), 'utf8').catch(() => undefined)
  if (commondirFile === undefined) return []
  const declaredCommon = await realpath(resolve(worktreeAdmin, commondirFile.trim())).catch(() => undefined)
  if (declaredCommon !== commonDir) return []
  // Ownership proof: the admin directory records the `.git` path of the very
  // worktree being sandboxed. A forged `.git` file cannot satisfy this.
  const backlink = await readFile(join(worktreeAdmin, 'gitdir'), 'utf8').catch(() => undefined)
  const backlinkTarget = backlink === undefined
    ? undefined
    : await realpath(resolve(worktreeAdmin, backlink.trim())).catch(() => undefined)
  // cwd was resolved with realpath and the marker is a regular file, so its
  // literal path is the ownership identity. Resolving it would follow exactly
  // the symlink this helper must not trust.
  const expectedBacklink = dotGit
  if (!backlinkTarget || backlinkTarget !== expectedBacklink) return []
  const head = await stat(join(commonDir, 'HEAD')).catch(() => undefined)
  if (!head?.isFile()) return []
  // Keep the guard rails of the workspace grant: never reopen a path that is a
  // filesystem root, the home directory, or an ancestor of home, and skip
  // metadata that already sits inside the workspace.
  const root = parse(commonDir).root
  if (commonDir === root || commonDir === homedir() || homedir().startsWith(commonDir + sep)) return []
  if (commonDir === cwd || commonDir.startsWith(cwd + sep) || worktreeAdmin.startsWith(cwd + sep)) return []
  return [worktreeAdmin, commonDir]
}

// System installation directories whose `git` is not writable by the model.
// User-writable prefixes (/usr/local, /opt/homebrew) are deliberately absent:
// a shadow there is indistinguishable from an attacker-controlled binary.
const TRUSTED_GIT_DIRECTORIES = ['/usr/bin', '/bin', '/Library/Developer/CommandLineTools/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/bin']

/**
 * Read-only porcelain limited to the three subcommands this exception actually
 * needs. `config` is excluded on purpose: it prints configuration bodies, which
 * is exactly what this exception must not hand out.
 */
// Builtin names always win over aliases, so a repository alias can never be
// reached through this list; an unknown name is not on the list at all, and an
// unlisted name never receives the public `.git` reads.
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  // Only these three metadata reads are granted. Everything else is absent on
  // purpose: `cat-file --filters` and `blame` apply filter/textconv drivers taken
  // from repository config or attributes, so they would inherit this grant only
  // to start a workspace-writable program, and no other plumbing needs `.git`.
  'status', 'rev-parse', 'diff',
])

/**
 * The repository config is readable for this one invocation, so it must not be
 * able to launch anything: empty values disable the drivers, `--no-pager` and a
 * discarded `core.hooksPath` close the pager and hook paths. These flags are
 * prepended after validation, so model argv can never suppress them.
 */
const GIT_NEUTRALIZING_ARGUMENTS = [
  '--no-pager',
  '-c', 'core.fsmonitor=',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'diff.trustExitCode=false',
]

/**
 * Porcelain diff commands also apply external diff and textconv drivers named by
 * `.gitattributes`, which `-c` cannot enumerate; these flags override both.
 */
const GIT_DIFF_NEUTRALIZING_ARGUMENTS = ['--no-ext-diff', '--no-textconv']
// `log`, `show` and `whatchanged` are not granted above; only `diff` can reach
// this branch, and it must still carry the overrides against `.gitattributes`.
const GIT_TEXT_DIFF_SUBCOMMANDS = new Set(['diff'])
// Subcommands that run `filter.<name>.clean`/`process`: `status` refreshes the
// index through the clean filter, `diff` converts the worktree through it.
// `rev-parse` reads no file content and is deliberately absent, so its grant
// never depends on the enumeration below succeeding.
const GIT_FILTER_SUBCOMMANDS = new Set(['status', 'diff'])

/** Arguments that relocate the repository, inject config, or run external programs. */
const GIT_REDIRECT_ARGUMENT = /^(?:-C|--git-dir|--work-tree|--namespace|--config-env|--exec-path|--super-prefix|--no-index|--ext-diff|--textconv)(?:=|$)/

/** Environment that relocates the repository or injects configuration. */
const GIT_REDIRECT_ENVIRONMENT = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/

/**
 * Identity check for the executable that will actually run. A bare name is
 * resolved through the very PATH the child receives, so a workspace or pnpm
 * shadow wins that lookup and thereby loses the grant; an explicit path must
 * resolve into a trusted installation directory.
 */
async function trustedGitExecutable(command: string, executable: string, cwd: string, pathValue: string): Promise<string | undefined> {
  if (process.platform === 'win32' || basename(command) !== 'git') return undefined
  const trusted = (await Promise.all(TRUSTED_GIT_DIRECTORIES.map((dir) => realpath(dir).catch(() => undefined)))).filter((dir): dir is string => dir !== undefined)
  const trustedParent = async (resolved: string): Promise<string | undefined> => {
    // Follow the symlink. A trusted directory is not enough: /usr/bin/true must
    // not inherit this grant just because a PATH entry was named git.
    if (basename(resolved) !== 'git') return undefined
    const parent = await realpath(dirname(resolved)).catch(() => undefined)
    return parent && trusted.includes(parent) ? resolved : undefined
  }
  if (executable.includes('/') || executable.includes(sep)) {
    // execFile resolves a relative path against the shell cwd, not the host process cwd.
    const candidate = isAbsolute(executable) ? executable : resolve(cwd, executable)
    const resolved = await realpath(candidate).catch(() => undefined)
    return resolved ? trustedParent(resolved) : undefined
  }
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry === '' ? cwd : entry
    const resolved = await realpath(join(directory, 'git')).catch(() => undefined)
    if (!resolved) continue
    // The first hit on PATH is the binary that runs; judge only that one.
    return trustedParent(resolved)
  }
  return undefined
}

function readOnlyGitArguments(args: string[]): boolean {
  const subcommand = args[0]
  // Global options (`-c`, `-C`, `--git-dir`) may only appear before the
  // subcommand, so requiring the subcommand first rejects them outright.
  if (!subcommand || subcommand.startsWith('-')) return false
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
  // `git rev-parse --git-dir` only prints where the repository lives: it is a
  // query, not a redirect. Only the bare flag placed after the subcommand is
  // let through; `--git-dir=<path>`, a pre-subcommand `--git-dir`/`-C` and every
  // other redirect keep hitting GIT_REDIRECT_ARGUMENT below.
  if (subcommand === 'rev-parse' && args.length === 2 && args[1] === '--git-dir') return true
  // `diff` without a revision compares the worktree to the index. A revision
  // argument would read arbitrary blobs from the shared object store, including
  // history and paths that are not checked out in this worktree.
  if (subcommand === 'diff') {
    const body = args.slice(1)
    const separator = body.indexOf('--')
    const revisions = (separator === -1 ? body : body.slice(0, separator)).filter((arg) => !arg.startsWith('-'))
    if (revisions.length > 0) return false
  }
  return !args.some((arg) => GIT_REDIRECT_ARGUMENT.test(arg))
}

/**
 * `git status` refreshes the index and `git diff` converts worktree files
 * through the `filter.<name>.clean` or
 * `filter.<name>.process` command named by repository config, and neither
 * `--no-textconv` nor `--no-ext-diff` touches those drivers. The driver names are
 * enumerated through the already verified executable with `--name-only`, so only
 * key names are read: no value, and therefore no credential, is printed or
 * stored. Each key is blanked afterwards, which leaves Git with no command to
 * run for it; a driver that is `required` makes the call fail instead, which is
 * the safe outcome. `undefined` means the enumeration itself failed, and the
 * caller then drops the grant rather than hand the reads to drivers this
 * exception cannot neutralise.
 */
async function gitFilterNeutralizingArguments(cwd: string, executable: string, pathValue: string): Promise<string[] | undefined> {
  try {
    // The granted subprocess reads exactly this configuration surface, so the
    // enumeration follows it: `--includes` honours `include.path`, and dropping
    // `--local` adds the linked-worktree file that `status` and `diff` also see.
    // Global and system files stay out through the environment below, so a driver
    // defined outside the repository is never enumerated and never reachable.
    // `-z` keeps key names NUL separated, so a driver name containing a dot
    // (`filter.pulse.probe.clean`) is read whole instead of being cut in two.
    const { stdout } = await promisify(execFile)(executable, ['--no-pager', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', 'config', '--includes', '--list', '--name-only', '-z'], {
      cwd,
      timeout: 5000,
      maxBuffer: 1 << 20,
      // Only the computed PATH travels, so no inherited GIT_* variable can point
      // this read at a different repository.
      env: { PATH: pathValue, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    })
    const neutralizing: string[] = []
    for (const key of stdout.split('\0')) {
      if (key === '') continue
      // `.+` rather than `[^.]+`: a driver may legitimately be called
      // `pulse.probe`, and a key this enumeration cannot match would otherwise
      // stay live for the granted call. Anything that still looks unusable
      // drops the whole grant instead of being skipped silently.
      if (!/^filter\..+\.(?:clean|process)$/.test(key)) continue
      if (key.includes('=')) return undefined
      neutralizing.push('-c', `${key}=`)
    }
    return neutralizing
  } catch {
    return undefined
  }
}

/**
 * Public Git metadata is readable for exactly one confirmed invocation: a
 * trusted Git executable, a read-only subcommand, no argument or environment
 * that redirects the repository or spawns external programs, and a worktree
 * whose ownership backlinks check out. Anything else keeps the plain workspace
 * grants, so a forged `.git` file or a fake `git` widens nothing.
 */
interface GitMetadataApproval { roots: string[]; globalArguments: string[]; subcommandArguments: string[]; executable?: string }

async function approvedGitMetadata(cwd: string, command: string, executable: string, args: string[], env: NodeJS.ProcessEnv, pathValue: string): Promise<GitMetadataApproval> {
  const denied: GitMetadataApproval = { roots: [], globalArguments: [], subcommandArguments: [] }
  // The verified executable is kept, not just its verdict: the launch below
  // reuses this exact resolved path, so the binary that runs is the binary that
  // was checked.
  const trusted = await trustedGitExecutable(command, executable, cwd, pathValue)
  if (!trusted) return denied
  if (!readOnlyGitArguments(args)) return denied
  if (Object.keys(env).some((key) => GIT_REDIRECT_ENVIRONMENT.test(key))) return denied
  const roots = await worktreeGitMetadataRoots(cwd)
  if (roots.length === 0) return denied
  // A granted call cannot keep a driver alive that the grant just made
  // reachable, so the neutralising flags travel with the roots. Git accepts
  // `-c`/`--no-pager` only before the subcommand and `--no-ext-diff`/
  // `--no-textconv` only after it, so the two groups stay apart.
  const textDiff = GIT_TEXT_DIFF_SUBCOMMANDS.has(String(args[0]))
  const runsFilters = GIT_FILTER_SUBCOMMANDS.has(String(args[0]))
  // Convert drivers are blanked through global `-c` options, which must precede
  // the subcommand, so they join the neutralising group instead of the diff group.
  const filterArguments = runsFilters ? await gitFilterNeutralizingArguments(cwd, trusted, pathValue) : []
  if (filterArguments === undefined) return denied
  const subcommandArguments = textDiff ? [...GIT_DIFF_NEUTRALIZING_ARGUMENTS] : []
  return { roots, globalArguments: [...GIT_NEUTRALIZING_ARGUMENTS, ...filterArguments], subcommandArguments, executable: trusted }
}

/**
 * Same bounded git argv as safeCommandPrefix in exec-policy.ts. These queries
 * are neutralized even when the linked-worktree metadata grant is denied, so a
 * normal repository cannot start fsmonitor, hooks, clean/process filters,
 * external diff, textconv, or a pager. This does not add filesystem roots.
 */
function safeGitQuery(command: string, args: string[]): boolean {
  if (basename(command).toLowerCase().replace(/\.exe$/, '') !== 'git') return false
  const [sub, ...rest] = args
  if (!sub || sub.startsWith('-') || rest.length > 32) return false
  const allowed = (words: string[]) => rest.every(arg => words.includes(arg))
  if (sub === 'status') return allowed(['--short', '--branch', '--porcelain', '--porcelain=v1', '-s', '-b'])
  if (sub === 'diff') return allowed(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--no-ext-diff', '--no-textconv'])
  if (sub === 'log') {
    const bound = /^(?:-(?:[1-9]|[1-9][0-9])|--max-count=(?:[1-9]|[1-9][0-9]))$/
    return rest.some(arg => bound.test(arg)) && rest.every(arg => arg === '--oneline' || arg === '--no-decorate' || bound.test(arg))
  }
  return false
}

async function sandboxConfig(cwd: string, allowedDomains: string[] = [], toolchainRoots: string[] = [], scratch?: string, dependencyRoots: string[] = [], gitMetadataRoots: string[] = [], readOnlyWorkspace = false): Promise<SandboxRuntimeConfig> {
  // Linux invokes this trusted helper *inside* the read-restricted namespace.
  // A user-local npm install otherwise hides it together with the home directory.
  const seccompPath = process.platform === 'linux'
    ? await realpath(resolve(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime')), '..', 'vendor', 'seccomp', process.arch, 'apply-seccomp'))
    : undefined
  const home = homedir()
  const parent = dirname(cwd)
  const root = parse(cwd).root
  if (cwd === root || cwd === home || home.startsWith(cwd + sep) || parent === root) {
    throw shellError('SANDBOX_WORKSPACE_TOO_BROAD')
  }
  // Windows runs as a separate srt-sandbox account, which has no access to
  // private host-profile files without explicit grants. Stamping the entire
  // profile recursively is both redundant and very expensive (registry/cache
  // trees); carve workspace and installation dependency boundaries instead.
  const denyRead = new Set(process.platform === 'win32' ? [] : [home])
  // Close the common sibling-workspace and temporary-directory escape: deny
  // the workspace's immediate container, then re-open only this invocation's
  // cwd. Root workspaces cannot be carved this way and are rejected upstream.
  if (parent !== parse(cwd).root && parent !== cwd) denyRead.add(parent)
  if (process.platform === 'win32') for (const boundary of windowsReadDenyRoots(cwd, dependencyRoots)) denyRead.add(boundary)
  // Linked-worktree metadata arrives only for a confirmed read-only git
  // invocation (see approvedGitMetadataRoots), so no other program here gains
  // those reads and a plain git workspace keeps exactly the grants it had.
  const allowRead = [cwd, ...gitMetadataRoots, ...toolchainRoots, ...(scratch ? [scratch] : []), ...(seccompPath ? [seccompPath] : [])]
  // Reads default to the system toolchain plus this workspace. Writes are
  // limited to the workspace; srt adds only its required stdio/temp paths.
  return {
    network: { allowedDomains, deniedDomains: [], strictAllowlist: true },
    filesystem: {
      // Known dependency trees remain outside source denies. Only workspaces
      // that actually reference them need recursive Windows read grants.
      denyRead: process.platform === 'win32' ? await carveWindowsReadDenies([...denyRead], [...allowRead, ...dependencyRoots]) : [...denyRead],
      allowRead,
      allowWrite: [...(readOnlyWorkspace ? [] : [cwd]), ...(scratch ? [scratch] : [])],
      denyWrite: process.platform === 'win32' ? await windowsToolchainWriteDenies([...toolchainRoots, ...dependencyRoots], [...(readOnlyWorkspace ? [] : [cwd]), ...(scratch ? [scratch] : [])]) : [],
    },
    ...(seccompPath ? { seccomp: { applyPath: seccompPath } } : {}),
    ...(process.platform === 'win32' ? { windows: { srtWin: { path: verifiedWindowsSrt() } } } : {}),
  }
}

function cleanPath(value: string): string {
  return resolve(value)
}

export function decodeUtf8WithinByteLimit(value: Buffer, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw shellError('INVALID_SHELL_OUTPUT_LIMIT')
  const decoded = value.subarray(0, maxBytes).toString('utf8')
  let used = 0
  const output: string[] = []
  for (const character of decoded) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output.push(character)
    used += bytes
  }
  return output.join('')
}

function shellEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const source = env ?? process.env
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|BEARER|CREDENTIAL|COOKIE)/i.test(key) && key !== 'NODE_OPTIONS',
  ))
}

/** Names the sandbox itself assigns for proxy routing and TLS trust. */
const SANDBOX_RUNTIME_ENV = new Set([
  'SANDBOX_RUNTIME', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'GRPC_PROXY', 'grpc_proxy', 'FTP_PROXY', 'ftp_proxy', 'RSYNC_PROXY', 'DOCKER_HTTP_PROXY', 'DOCKER_HTTPS_PROXY',
  'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  'PIP_CERT', 'GIT_SSL_CAINFO', 'AWS_CA_BUNDLE', 'CARGO_HTTP_CAINFO', 'DENO_CERT', 'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE', 'NIX_SSL_CERT_FILE',
  'CLOUDSDK_PROXY_TYPE', 'CLOUDSDK_PROXY_ADDRESS', 'CLOUDSDK_PROXY_PORT', 'CLOUDSDK_PROXY_USERNAME', 'CLOUDSDK_PROXY_PASSWORD',
])

function sandboxRuntimeOverlay(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  if (!env) return {}
  const overlay: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !SANDBOX_RUNTIME_ENV.has(key) || process.env[key] === value) continue
    overlay[key] = value
  }
  return overlay
}

function shellLaunchesCommand(command: string, args: string[]): boolean {
  const base = basename(command).toLowerCase()
  if (!['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(base)) return false
  return args.some((arg) => /^(?:-lc|-c|-command|\/c)$/i.test(arg))
}

/** Canonical home boundary. Windows compares case-insensitively and never treats a sibling prefix as a parent. */
export function readRootTooBroad(root: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = platform === 'win32' ? win32 : posix
  const fold = (value: string) => platform === 'win32' ? api.normalize(value).toLowerCase() : api.normalize(value)
  const candidate = fold(root)
  const canonicalHome = fold(home)
  if (candidate === canonicalHome || candidate === fold(api.parse(root).root)) return true
  const rel = api.relative(candidate, canonicalHome)
  return rel === '' || (rel.length > 0 && !api.isAbsolute(rel) && !rel.split(/[/\\]/).includes('..'))
}

/** Deterministic argv validation, shared by pre-approval and actual execution. */
export function validateShellInvocation(command: string, args: string[] = []): void {
  if (!command || typeof command !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw shellError('INVALID_SHELL_ARGUMENT')
  if (/&&|\|\||[|&;<>\n`]|\$\(/.test(command) || shellLaunchesCommand(command, args)) throw Object.assign(shellError('SHELL_SYNTAX_UNSUPPORTED'), { message: 'shell.exec does not start a shell. Pass the executable in command and each argument in args. Do not put &&, pipes, redirects, command substitution, or sh -c in command.' })
  encodeSandboxCommand(command, args)
}

export function runShell(command: string, args: string[] = [], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv; allowedDomains?: string[]; outputDirectory?: string; maxArchiveBytes?: number; expectedIdentity?: ShellIdentity | undefined; beforeLaunch?: () => Promise<ShellIdentity | undefined>; onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void; spawnProcess?: ShellSpawn; windowsPty?: WindowsPty; readOnlyWorkspace?: boolean; isolatedHome?: boolean; stdioTarget?: boolean; readRoots?: string[]; stdinData?: string; sealedCallerEnv?: boolean } = {}): Promise<ShellResult> {
  if (options.stdinData !== undefined && Buffer.byteLength(options.stdinData) > 65536) return Promise.reject(shellError('SHELL_STDIN_TOO_LARGE'))
  const max = options.maxOutputBytes ?? 256 * 1024
  if (!Number.isFinite(max) || max < 0) return Promise.reject(shellError('INVALID_SHELL_OUTPUT_LIMIT'))
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) return Promise.reject(shellError('INVALID_SHELL_TIMEOUT'))
  try { validateShellInvocation(command, args) } catch (error) { return Promise.reject(error) }
  try { encodeSandboxCommand(command, args) } catch (error) { return Promise.reject(error) }

  return withSandboxLease(async () => {
    const started = Date.now()
    const checkpoint = (phase: string): void => { if (process.env.PULSE_SANDBOX_TIMING === '1') console.info(`[sandbox timing] ${Date.now() - started}ms ${phase}`) }
    if (options.signal?.aborted) return { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: true }

    let cwd: string
    try {
      cwd = await realpath(cleanPath(options.cwd ?? process.cwd()))
    } catch (cause) {
      throw shellError('INVALID_SHELL_CWD', false, cause)
    }
    // Trust only the installation hosting Pulse, never arbitrary PATH directories.
    const nodeExecutable = await realpath(process.execPath)
    const nodeBin = dirname(nodeExecutable)
    const installation = basename(nodeBin) === 'bin' ? dirname(nodeBin) : nodeBin
    const toolchainRoots = installation !== homedir() && installation !== parse(installation).root ? [installation] : [nodeExecutable]
    const homePath = await realpath(homedir()).catch(() => homedir())
    for (const raw of options.readRoots ?? []) {
      const root = await realpath(raw)
      if (readRootTooBroad(root, homePath)) throw shellError('SANDBOX_READ_ROOT_TOO_BROAD')
      toolchainRoots.push(root)
    }
    const dependencyRoots = await installationDependencyRoots()
    if (process.platform !== 'win32' || await workspaceUsesInstallationDependencies(cwd, dependencyRoots)) toolchainRoots.push(...dependencyRoots)
    let ptyBridge: string | undefined
    let windowsPty: WindowsPty | undefined
    if (process.platform === 'win32' && options.windowsPty) {
      if (!options.spawnProcess) throw shellError('WINDOWS_PTY_TRANSPORT_REQUIRED')
      // Grant only the installed bridge, the protocol file it requires, and the
      // node-pty package, each read-only. The bridge's relative require cannot
      // see a sibling that is not named here, and the adapters directory itself
      // stays closed.
      const modulePath = await realpath(options.windowsPty.modulePath)
      windowsPty = { modulePath, scope: options.windowsPty.scope }
      ptyBridge = await realpath(fileURLToPath(new URL('./windows-pty-bridge.cjs', import.meta.url)))
      const ptyProtocol = await realpath(fileURLToPath(new URL('./windows-pty-protocol.cjs', import.meta.url)))
      toolchainRoots.push(ptyBridge, ptyProtocol, dirname(dirname(modulePath)))
    }
    // The Windows broker relaunches itself as the sandbox user before starting
    // the target command. Permit only its fixed, integrity-checked image folder.
    if (process.platform === 'win32') toolchainRoots.push(dirname(verifiedWindowsSrt()))
    // PNPM_HOME is a host installation setting, never supplied by model argv.
    let pnpmHome: string | undefined
    if (process.env.PNPM_HOME) {
      try {
        const candidate = await realpath(process.env.PNPM_HOME)
        if (candidate !== homedir() && candidate !== parse(candidate).root && !homedir().startsWith(candidate + sep)) {
          pnpmHome = candidate
          toolchainRoots.push(candidate)
          // pnpm/action-setup exposes its executable shims from node_modules/.bin;
          // their targets live in the adjacent node_modules tree.
          if (basename(candidate) === '.bin') toolchainRoots.push(dirname(candidate))
        }
      } catch { /* stale installation settings do not grant access */ }
    }
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'pulse-shell-')))
    try {
    const baseEnv = shellEnvironment(options.env)
    const pathKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    // An explicit record type keeps the computed PATH key and the
    // `GIT_OPTIONAL_LOCKS` override writable without an index signature.
    // pnpm exec/run must not silently install or replace a prepared dependency tree.
    // An explicit install command remains subject to the normal approval/sandbox policy.
    const executionEnv: Record<string, string | undefined> = { pnpm_config_verify_deps_before_run: 'false', [pathKey]: [...(pnpmHome ? [pnpmHome] : []), nodeBin, join(cwd, 'node_modules', '.bin'), baseEnv[pathKey] ?? ''].join(delimiter),
      ...(process.platform === 'win32' ? {} : { HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) }
    if (process.platform === 'darwin' && !Object.keys(baseEnv).some(key => /^npm_config_script_shell$/i.test(key))) {
      // npm normally spawns "sh" through PATH, which may contain shims hidden
      // by the macOS read boundary. Use the system POSIX default while retaining
      // an explicit environment or workspace script-shell configuration.
      const npmrc = await readFile(join(cwd, '.npmrc'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : undefined)
      if (npmrc !== undefined && !/^\s*["']?script-shell["']?\s*=/im.test(npmrc)) executionEnv.npm_config_script_shell = '/bin/sh'
    }
    let executable = command
    let executableArgs = args
    if (command === 'node') executable = nodeExecutable
    if (process.platform === 'darwin' && command === 'git') {
      // /usr/bin/git is an xcrun shim that writes outside TMPDIR. Resolve the
      // installed tool through Apple's fixed locator before entering isolation.
      const located = await promisify(execFile)('/usr/bin/xcrun', ['--find', 'git'], { timeout: 5000, env: baseEnv })
      executable = located.stdout.trim()
      if (!executable.startsWith('/')) throw shellError('GIT_TOOLCHAIN_NOT_FOUND')
    }
    if (process.platform === 'win32') {
      const resolved = await resolveWindowsPackageManager(command, nodeExecutable, pnpmHome)
      if (resolved) { executable = resolved.executable; executableArgs = [...resolved.prefixArgs, ...args] }
    } else {
      const resolved = await resolveHostPackageManager(command, nodeExecutable)
      if (resolved) {
        executable = resolved.executable; executableArgs = [...resolved.prefixArgs, ...args]
        toolchainRoots.push(resolved.readRoot)
      }
    }
    if (options.expectedIdentity || process.platform === 'win32' && (options.windowsPty || options.stdioTarget)) {
      const actual = await resolveShellIdentity(command, args, cwd, baseEnv)
      if (options.expectedIdentity && actual.fingerprint !== options.expectedIdentity.fingerprint) throw shellError('EXEC_POLICY_PROGRAM_CHANGED')
      executable = actual.executable
      executableArgs = [...actual.prefixArgs, ...args]
    }
    const invocationId = randomUUID()
    const gitApproval = await approvedGitMetadata(cwd, command, executable, args, baseEnv, String(executionEnv[pathKey] ?? ''))
    // A granted call launches the path that was verified, so a `./git` or a PATH
    // entry swapped in after the check can no longer become the running binary.
    // Other ungranted calls keep their argv. Bounded git status/diff/log still
    // receive neutralizing flags, without any extra filesystem root.
    if (gitApproval.executable) executable = gitApproval.executable
    if (gitApproval.globalArguments.length > 0) {
      // Global options precede the subcommand; per-subcommand options must
      // follow it, or Git rejects them as unknown global options.
      executableArgs = [...gitApproval.globalArguments, ...executableArgs.slice(0, 1), ...gitApproval.subcommandArguments, ...executableArgs.slice(1)]
      // A status refresh would otherwise take the index lock; the grant is
      // read-only, so optional locks are switched off for this child only.
      executionEnv.GIT_OPTIONAL_LOCKS = '0'
    } else if (safeGitQuery(command, args)) {
      // Filter enumeration runs on the host, before the sandbox exists. Only a
      // verified system Git may be executed there. A workspace, relative, or
      // PATH impostor keeps the original argv and runs inside the sandbox.
      const pathValue = String(executionEnv[pathKey] ?? '')
      const trusted = await trustedGitExecutable(command, executable, cwd, pathValue)
      if (trusted) {
        const filterArguments = await gitFilterNeutralizingArguments(cwd, trusted, pathValue)
        if (filterArguments === undefined) throw shellError('GIT_HELPER_UNNEUTRALIZED')
        executable = trusted
        const subcommandArguments = args[0] === 'diff' ? [...GIT_DIFF_NEUTRALIZING_ARGUMENTS] : []
        executableArgs = [...GIT_NEUTRALIZING_ARGUMENTS, ...filterArguments, ...executableArgs.slice(0, 1), ...subcommandArguments, ...executableArgs.slice(1)]
        executionEnv.GIT_OPTIONAL_LOCKS = '0'
      }
    }
    if (options.isolatedHome) Object.assign(executionEnv, { HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_DATA_HOME: scratch, XDG_STATE_HOME: scratch })
    const policy = await sandboxConfig(cwd, options.allowedDomains ?? [], toolchainRoots, scratch, dependencyRoots, gitApproval.roots, options.readOnlyWorkspace === true)
    let child: ShellChild | undefined
    const archive = new ShellOutput(max, options.outputDirectory, options.maxArchiveBytes, options.outputDirectory !== undefined)
    const outputBytes = { stdout: 0, stderr: 0 }
    let truncated = false
    let closed = false
    let termination: 'timeout' | 'aborted' | undefined
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    // Only the broker started by this call. Cleared once that process exits so a
    // recycled Windows PID cannot be taskkilled later.
    let brokerPid: number | undefined
    const windowsBrokerLive = (): boolean => {
      if (!brokerPid || brokerPid !== child?.pid) return false
      if (child.exitCode != null || child.signalCode != null) { brokerPid = undefined; return false }
      return true
    }

    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (!child?.pid) return
      if (process.platform !== 'win32') {
        // A failed negative-PGID signal used to fall through into the Windows
        // broker check. brokerPid is only set on win32, so that path returned
        // without killing the child.
        try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
        return
      }
      if (!windowsBrokerLive()) return
      const pid = brokerPid
      const taskkill = windowsSystemExecutable('taskkill.exe')
      if (!taskkill) { if (windowsBrokerLive()) child?.kill(signal); return }
      const tree = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: win32.dirname(taskkill), env: shellEnvironment(options.env) })
      tree.once('error', () => { if (pid === brokerPid && windowsBrokerLive()) child?.kill(signal) })
      tree.unref()
    }
    const terminate = (reason: 'timeout' | 'aborted'): void => {
      if (closed) return
      termination ??= reason
      signalProcessGroup('SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => { if (!closed) signalProcessGroup('SIGKILL') }, 250)
    }
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      options.onOutput?.(target, chunk)
      archive.append(target, chunk)
      outputBytes[target] += chunk.byteLength
      if (outputBytes[target] > max) truncated = true
    }
    const outputText = (target: 'stdout' | 'stderr'): string => {
      return decodeUtf8WithinByteLimit(Buffer.from(archive.text(target)), max)
    }

    const manager = shellSandboxManager()
    checkpoint('policy ready')
    let setupStage = 'reset'
    try {
      // reset first in case an earlier initialize failed part-way through.
      await manager.reset()
      checkpoint('reset complete')
      setupStage = 'initialize'
      await manager.initialize(policy, options.signal)
      checkpoint('initialized')
      const commandText = encodeSandboxCommand(executable, executableArgs)
      setupStage = 'wrap'
      const descriptor = await manager.wrap(commandText, options.signal, cwd, { commandId: invocationId, commandText: 'shell.exec' })
      const generated = options.sealedCallerEnv ? sandboxRuntimeOverlay(descriptor.env) : undefined
      let sandboxArgv = process.platform === 'win32' ? windowsShellEnvironment(descriptor.argv, generated ? { ...generated, ...executionEnv } : executionEnv) : descriptor.argv
      if (process.platform === 'win32' && options.stdioTarget) {
        const separator = sandboxArgv.indexOf('--')
        if (separator < 2 || separator + 1 >= sandboxArgv.length) throw shellError('INVALID_WINDOWS_SANDBOX_COMMAND')
        sandboxArgv = [...sandboxArgv.slice(0, separator + 1), executable, ...executableArgs]
      }
      if (ptyBridge && windowsPty) sandboxArgv = windowsPtyCommand(sandboxArgv, nodeExecutable, ptyBridge, windowsPty, executable, executableArgs)
      checkpoint('wrapped')
      if (options.signal?.aborted) {
        await manager.cleanup()
        await manager.reset()
        return { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: true }
      }
      // A call can wait for the process-global sandbox lease. Re-evaluate
      // policy and executable identity after that wait, immediately before IO.
      setupStage = 'identity'
      const launchIdentity = options.beforeLaunch ? await options.beforeLaunch() : options.expectedIdentity
      if (launchIdentity) {
        const fresh = await resolveShellIdentity(command, args, cwd, baseEnv)
        if (fresh.fingerprint !== launchIdentity.fingerprint || fresh.executable !== executable || JSON.stringify(fresh.prefixArgs) !== JSON.stringify(options.expectedIdentity?.prefixArgs ?? fresh.prefixArgs)) throw shellError('EXEC_POLICY_PROGRAM_CHANGED')
      }
      // Cancellation during beforeLaunch or the identity read must not start a broker.
      if (options.signal?.aborted) {
        await manager.cleanup()
        await manager.reset()
        return { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: true }
      }
      // sealedCallerEnv keeps the caller's allow-list and sandbox-added proxy
      // settings. descriptor.env on macOS/Linux is the host environment and must
      // not be copied back into a hook child. Ordinary shells keep that merge.
      const launchOptions = { cwd, env: options.sealedCallerEnv ? { ...baseEnv, ...generated, ...executionEnv } : { ...baseEnv, ...shellEnvironment(descriptor.env), ...executionEnv } }
      setupStage = 'launch'
      child = options.spawnProcess ? options.spawnProcess(sandboxArgv, launchOptions) : spawn(sandboxArgv[0]!, sandboxArgv.slice(1), {
        cwd,
        env: launchOptions.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      if (process.platform === 'win32') brokerPid = child.pid
    } catch (cause) {
      let resetFailed = false
      try { await manager.reset() } catch { resetFailed = true /* preserve the setup failure */ }
      if (options.signal?.aborted && !resetFailed) return { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: true }
      // Persist only classified diagnostics, never raw subprocess output or credentials.
      const message = cause instanceof Error ? cause.message : ''
      const nativeCode = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      const policyFailure = /^EXEC_POLICY_(?:PROGRAM_CHANGED|PROGRAM_UNRESOLVED|APPROVAL_CHANGED|PROMPT|FORBIDDEN)$/.test(nativeCode)
      const reason = policyFailure ? nativeCode : /windows-install|not provisioned/i.test(message) ? 'WINDOWS_SANDBOX_NOT_PROVISIONED'
        : ['ENOENT', 'EACCES', 'EPERM'].includes(nativeCode) ? nativeCode : 'SANDBOX_INITIALIZATION_ERROR'
      throw Object.assign(shellError('SANDBOX_SETUP_FAILED', false, cause), {
        message: `SANDBOX_SETUP_FAILED (${setupStage}: ${reason})`,
        details: { platform: process.platform, stage: setupStage, reason },
      })
    }

    // A payload write is part of this owned child. Early close used to emit an
    // uncaught EPIPE and kill the host; exit 0 with valid stdout is not delivery.
    let stdinFailed = false
    let stdinReleased = options.stdinData === undefined || !child!.stdin
    let releaseStdin = (): void => { stdinReleased = true }
    const stdinDone = stdinReleased ? Promise.resolve() : new Promise<void>(resolve => { releaseStdin = () => { if (stdinReleased) return; stdinReleased = true; resolve() } })
    const stdin = child!.stdin
    if (stdin) {
      const fail = (failed: boolean): void => {
        if (failed && options.stdinData !== undefined) stdinFailed = true
        releaseStdin()
      }
      stdin.on?.('error', () => fail(options.stdinData !== undefined))
      try {
        if (options.stdinData !== undefined) stdin.end(options.stdinData, error => fail(Boolean(error)))
        else stdin.end()
      } catch { fail(options.stdinData !== undefined) }
    }

    return await new Promise<ShellResult>((resolve, reject) => {
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        options.signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => terminate('aborted')
      timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => terminate('timeout'), options.timeoutMs) : undefined
      if (options.signal) options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      child!.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
      child!.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
      child!.once('error', (cause) => {
        brokerPid = undefined
        closed = true
        cleanup()
        const errorCode = cause && typeof cause === 'object' ? (cause as unknown as { code?: unknown }).code : undefined
        const code = typeof errorCode === 'string' ? errorCode : 'SHELL_EXECUTION_ERROR'
        archive.finish()
        reject(shellError(code === 'ENOENT' || code === 'EACCES' ? code : 'SHELL_EXECUTION_ERROR', false, cause))
      })
      child!.once('close', (code) => {
        checkpoint('child closed')
        brokerPid = undefined
        closed = true
        cleanup()
        if (!stdinReleased && options.stdinData !== undefined) {
          child!.stdin?.destroy?.()
          stdinFailed = true
          releaseStdin()
        }
        void stdinDone.then(async () => {
        const tracked = child!.windowsPtyExit
        const exitCode = tracked?.code
        const framedCode = tracked?.framed === true && tracked.unknown === false && windowsPtyProtocol.isWindowsExitCode(exitCode) ? exitCode : undefined
        if (tracked && !termination && framedCode === undefined) {
          archive.finish()
          reject(shellError('AGENT_PTY_EXIT_UNKNOWN'))
          return
        }
        // Target exit 0 is success only together with broker exit 0. ?? would
        // hide a broker failure because 0 is not nullish. A missing broker
        // status is not a confirmed success.
        let reported: number | null = framedCode ?? code
        if (tracked && !termination && framedCode === 0 && code !== 0) {
          if (typeof code !== 'number') {
            archive.finish()
            reject(shellError('AGENT_PTY_EXIT_UNKNOWN'))
            return
          }
          reported = code
        }
        const stdout = outputText('stdout')
        const stderr = outputText('stderr')
        const annotated = await manager.annotate(invocationId, stderr)
        const boundedStderr = decodeUtf8WithinByteLimit(Buffer.from(annotated, 'utf8'), max)
        const outputWasTruncated = truncated || Buffer.byteLength(annotated, 'utf8') > max
        if (options.stdinData !== undefined && stdinFailed && !termination) {
          archive.finish()
          reject(shellError('SHELL_STDIN_DELIVERY_UNKNOWN'))
          return
        }
        resolve({ code: reported, stdout, stderr: boundedStderr, truncated: outputWasTruncated, timedOut: termination === 'timeout', aborted: termination === 'aborted', outputArchive: archive.finish() })
        }).catch(cause => { archive.finish(); reject(shellError('SANDBOX_RESULT_FAILED', false, cause)) })
      })
    }).finally(async () => {
      checkpoint('cleanup start')
      try {
        await manager.cleanup()
        await manager.reset()
        checkpoint('cleanup complete')
      } catch (cause) {
        // A teardown failure must be visible and fail closed for the next call.
        throw shellError('SANDBOX_CLEANUP_FAILED', false, cause)
      }
    })
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
}
