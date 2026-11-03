import { expect, it, vi } from 'vitest'
import { scheduledWorkActive } from '../packages/server/src/updates/liveness.js'
import { waitForWorkerStop } from '../packages/server/src/h5/worker-stop.js'
it('ignores dead scheduled run owners without discarding their saved recovery records', () => {
  const tasks = [{ run: { ownerPid: 123 } }]
  expect(scheduledWorkActive(tasks, () => false)).toBe(false)
  expect(tasks[0]!.run).toEqual({ ownerPid: 123 })
  expect(scheduledWorkActive(tasks, () => true)).toBe(true)
})
it('escalates only a nonresponsive owned worker and clears all shutdown timers', async () => {
  vi.useFakeTimers()
  let close!: () => void
  const closed = new Promise<void>(resolve => { close = resolve })
  const child = { exitCode: null, signalCode: null, kill: vi.fn(signal => { if (signal === 'SIGKILL') close() }) }
  try {
    const stopping = waitForWorkerStop(child as any, closed, 100, 200)
    await vi.advanceTimersByTimeAsync(100); expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(100); await stopping
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
