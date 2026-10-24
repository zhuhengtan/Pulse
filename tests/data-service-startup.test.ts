import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationData } from '../packages/data/src/index.js'

const roots: string[] = [], clients: ConversationData[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-data-startup-'))
  roots.push(root)
  const data = join(root, 'data')
  await mkdir(data)
  return { root, data }
}
function client(path: string) { const value = new ConversationData(path); clients.push(value); return value }
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const value of clients.splice(0)) await value.close()
  for (const root of roots.splice(0)) {
    // Only our fixture writer is allowed to finish its normal idle shutdown.
    for (let i = 0; i < 100; i++) {
      if (!await readFile(join(root, 'data/.writer.lock')).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

it('waits for a real service whose cold start exceeds the former three-second window', async () => {
  const { root, data } = await fixture(), preload = join(root, 'delay.mjs')
  const service = fileURLToPath(new URL('../packages/data/src/service.mjs', import.meta.url))
  await writeFile(preload, `if (process.argv[1] === ${JSON.stringify(service)} && process.argv[2] === ${JSON.stringify(data)}) await new Promise(resolve => setTimeout(resolve, 3300));\n`)
  vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim())
  const started = Date.now()
  expect(await client(data).call('list')).toEqual([])
  expect(Date.now() - started).toBeGreaterThanOrEqual(3300)
  expect(await client(data).call('revision')).toBe(0)
}, 12_000)

it('reports an actual database startup failure by phase and code', async () => {
  const { data } = await fixture()
  // An owned directory at the database filename makes SQLite open fail reliably.
  await mkdir(join(data, 'pulse.sqlite'))
  await expect(client(data).call('list')).rejects.toMatchObject({
    code: 'DATA_SERVICE_START_FAILED', details: expect.objectContaining({ phase: 'database', serviceCode: 'ERR_SQLITE_ERROR' }),
  })
})

it('concurrent clients share one writer without turning lock contention into a startup failure', async () => {
  const { data } = await fixture()
  const values = Array.from({ length: 12 }, () => client(data))
  expect(await Promise.all(values.map(value => value.call('list')))).toEqual(Array.from({ length: 12 }, () => []))
  const owner = JSON.parse(await readFile(join(data, '.writer.lock'), 'utf8'))
  await Promise.all(values.map((value, index) => value.call('saveState', `fixture-${index}`, index)))
  expect(JSON.parse(await readFile(join(data, '.writer.lock'), 'utf8')).pid).toBe(owner.pid)
  expect(await values[0]!.call('readState', 'fixture-11')).toBe(11)
}, 12_000)

it('keeps an invalid existing writer lock intact and reports it explicitly', async () => {
  const { data } = await fixture(), lock = join(data, '.writer.lock')
  await writeFile(lock, 'invalid fixture lock')
  await expect(client(data).call('list')).rejects.toMatchObject({
    code: 'DATA_SERVICE_START_FAILED', details: expect.objectContaining({ phase: 'lock-invalid', serviceCode: 'DATA_WRITER_LOCK_INVALID' }),
  })
  expect(await readFile(lock, 'utf8')).toBe('invalid fixture lock')
  await rm(lock)
})
