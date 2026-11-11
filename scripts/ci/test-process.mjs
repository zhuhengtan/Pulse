import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Keep cancellation responsive while the one test invocation runs. Only its
// owned POSIX process group (or Windows process tree) is eligible for cleanup.
export async function runTestProcess(command, args, options) {
  const windows = process.platform === 'win32'
  const child = spawn(command, args, { ...options, detached: !windows })
  let interrupted, cleanupError
  const stop = signal => {
    if (!child.pid) return
    try {
      if (windows) {
        const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
        if (result.error) throw result.error
        if (result.status !== 0 && child.exitCode === null && child.signalCode === null) throw Error('TEST_PROCESS_TREE_CLEANUP_FAILED')
      } else process.kill(-child.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') cleanupError = error }
  }
  let cleanup
  const clean = () => {
    if (!cleanup) {
      stop('SIGTERM')
      cleanup = windows ? Promise.resolve() : new Promise(resolve => setTimeout(() => { stop('SIGKILL'); resolve() }, 1000))
    }
    return cleanup
  }
  const onInterrupt = signal => { interrupted ??= signal; void clean() }
  const onTerm = () => onInterrupt('SIGTERM')
  const onInt = () => onInterrupt('SIGINT')
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt)
  try {
    const result = await new Promise(resolve => {
      let error
      child.once('error', value => { error = value })
      child.once('close', (status, signal) => resolve({ status, signal, error }))
      // A killed test main may leave children holding inherited stdio open.
      child.once('exit', (status, signal) => { if (status !== 0 || signal) void clean() })
    })
    if (interrupted || result.error || result.signal || result.status !== 0) await clean()
    else if (!windows && child.pid) {
      try {
        process.kill(-child.pid, 0)
        // A nominally successful main must not leave its owned children running.
        await clean()
        result.error = Error('TEST_PROCESS_DESCENDANTS_REMAINED')
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    if (cleanupError) throw cleanupError
    return interrupted ? { ...result, status: interrupted === 'SIGINT' ? 130 : 143, signal: interrupted } : result
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt)
  }
}
