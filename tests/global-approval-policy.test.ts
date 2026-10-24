import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it('shares approval across old and new conversations, persists on restart and remains readable by desktop offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-global-approval-'))
  const options = { cwd: root, dataDir: root, approvalMode: 'ask' as const, mockToolCalls: [{ name: 'fs.write', input: { path: 'result.txt', content: 'test' } }] }
  let host = createLocalHost(options)
  let server = new H5Server(host, { dataDir: root, port: 0, host: '127.0.0.1' })
  let reader: Worker | undefined
  const connect = async () => {
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    return { base, headers: { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' } }
  }
  try {
    let { base, headers } = await connect()
    const existing = await host.createConversation({ title: 'Existing' })
    expect((await fetch(`${base}/api/approval-policy`)).status).toBe(401)
    const paired = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Phone' }) })
    const pairedHeaders = { Cookie: paired.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    expect((await fetch(`${base}/api/approval-policy`, { method: 'PUT', headers: pairedHeaders, body: JSON.stringify({ policy: 'delegate' }) })).status).toBe(403)
    expect(await fetch(`${base}/api/approval-policy`, { headers: pairedHeaders }).then(r => r.json())).toEqual({ policy: 'manual' })
    expect(await fetch(`${base}/api/approval-policy`, { headers }).then(r => r.json())).toEqual({ policy: 'manual' })
    expect((await fetch(`${base}/api/approval-policy`, { method: 'PUT', headers: { ...headers, Origin: 'http://other.invalid' }, body: JSON.stringify({ policy: 'delegate' }) })).status).toBe(403)
    expect((await fetch(`${base}/api/approval-policy`, { method: 'PUT', headers, body: JSON.stringify({ policy: 'unrestricted' }) })).status).toBe(400)
    expect(await fetch(`${base}/api/approval-policy`, { method: 'PUT', headers, body: JSON.stringify({ policy: 'delegate' }) }).then(r => r.json())).toEqual({ policy: 'delegate' })
    const created = await host.createConversation({ title: 'New' })
    const runs: string[] = []
    for (const conversation of [existing, created]) {
      // A legacy per-conversation default must not suppress global delegation.
      expect(conversation.summary.approvalPolicy).toBe('manual')
      const { runId } = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Create result.txt' }) }).then(r => r.json())
      runs.push(runId)
      await vi.waitFor(async () => {
        const snapshot = await fetch(`${base}/api/runs/${runId}/state`, { headers }).then(r => r.json())
        expect(snapshot.reviewNote).toContain('尚未配置审核模型')
        expect(snapshot.interactions).toContainEqual(expect.objectContaining({ kind: 'approval' }))
      }, { timeout: 5000, interval: 25 })
    }
    await fetch(`${base}/api/approval-policy`, { method: 'PUT', headers, body: JSON.stringify({ policy: 'manual' }) })
    for (const runId of runs) await vi.waitFor(async () => {
      const snapshot = await fetch(`${base}/api/runs/${runId}/state`, { headers }).then(r => r.json())
      expect(snapshot.reviewNote).toBeUndefined()
      expect(snapshot.interactions).toContainEqual(expect.objectContaining({ kind: 'approval' }))
    })
    await fetch(`${base}/api/approval-policy`, { method: 'PUT', headers, body: JSON.stringify({ policy: 'delegate' }) })
    await server.stop(); await host.close()
    host = createLocalHost(options)
    server = new H5Server(host, { dataDir: root, port: 0, host: '127.0.0.1' })
    ;({ base, headers } = await connect())
    expect(await fetch(`${base}/api/approval-policy`, { headers }).then(r => r.json())).toEqual({ policy: 'delegate' })
    await server.stop()
    reader = new Worker(new URL('../packages/desktop/src/read-worker.mjs', import.meta.url), { workerData: { directory: root } })
    const result = new Promise(resolve => reader!.once('message', resolve))
    reader.postMessage({ id: 'offline-policy', path: '/api/approval-policy' })
    expect(await result).toEqual({ id: 'offline-policy', status: 200, body: { policy: 'delegate' } })
  } finally { await reader?.terminate(); await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 20_000)
