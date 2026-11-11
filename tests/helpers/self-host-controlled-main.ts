import type { ChildProcess } from 'node:child_process'
import { expect, vi } from 'vitest'
// @ts-expect-error standalone script
import { listActiveChildren, killProcessGroup } from '../../scripts/self-host.mjs'

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/** Keep clock ownership until main settles, including children spawned after a
 * failed readiness assertion. Restoring clocks earlier would orphan fake timers. */
export function trackControlledMain<T>(pending: Promise<T>, budgetMs: number) {
  const operationDeadline = performance.now() + 5000
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  const children = new Set<ChildProcess>()
  const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  return {
    children,
    get settled() { return settled },
    async wait(): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = realSetTimeout(() => reject(new Error('controlled main deadline')), Math.max(1, operationDeadline - performance.now()))
        })])
      } finally { if (timer) realClearTimeout(timer) }
    },
    async cleanup() {
      // The readiness watchdog is 5s; cleanup stays within the existing 10s test.
      const deadline = performance.now() + 4000
      do {
        for (const child of listActiveChildren()) children.add(child)
        // Trigger timeout classification before killing the process: a plain
        // nonzero baseline exit could otherwise allow another repair attempt.
        vi.advanceTimersByTime(budgetMs)
        for (const child of children) if (!exited(child)) killProcessGroup(child, 'SIGKILL')
        await new Promise<void>(resolve => realSetTimeout(resolve, 5))
        if (settled && listActiveChildren().length === 0 && [...children].every(exited)) break
      } while (performance.now() < deadline)
      expect(settled, 'main must settle before releasing its controlled clock').toBe(true)
      expect(listActiveChildren()).toEqual([])
      for (const child of children) {
        expect(exited(child)).toBe(true)
        expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      }
      expect(vi.getTimerCount()).toBe(0)
    },
  }
}
