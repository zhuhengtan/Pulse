import { spawn } from 'node:child_process'
export interface ShellResult { code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; aborted: boolean }
export function runShell(command: string, args: string[] = [], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<ShellResult> {
  const max = options.maxOutputBytes ?? 256 * 1024
  if (!Number.isFinite(max) || max < 0) return Promise.reject(new Error('INVALID_SHELL_OUTPUT_LIMIT'))
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) return Promise.reject(new Error('INVALID_SHELL_TIMEOUT'))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, detached: process.platform !== 'win32' })
    let stdout = ''; let stderr = ''; let truncated = false
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => { const value = chunk.toString(); const current = target === 'stdout' ? stdout : stderr; const next = current + value; if (Buffer.byteLength(next) > max) { truncated = true; const limited = next.slice(0, max); if (target === 'stdout') stdout = limited; else stderr = limited } else if (target === 'stdout') stdout = next; else stderr = next }
    let closed = false
    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return } catch { /* process group may already be gone */ } }
      child.kill(signal)
    }
    let termination: 'timeout' | 'aborted' | undefined
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (reason: 'timeout' | 'aborted'): void => {
      if (closed) return
      termination ??= reason
      signalProcessGroup('SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => { if (!closed) signalProcessGroup('SIGKILL') }, 250)
    }
    const timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => terminate('timeout'), options.timeoutMs) : undefined
    const abort = (): void => terminate('aborted')
    if (options.signal) { if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }) }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', reject); child.on('close', (code) => { closed = true; if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolve({ code, stdout, stderr, truncated, timedOut: termination === 'timeout', aborted: termination === 'aborted' }) })
  })
}
