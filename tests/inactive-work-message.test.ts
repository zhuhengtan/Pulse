import { acceptWorkRequests } from './helpers/work-intent.js'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it.each(['whenIdle', 'immediate'] as const)('starts a new explicit %s message after an incomplete run with a stale busy marker', async delivery => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-inactive-send-'))
  const host = createLocalHost({ cwd: root, dataDir: root, mockResponse: 'new message accepted', jarvis: { enabled: false } })
  acceptWorkRequests(host, 'continue')
  const server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const conversation = await host.createConversation()
    const previous = await host.sendMessage(conversation.id, { text: 'original task' })
    await previous.outcome()
    const runId = previous.id
    const manifest = await (host as any).readManifest(conversation.id)
    manifest.activeRunId = runId
    await (host as any).saveManifest(manifest)
    const dir = join(root, 'conversations', conversation.id, 'runs', runId)
    const saved = JSON.parse(await readFile(join(dir, 'outcome.json'), 'utf8'))
    const outcome = JSON.stringify({ ...saved, taskOutcome: { status: 'incomplete' } })
    await writeFile(join(dir, 'outcome.json'), outcome)
    const response = await fetch(base + `/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: '继续处理', requestId: 'new-explicit-message', delivery }) })
    expect(response.status).toBe(200)
    const receipt = await response.json()
    expect(receipt.runId).not.toBe(runId)
    const completed = await fetch(base + `/api/runs/${receipt.runId}/events`, { headers })
    expect(await completed.text()).toContain('run_finished')
    expect(await readFile(join(dir, 'outcome.json'), 'utf8')).toBe(outcome)
    await vi.waitFor(async () => expect((await host.getConversation(conversation.id)).summary.activeRunId).toBeUndefined())
    // Unknown process outcomes still return an actionable error, never admit a second writer.
    const latest = await (host as any).readManifest(conversation.id)
    latest.activeRunId = runId; await (host as any).saveManifest(latest)
    await mkdir(join(dir, 'shell-processes'))
    await writeFile(join(dir, 'shell-processes', 'a'.repeat(64) + '.json'), JSON.stringify({ processId: 'a'.repeat(64), status: 'running', agentId: 'a', laneId: 'l', command: { command: 'unknown' } }))
    const blocked = await fetch(base + `/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'next', requestId: 'blocked-explicit-message', delivery }) })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({ error: 'RECOVERY_SIDE_EFFECT_UNKNOWN' })
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
