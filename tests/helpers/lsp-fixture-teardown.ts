import { afterEach, beforeEach, expect } from 'vitest'
import cp from 'node:child_process'
import { rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Observe only these fixtures' fixed LSP sidecars; never kill unrelated PIDs. */
export function registerLspFixtureTeardown(roots: string[], controllers: AbortController[]): void {
  const worker = fileURLToPath(new URL('../../packages/server/src/lsp/worker.cjs', import.meta.url))
  const closing = new Set<Promise<void>>()
  let previous: typeof cp.spawn
  beforeEach(() => {
    previous = cp.spawn
    cp.spawn = function (file: string, args: string[], options: any) {
      const owned = file === process.execPath && Array.isArray(args) && args.includes(worker)
      const trace = process.platform === 'win32' && owned ? process.env.PULSE_CI_SRT_LOG : undefined
      const child = Reflect.apply(previous, cp, [file, args, trace ? { ...options, env: { ...options.env, PULSE_CI_SRT_LOG: trace } } : options])
      if (owned) {
        const closed = new Promise<void>(resolve => child.once('close', () => { closing.delete(closed); resolve() }))
        closing.add(closed)
      }
      return child
    } as typeof cp.spawn
    syncBuiltinESMExports()
  })
  afterEach(async () => {
    controllers.splice(0).forEach(controller => controller.abort())
    try {
      // A fixed 150ms sleep is shorter than the Windows helper's 250ms grace.
      // Wait for actual close before removing a still-owned current directory.
      // Native ACL cleanup can exceed Vitest's 10s default; use the existing
      // Windows LSP fixture deadline, without changing any production deadline.
      await Promise.all([...closing])
      expect(closing.size).toBe(0)
      await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })))
    } finally {
      cp.spawn = previous
      syncBuiltinESMExports()
    }
  }, process.platform === 'win32' ? 480000 : 10000)
}
