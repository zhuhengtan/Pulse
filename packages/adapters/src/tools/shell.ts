import { spawn } from 'node:child_process'
export interface ShellResult { code: number | null; stdout: string; stderr: string; truncated: boolean }
export function runShell(command: string, args: string[] = [], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<ShellResult> {
  const max = options.maxOutputBytes ?? 256 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, detached: process.platform !== 'win32' })
    let stdout = ''; let stderr = ''; let truncated = false
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => { const value = chunk.toString(); const current = target === 'stdout' ? stdout : stderr; const next = current + value; if (Buffer.byteLength(next) > max) { truncated = true; const limited = next.slice(0, max); if (target === 'stdout') stdout = limited; else stderr = limited } else if (target === 'stdout') stdout = next; else stderr = next }
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs) : undefined
    const abort = (): void => { child.kill('SIGTERM'); setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 250) }
    if (options.signal) { if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }) }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', reject); child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, truncated }) })
  })
}
