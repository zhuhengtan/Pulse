import { acceptWorkRequests } from './helpers/work-intent.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { asChatWorkAgent, checkWorkControl, withWorkActor } from '../packages/server/src/work-control.js'
it('persists explicit ownership, rejects stale agent commands and allows user takeover without cancelling work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-work-control-'))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), mockResponse: 'done', taskController: false, jarvis: { enabled: false } })
  try {
    const work = await host.createConversation({ origin: 'assistant' })
    const control = await host.conversationData.call<any>('initializeWorkControl', work.id, 'chat-owner')
    expect(control).toMatchObject({ owner: 'assistant', revision: 0 })
    await expect(host.sendMessage(work.id, { text: 'work' })).rejects.toThrow('WORK_CONTROL_REQUIRED')
    const oldActor = { kind: 'assistant' as const, revision: 0, assistantConversationId: 'chat-owner' }
    await withWorkActor(oldActor, () => checkWorkControl(host.conversationData, work.id, 'send'))
    const transferred = await host.conversationData.call<any>('changeWorkControl', work.id, 'takeover', 0)
    expect(transferred).toMatchObject({ owner: 'user', revision: 1 })
    expect((await host.getConversation(work.id)).summary.activeRunId).toBeUndefined()
    await expect(withWorkActor(oldActor, () => checkWorkControl(host.conversationData, work.id, 'send'))).rejects.toThrow('WORK_CONTROL_STALE')
    await expect(asChatWorkAgent(host.conversationData, work.id, () => host.sendMessage(work.id, { text: 'agent command' }))).rejects.toThrow('WORK_CONTROL_REQUIRED')
    const run = await host.sendMessage(work.id, { text: 'human command' }); await run.outcome()
    await expect(host.conversationData.call('changeWorkControl', work.id, 'return', 0)).rejects.toThrow('WORK_CONTROL_STALE')
    expect(await host.conversationData.call('changeWorkControl', work.id, 'return', 1)).toMatchObject({ owner: 'assistant', revision: 2 })
    await expect(withWorkActor(oldActor, () => checkWorkControl(host.conversationData, work.id, 'send'))).rejects.toThrow('WORK_CONTROL_STALE')
    await withWorkActor({ kind: 'approval' }, () => checkWorkControl(host.conversationData, work.id, 'reply'))
    await expect(withWorkActor({ kind: 'approval' }, () => checkWorkControl(host.conversationData, work.id, 'cancel'))).rejects.toThrow('WORK_CONTROL_REQUIRED')
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
it('enforces ownership at authenticated HTTP endpoints, preserving current state on concurrent transfers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-control-http-')), dataDir = join(root, 'data')
  const host = createLocalHost({ cwd: root, dataDir, mockResponse: 'done', taskController: false, jarvis: { enabled: false } })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: auth.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const work = await host.createConversation({ origin: 'assistant' })
    await host.conversationData.call('initializeWorkControl', work.id, (server as any).assistantInbox.conversationId)
    const send = () => fetch(`${base}/api/conversations/${work.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'hello' }) })
    expect((await send()).status).toBe(409)
    const transfer = () => fetch(`${base}/api/conversations/${work.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'takeover', expectedRevision: 0 }) })
    const changes = await Promise.all([transfer(), transfer()])
    expect(changes.map(response => response.status).sort()).toEqual([200, 409])
    expect((await send()).status).toBe(200)
    expect((await host.getConversation(work.id)).summary.control?.owner).toBe('user')
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
it('enforces the same owner revision inside a real isolated worker while letting an in-flight approval survive takeover', async () => {
  const { writeFile, readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { startH5WorkWorker } = await import('../packages/server/src/h5/work-worker.js')
  const root = await mkdtemp(join(tmpdir(), 'pulse-control-worker-')), dataDir = join(root, 'data'), configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ providers: { mock: { provider: 'mock', name: 'Mock' } }, models: { mock: { displayName: 'Mock', provider: 'mock', modelCode: 'mock' } }, activeModel: 'mock', approvalMode: 'ask' }))
  const host = createLocalHost({ cwd: root, dataDir, taskController: false, approvalMode: 'ask', mockToolCalls: [{ name: 'fs.write', input: { path: 'retained.txt', content: 'one write' } }], mockAfterToolResponse: 'done', jarvis: { enabled: false } })
  let run: Awaited<ReturnType<typeof startH5WorkWorker>> | undefined
  try {
    const work = await host.createConversation({ origin: 'assistant' })
    await host.conversationData.call('initializeWorkControl', work.id, 'chat-owner')
    run = await asChatWorkAgent(host.conversationData, work.id, () => startH5WorkWorker({ entry: fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)), dataDir, cwd: root, configPath, approvalMode: 'ask', runtimeOptions: host.getWorkWorkerOptions() }, { conversationId: work.id, text: 'Write retained.txt after approval' }))
    for await (const event of run.events) if (event.type === 'waiting') break
    const pending = await run.pendingInteractions()
    expect(pending).toHaveLength(1)
    await host.conversationData.call('changeWorkControl', work.id, 'takeover', 0)
    expect(run.isActive?.()).toBe(true)
    await expect(withWorkActor({ kind: 'assistant', revision: 0, assistantConversationId: 'chat-owner' }, () => run!.reply(pending[0]!.items[0]!.effectId, { approved: true }))).rejects.toThrow('WORK_CONTROL_STALE')
    await run.reply(pending[0]!.items[0]!.effectId, { approved: true })
    expect((await run.outcome()).status).toBe('succeeded')
    expect(await readFile(join(root, 'retained.txt'), 'utf8')).toBe('one write')
  } finally { await run?.shutdown?.(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)
