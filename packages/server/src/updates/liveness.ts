/** A persisted run marker is not a live owner. Unverifiable owners remain busy. */
export function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return true
  try { process.kill(Number(pid), 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
export function scheduledWorkActive(tasks: Array<{ run?: { ownerPid?: number } }>, alive: (pid: unknown) => boolean = processAlive): boolean {
  return tasks.some(task => task.run && alive(task.run.ownerPid))
}
