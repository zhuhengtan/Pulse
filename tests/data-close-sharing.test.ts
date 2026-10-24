import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ConversationData } from '../packages/data/src/index.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

async function closeWithReadFailure(code: string, platform: string, transient: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-close-sharing-'))
  const client = new ConversationData(directory)
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  let reads = 0
  try {
    await client.call('saveState', 'preserved', 'value')
    const failure = Object.assign(new Error('simulated lock sharing failure'), { code })
    vi.mocked(readFile).mockImplementation(((...args: Parameters<typeof readFile>) => {
      if (String(args[0]) === join(directory, '.writer.lock') && (++reads <= 2 || !transient)) return Promise.reject(failure)
      return Reflect.apply(actual.readFile, undefined, args)
    }) as typeof readFile)
    // The real connection is already open. Only the client's close polling
    // observes this platform override; its writer is a separate native process.
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    const started = performance.now()
    if (transient) {
      await client.close()
      expect(reads).toBeGreaterThanOrEqual(3)
      await expect(actual.readFile(join(directory, '.writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(client.close()).rejects.toBe(failure)
      expect(performance.now() - started).toBeLessThan(3000)
      if (platform !== 'win32' || code === 'EIO') expect(reads).toBe(1)
      else expect(reads).toBeGreaterThan(2)
    }
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    vi.mocked(readFile).mockImplementation(actual.readFile)
    await client.close().catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

it.each(['EPERM', 'EACCES', 'EBUSY'])('waits through transient Windows lock deletion sharing failures: %s', code => closeWithReadFailure(code, 'win32', true))
it('propagates a persistent Windows lock access failure within the close budget', () => closeWithReadFailure('EPERM', 'win32', false))
it('does not retry an unrelated Windows I/O failure', () => closeWithReadFailure('EIO', 'win32', false))
it('does not reinterpret non-Windows permission failures as sharing contention', () => closeWithReadFailure('EPERM', 'linux', false))
