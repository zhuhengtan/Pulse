import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, parse, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
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
$child = [System.Diagnostics.Process]::new()
$child.StartInfo = $psi
if (-not $child.Start()) { exit 127 }
$outTask = $child.StandardOutput.ReadToEndAsync()
$errTask = $child.StandardError.ReadToEndAsync()
$inTask = [Console]::OpenStandardInput().CopyToAsync($child.StandardInput.BaseStream)
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

async function sandboxConfig(cwd: string): Promise<SandboxRuntimeConfig> {
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
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: [...denyRead],
      allowRead: [cwd, ...(seccompPath ? [seccompPath] : [])],
      allowWrite: [cwd],
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

export function runShell(command: string, args: string[] = [], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ShellResult> {
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
    const invocationId = randomUUID()
    const policy = await sandboxConfig(cwd)
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

    try {
      // reset first in case an earlier initialize failed part-way through.
      await SandboxManager.reset()
      await SandboxManager.initialize(policy, undefined, false)
      const commandText = encodeSandboxCommand(command, args)
      const descriptor = await SandboxManager.wrapWithSandboxArgv(commandText, undefined, undefined, options.signal, cwd, { commandId: invocationId, commandText: 'shell.exec' })
      if (options.signal?.aborted) {
        SandboxManager.cleanupAfterCommand()
        await SandboxManager.reset()
        return { code: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: true }
      }
      child = spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
        cwd,
        env: shellEnvironment(options.env ?? descriptor.env),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (cause) {
      try { await SandboxManager.reset() } catch { /* preserve the setup failure */ }
      throw shellError('SANDBOX_SETUP_FAILED', false, cause)
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
  })
}
