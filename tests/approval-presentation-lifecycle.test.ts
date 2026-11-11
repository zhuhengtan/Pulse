import { acceptWorkRequests } from './helpers/work-intent.js'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

async function fixture(timeoutMs = 5000, ask = false) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-quiet-approval-'))
  const pending: ServerResponse[] = []
  const reviewer = createServer((_req, res) => { pending.push(res) })
  await new Promise<void>(resolve => reviewer.listen(0, '127.0.0.1', resolve))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'ask',
    mockToolCalls: ask ? [{ name: 'ask.choice', input: { prompt: 'Which scope?', options: ['Small', 'Large'] } }] : [{ name: 'fs.write', input: { path: 'result.txt', content: 'approved exactly once' } }], mockAfterToolResponse: 'Done',
    approvalReview: { provider: 'ollama', model: 'scripted-reviewer', baseURL: `http://127.0.0.1:${(reviewer.address() as { port: number }).port}`, timeoutMs },
  })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir: join(root, 'data'), port: 0, host: '127.0.0.1' })
  const { port } = await server.start(), base = `http://127.0.0.1:${port}`
  const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
  const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } })
    expect(response.ok).toBe(true)
    return response.json()
  }
  await json('/api/assistant')
  await json('/api/approval-policy', { method: 'PUT', body: JSON.stringify({ policy: 'delegate' }) })
  const conversation = await host.createConversation({ origin: 'assistant' })
  const { runId } = await json(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Create result.txt with the requested content in this workspace.' }) })
  const snapshot = () => json(`/api/runs/${runId}/state`)
  const release = (text = 'APPROVE', status = 200) => {
    for (const res of pending) if (!res.writableEnded && !res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }))
  }
  return { root, pending, runId, conversation, json, snapshot, release,
    events: async () => (await fetch(`${base}/api/runs/${runId}/events?after=0`, { headers, signal: AbortSignal.timeout(5000) })).text(),
    close: async () => { release(); await server.stop(); await host.close(); reviewer.closeAllConnections(); await new Promise<void>(resolve => reviewer.close(() => resolve())); await rm(root, { recursive: true, force: true }) },
  }
}

it('never publishes an approval card or notification for a delegated operation, even while its review is slow', async () => {
  const f = await fixture()
  try {
    await vi.waitFor(() => expect(f.pending).toHaveLength(1), { timeout: 5000 })
    expect((await f.snapshot()).interactions ?? []).toEqual([])
    expect((await f.snapshot()).waiting).toBeUndefined()
    expect((await f.json('/api/assistant')).workInteractions).toEqual([])
    expect((await f.json('/api/notifications')).filter((n: any) => n.kind === 'approval')).toEqual([])
    await expect(readFile(join(f.root, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const stream = f.events()
    f.release()
    await vi.waitFor(async () => expect((await f.snapshot()).state).toBe('succeeded'), { timeout: 5000 })
    expect(await readFile(join(f.root, 'result.txt'), 'utf8')).toBe('approved exactly once')
    const events = (await stream).split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    expect(events.some(event => event.type === 'waiting' && event.data.input.kind === 'approval')).toBe(false)
    expect(events.flatMap(event => event.type === 'interactions' ? event.data.interactions : []).some(group => group.kind === 'approval')).toBe(false)
    expect(f.pending).toHaveLength(1)
  } finally { await f.close() }
}, 15_000)

it.each(['rejected', 'unavailable', 'timeout'] as const)('exposes the real human decision after delegated review is %s', async result => {
  const f = await fixture(result === 'timeout' ? 150 : 5000)
  try {
    await vi.waitFor(() => expect(f.pending.length).toBeGreaterThan(0), { timeout: 5000 })
    if (result !== 'timeout') {
      expect((await f.snapshot()).interactions ?? []).toEqual([])
      f.release(result === 'rejected' ? 'REJECT' : '', result === 'unavailable' ? 503 : 200)
    }
    await vi.waitFor(async () => {
      const snapshot = await f.snapshot()
      expect(snapshot.interactions).toContainEqual(expect.objectContaining({ kind: 'approval' }))
      expect(snapshot.reviewNote).toContain('需要你决定')
    }, { timeout: result === 'timeout' ? 36_000 : 5000 })
    expect((await f.json('/api/assistant')).workInteractions).toContainEqual(expect.objectContaining({ runId: f.runId, kind: 'approval' }))
    await vi.waitFor(async () => expect((await f.json('/api/notifications')).some((n: any) => n.runId === f.runId && n.kind === 'approval')).toBe(true))
    await expect(readFile(join(f.root, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.json('/api/approval-policy', { method: 'PUT', body: JSON.stringify({ policy: 'delegate' }) })
    expect((await f.snapshot()).interactions).toContainEqual(expect.objectContaining({ kind: 'approval' }))
  } finally { await f.close() }
}, 45_000)

it('shows pending approval immediately when the user switches from delegated to manual review', async () => {
  const f = await fixture()
  try {
    await vi.waitFor(() => expect(f.pending).toHaveLength(1), { timeout: 5000 })
    expect((await f.snapshot()).interactions ?? []).toEqual([])
    await f.json('/api/approval-policy', { method: 'PUT', body: JSON.stringify({ policy: 'manual' }) })
    await vi.waitFor(async () => expect((await f.snapshot()).interactions).toContainEqual(expect.objectContaining({ kind: 'approval' })))
    f.release()
    await expect(readFile(join(f.root, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
}, 15_000)

it('keeps actual user questions visible during delegated approval mode', async () => {
  const f = await fixture(5000, true)
  try {
    await vi.waitFor(async () => expect((await f.snapshot()).interactions).toContainEqual(expect.objectContaining({ kind: 'ask' })), { timeout: 5000 })
    await vi.waitFor(async () => expect((await f.json('/api/assistant')).workInteractions).toContainEqual(expect.objectContaining({ runId: f.runId, kind: 'ask' })))
    expect(f.pending).toHaveLength(0)
  } finally { await f.close() }
}, 15_000)
