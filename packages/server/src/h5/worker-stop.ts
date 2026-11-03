import type { ChildProcess } from 'node:child_process'
/** Only signals the child created by this worker handle; never discovers a PID. */
export async function waitForWorkerStop(child: ChildProcess, closed: Promise<unknown>, graceMs = 10000, forceMs = 15000): Promise<void> {
  const signal = (name: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(name) }
  const term = setTimeout(() => signal('SIGTERM'), graceMs)
  const kill = setTimeout(() => signal('SIGKILL'), forceMs)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('WORKER_STOP_TIMEOUT')), forceMs + 5000) })]) }
  finally { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline) }
}
