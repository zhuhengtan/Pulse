import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltinPluginJobs } from '../packages/server/src/builtin-plugins/jobs.js'

const faults = vi.hoisted(() => ({ active: false, permanent: false, rejected: 0, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (source: string, target: string) => {
    let ticketSave = false
    if (faults.active && String(target).includes('builtin-plugin-jobs') && String(target).endsWith('.json')) {
      const value = JSON.parse(await fs.readFile(source, 'utf8'))
      ticketSave = Boolean(value.ticket && ['running', 'failed'].includes(value.state))
    }
    if (ticketSave && (faults.permanent || faults.rejected === 0)) {
      faults.rejected++
      Object.defineProperty(process, 'platform', { ...faults.platform, value: 'win32' })
      throw Object.assign(new Error('synthetic Windows sharing violation at acknowledged ticket persistence'), { code: 'EPERM' })
    }
    const result = await fs.rename(source, target)
    if (ticketSave) Object.defineProperty(process, 'platform', faults.platform)
    return result
  } }
})
afterEach(() => { Object.defineProperty(process, 'platform', faults.platform); faults.active = false; faults.permanent = false; faults.rejected = 0 })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-plugin-storage-'))
  let posts = 0, polls = 0
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  const server = createServer((req, res) => {
    const value = req.method === 'POST' ? (posts++, { status: 'queued', id: 'storage-ticket' }) : (polls++, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png }] })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const cfg = { allowNetwork: true, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone' as const, adapter: 'custom' as const, baseURL: 'http://127.0.0.1:' + (server.address() as any).port, model: 'fixture', timeoutMs: 10000 } } } }
  const path = join(root, 'config.json'); await writeFile(path, JSON.stringify(cfg))
  return { root, jobs: new BuiltinPluginJobs(root, () => cfg, () => path), counts: () => ({ posts, polls }), close: async () => { Object.defineProperty(process, 'platform', faults.platform); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } }
}
it('persists an acknowledged ticket across a transient sharing violation without submitting twice', async () => {
  const f = await fixture(); faults.active = true
  try {
    const result = await f.jobs.generate(f.root, 'run', 'effect', 'image', { prompt: 'synthetic' }, new AbortController().signal, () => {})
    expect((await f.jobs.list())[0]).toMatchObject({ state: 'succeeded', ticket: { id: 'storage-ticket' } })
    expect(faults.rejected).toBe(1); expect(f.counts()).toEqual({ posts: 1, polls: 1 }); expect(result.hash).toHaveLength(64)
    expect(await f.jobs.generate(f.root, 'run', 'effect', 'image', { prompt: 'synthetic' }, new AbortController().signal, () => {})).toEqual(result)
    expect(f.counts()).toEqual({ posts: 1, polls: 1 })
  } finally { await f.close() }
}, 20000)
it('does not resubmit after permanent ticket persistence failure', async () => {
  const f = await fixture(); faults.active = true; faults.permanent = true
  try {
    await expect(f.jobs.generate(f.root, 'run', 'effect', 'image', { prompt: 'synthetic' }, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'PLUGIN_STATE_PERSIST_FAILED' })
    Object.defineProperty(process, 'platform', faults.platform); faults.active = false
    const saved = await f.jobs.list(); expect(saved[0]).toMatchObject({ state: 'submitting' }); expect(saved[0]?.ticket).toBeUndefined()
    await expect(f.jobs.generate(f.root, 'run', 'effect', 'image', { prompt: 'synthetic' }, new AbortController().signal, () => {})).rejects.toThrow('PLUGIN_SUBMISSION_UNKNOWN')
    expect(f.counts()).toEqual({ posts: 1, polls: 0 }); expect(faults.rejected).toBeLessThanOrEqual(20)
  } finally { await f.close() }
}, 20000)
