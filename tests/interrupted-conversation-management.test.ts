import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { readConversationFixture, writeConversationFixture } from './conversation-fixtures.js'

async function fixture(check: (f: { host: ReturnType<typeof createLocalHost>; root: string; id: string; runId: string; headers: Record<string, string>; base: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-interrupted-manage-'))
  const host = createLocalHost({ cwd: root, dataDir: root }), server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0 })
  try {
    const conversation = await host.createConversation({ title: 'Interrupted' }), id = conversation.id, runId = 'run-interrupted'
    const path = join(root, 'conversations', id, 'manifest.json')
    const manifest = JSON.parse(await readConversationFixture(path, 'utf8'))
    await writeConversationFixture(path, JSON.stringify({ ...manifest, activeRunId: runId, runs: [runId] }))
    await mkdir(join(root, 'conversations', id, 'runs', runId), { recursive: true })
    await writeFile(join(root, 'conversations', id, 'runs', runId, 'checkpoint.txt'), 'preserved checkpoint')
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    await check({ host, root, id, runId, base, headers: { Origin: base, Cookie: session.headers.get('set-cookie')!, 'Content-Type': 'application/json' } })
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
}

it('archives an interrupted conversation without clearing its recovery record, then permits deletion', async () => fixture(async ({ host, root, id, runId, base, headers }) => {
  const archived = await fetch(base + '/api/conversations/' + id, { method: 'PATCH', headers, body: JSON.stringify({ archived: true }) })
  expect(archived.status).toBe(200)
  expect(await archived.json()).toMatchObject({ id, archivedAt: expect.any(String), activeRunId: runId })
  expect(await readFile(join(root, 'conversations', id, 'runs', runId, 'checkpoint.txt'), 'utf8')).toBe('preserved checkpoint')
  const restored = await fetch(base + '/api/conversations/' + id, { method: 'PATCH', headers, body: JSON.stringify({ archived: false }) })
  expect(restored.status).toBe(200)
  expect((await host.getConversation(id)).summary.activeRunId).toBe(runId)
  const deleted = await fetch(base + '/api/conversations/' + id, { method: 'DELETE', headers })
  expect(deleted.status).toBe(200)
  await expect(host.getConversation(id)).rejects.toThrow('CONVERSATION_NOT_FOUND')
}))

it('rejects archive and delete while another live owner holds the conversation lock', async () => fixture(async ({ host, root, id, base, headers }) => {
  const lock = join(root, 'conversations', id, 'conversation.lock')
  await writeFile(lock, JSON.stringify({ pid: process.pid, runId: 'owned-elsewhere' }))
  for (const method of ['PATCH', 'DELETE']) {
    const response = await fetch(base + '/api/conversations/' + id, { method, headers, ...(method === 'PATCH' ? { body: JSON.stringify({ archived: true }) } : {}) })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'CONVERSATION_BUSY' })
  }
  expect((await host.getConversation(id)).summary.archivedAt).toBeUndefined()
  expect(JSON.parse(await readFile(lock, 'utf8')).runId).toBe('owned-elsewhere')
}))
