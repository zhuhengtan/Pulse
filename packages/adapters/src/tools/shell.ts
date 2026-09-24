import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, parse, resolve, sep } from 'node:path'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SandboxManager, VENDORED_SRT_WIN_EXE, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

export interface ShellResult { code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; aborted: boolean }

function shellError(code: string, retryable = false, cause?: unknown): Error & { code: string; retryable: boolean; cause?: unknown } {
  return Object.assign(new Error(code), { code, retryable, ...(cause === undefined ? {} : { cause }) })
}

// SandboxManager owns process-global proxy and policy state. A per-invocation
// policy is installed for exactly one child at a time to avoid one concurrent
// call widening another call's filesystem grants.
let sandboxTail: Promise<void> = Promise.resolve()
function withSandboxLease<T>(work: () => Promise<T>): Promise<T> {
  const result = sandboxTail.then(work, work)
  sandboxTail = result.then(() => undefined, () => undefined)
  return result
}

/** Read-only prerequisite probe; never provisions accounts or changes permissions. */
export async function checkShellSandbox(): Promise<{ errors: string[]; warnings: string[] }> {
  return withSandboxLease(() => SandboxManager.checkDependenciesAsync())
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
    if (commandText.length > 24_000) throw shellError('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
    return commandText
  }
  return `exec ${[command, ...args].map(quotePosix).join(' ')}`
}

async function sandboxConfig(cwd: string, allowedDomains: string[] = [], toolchainRoots: string[] = [], scratch?: string): Promise<SandboxRuntimeConfig> {
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
  const denyRead = new Set([home])
  // Close the common sibling-workspace and temporary-directory escape: deny
  // the workspace's immediate container, then re-open only this invocation's
  // cwd. Root workspaces cannot be carved this way and are rejected upstream.
  if (parent !== parse(cwd).root && parent !== cwd) denyRead.add(parent)
  // Reads default to the system toolchain plus this workspace. Writes are
  // limited to the workspace; srt adds only its required stdio/temp paths.
  return {
    network: { allowedDomains, deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: [...denyRead],
      allowRead: [cwd, ...toolchainRoots, ...(scratch ? [scratch] : []), ...(seccompPath ? [seccompPath] : [])],
      allowWrite: [cwd, ...(scratch ? [scratch] : [])],
      denyWrite: [],
    },
    ...(seccompPath ? { seccomp: { applyPath: seccompPath } } : {}),
    ...(process.platform === 'win32' ? { windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } } } : {}),
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

export function runShell(command: string, args: string[] = [], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv; allowedDomains?: string[] } = {}): Promise<ShellResult> {
  const max = options.maxOutputBytes ?? 256 * 1024
  if (!Number.isFinite(max) || max < 0) return Promise.reject(shellError('INVALID_SHELL_OUTPUT_LIMIT'))
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) return Promise.reject(shellError('INVALID_SHELL_TIMEOUT'))
  if (!command || typeof command !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return Promise.reject(shellError('INVALID_SHELL_ARGUMENT'))
  try { encodeSandboxCommand(command, args) } catch (error) { return Promise.reject(error) }

  return withSandboxLease(async () => {
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
    const executionEnv = { [pathKey]: [...(pnpmHome ? [pnpmHome] : []), nodeBin, join(cwd, 'node_modules', '.bin'), baseEnv[pathKey] ?? ''].join(delimiter),
      ...(process.platform === 'win32' ? {} : { HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) }
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
    if (process.platform === 'win32' && ['npm', 'npx', 'pnpm', 'pnpx', 'corepack'].includes(command)) {
      const entry = command === 'npm' || command === 'npx' ? `npm/bin/${command}-cli.js` : command === 'corepack' ? 'corepack/dist/corepack.js' : 'pnpm/bin/pnpm.cjs'
      for (const candidate of [join(nodeBin, 'node_modules', entry), join(nodeBin, 'node_modules', 'corepack', 'dist', `${command}.js`)]) {
        try { const script = await realpath(candidate); executable = nodeExecutable; executableArgs = [script, ...(command === 'pnpx' && candidate.includes('pnpm.cjs') ? ['dlx'] : []), ...args]; break } catch { /* standalone executables remain supported by PATH */ }
      }
    }
    const invocationId = randomUUID()
    const policy = await sandboxConfig(cwd, options.allowedDomains ?? [], toolchainRoots, scratch)
    let child: ReturnType<typeof spawn> | undefined
    const outputChunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const outputBytes = { stdout: 0, stderr: 0 }
    let truncated = false
    let closed = false
    let termination: 'timeout' | 'aborted' | undefined
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (!child?.pid) return
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); return } catch { /* process group may already be gone */ }
      }
      if (process.platform === 'win32') {
        const tree = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, env: shellEnvironment(options.env) })
        tree.once('error', () => child?.kill(signal))
        tree.unref()
        return
      }
      child.kill(signal)
    }
    const terminate = (reason: 'timeout' | 'aborted'): void => {
      if (closed) return
      termination ??= reason
      signalProcessGroup('SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => { if (!closed) signalProcessGroup('SIGKILL') }, 250)
    }
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const remaining = Math.max(0, max - outputBytes[target])
      const kept = Math.min(chunk.byteLength, remaining)
      if (kept > 0) outputChunks[target].push(chunk.subarray(0, kept))
      outputBytes[target] += kept
      if (kept < chunk.byteLength) truncated = true
    }
    const outputText = (target: 'stdout' | 'stderr'): string => {
      return decodeUtf8WithinByteLimit(Buffer.concat(outputChunks[target]), max)
    }

    let setupStage = 'reset'
    try {
      // reset first in case an earlier initialize failed part-way through.
      await SandboxManager.reset()
      setupStage = 'initialize'
      await SandboxManager.initialize(policy, undefined, false)
      const commandText = encodeSandboxCommand(executable, executableArgs)
      setupStage = 'wrap'
      const descriptor = await SandboxManager.wrapWithSandboxArgv(commandText, undefined, undefined, options.signal, cwd, { commandId: invocationId, commandText: 'shell.exec' })
      if (options.signal?.aborted) {
        SandboxManager.cleanupAfterCommand()
        await SandboxManager.reset()
        return { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: true }
      }
      child = spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
        cwd,
        env: { ...baseEnv, ...shellEnvironment(descriptor.env), ...executionEnv },
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (cause) {
      try { await SandboxManager.reset() } catch { /* preserve the setup failure */ }
      // Persist only classified diagnostics, never raw subprocess output or credentials.
      const message = cause instanceof Error ? cause.message : ''
      const nativeCode = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      const reason = /windows-install|not provisioned/i.test(message) ? 'WINDOWS_SANDBOX_NOT_PROVISIONED'
        : ['ENOENT', 'EACCES', 'EPERM'].includes(nativeCode) ? nativeCode : 'SANDBOX_INITIALIZATION_ERROR'
      throw Object.assign(shellError('SANDBOX_SETUP_FAILED', false, cause), {
        message: `SANDBOX_SETUP_FAILED (${setupStage}: ${reason})`,
        details: { platform: process.platform, stage: setupStage, reason },
      })
    }

    // This API has no stdin payload; deliver EOF to readers inside the sandbox.
    child.stdin?.end()

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
        closed = true
        cleanup()
        const errorCode = cause && typeof cause === 'object' ? (cause as unknown as { code?: unknown }).code : undefined
        const code = typeof errorCode === 'string' ? errorCode : 'SHELL_EXECUTION_ERROR'
        reject(shellError(code === 'ENOENT' || code === 'EACCES' ? code : 'SHELL_EXECUTION_ERROR', false, cause))
      })
      child!.once('close', (code) => {
        closed = true
        cleanup()
        const stdout = outputText('stdout')
        const stderr = outputText('stderr')
        const annotated = SandboxManager.annotateStderrWithSandboxFailures(invocationId, stderr)
        const boundedStderr = decodeUtf8WithinByteLimit(Buffer.from(annotated, 'utf8'), max)
        const outputWasTruncated = truncated || Buffer.byteLength(annotated, 'utf8') > max
        resolve({ code, stdout, stderr: boundedStderr, truncated: outputWasTruncated, timedOut: termination === 'timeout', aborted: termination === 'aborted' })
      })
    }).finally(async () => {
      try {
        SandboxManager.cleanupAfterCommand()
        await SandboxManager.reset()
      } catch (cause) {
        // A teardown failure must be visible and fail closed for the next call.
        throw shellError('SANDBOX_CLEANUP_FAILED', false, cause)
      }
    })
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
}
