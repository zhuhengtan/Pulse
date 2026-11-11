import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect } from 'vitest'

// Failure/quarantine probes intentionally retain capacity. Give independent
// tests separate host ledgers, while their child processes inherit the same one.
beforeEach(() => { process.env.PULSE_TEST_TASK_ADMISSION_DIR = mkdtempSync(join(tmpdir(), 'pulse-admission-tests-')) })
const nativeFetch = globalThis.fetch

// Real CLI/worker children do not execute Vitest setup. Carry the same offline
// boundary into them, so a merged user config cannot silently call a provider.
if (!expect.getState().testPath?.replaceAll('\\', '/').includes('/tests/live/')) {
  const guard = new URL('./fixtures/offline-child.mjs', import.meta.url).href
  if (!process.env.NODE_OPTIONS?.includes(guard)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${guard}`.trim()
}

// Keep ordinary tests offline even if a failing test restores its provider mock
// while background cleanup is still running. Explicit live tests retain access.
globalThis.fetch = async (input, init) => {
  const testPath = expect.getState().testPath?.replaceAll('\\', '/')
  if (!testPath?.includes('/tests/live/')) {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('OFFLINE_TEST_NETWORK_BLOCKED: use a provider mock or a loopback fixture')
    }
  }
  return nativeFetch(input, init)
}
