import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it('exposes assistant approval in the persistent chat and lets the user choose its approval policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-assistant-http-'))
  const profile = { provider: 'mock' as const, defaultModel: 'mock' }
  const host = createLocalHost({ cwd: root, dataDir: root, provider: profile, providerProfiles: { mock: profile }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', approvalMode: 'ask', mockToolCalls: [{ name: 'work.start', input: { projectId: 'p', task: 'Inspect' } }] })
  const server = new H5Server(host, { dataDir: root, port: 0, host: '127.0.0.1' })
  try {
    const { port } = await server.start(); const baseUrl = `http://127.0.0.1:${port}`
    const session = await fetch(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl } })
    const cookie = session.headers.get('set-cookie')!
    const headers = { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' }
    await fetch(`${baseUrl}/api/assistant/messages`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'assistant-approval-001', text: '请调用 work.start 查看项目' }) })
    let view: { conversation: { id: string }; workInteractions: Array<{ conversationId: string; kind: string }> }
    await vi.waitFor(async () => {
      view = await fetch(`${baseUrl}/api/assistant`, { headers }).then(response => response.json())
      expect(view.workInteractions).toContainEqual(expect.objectContaining({ conversationId: view.conversation.id, kind: 'approval' }))
    }, { timeout: 10_000, interval: 50 })
    const policy = await fetch(`${baseUrl}/api/conversations/${view!.conversation.id}`, { method: 'PATCH', headers, body: JSON.stringify({ approvalPolicy: 'delegate' }) })
    expect(policy.status).toBe(200)
    const protectedEdit = await fetch(`${baseUrl}/api/conversations/${view!.conversation.id}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'change' }) })
    expect(protectedEdit.status).toBe(409)
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('serves only registered unmerged artifacts to authenticated sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-artifact-http-')), work = join(root, 'work')
  await mkdir(work)
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'plan.txt', content: 'Saved plan' } }], mockAfterToolResponse: 'Created' })
  const server = new H5Server(host, { dataDir: join(root, 'data'), port: 0, host: '127.0.0.1' })
  try {
    const conversation = await host.createConversation(); await host.setConversationExecutionWorkspace(conversation.id, work, root)
    const run = await host.sendMessage(conversation.id, { text: '创建 plan.txt' }); await run.outcome()
    const { port } = await server.start(), baseUrl = `http://127.0.0.1:${port}`
    const session = await fetch(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl } })
    const headers = { Cookie: session.headers.get('set-cookie')! }
    const path = `${baseUrl}/api/conversations/${conversation.id}/artifacts`
    expect((await fetch(path)).status).toBe(401)
    const list = await fetch(path, { headers }).then(response => response.json())
    expect(list).toContainEqual(expect.objectContaining({ path: 'plan.txt', workspaceState: 'isolated' }))
    const content = await fetch(`${path}/content?${new URLSearchParams({ path: 'plan.txt', runId: run.id })}`, { headers }).then(response => response.json())
    expect(content).toMatchObject({ content: 'Saved plan', workspaceState: 'isolated' })
    expect((await fetch(`${path}/content?${new URLSearchParams({ path: '../config.json', runId: run.id })}`, { headers })).status).toBe(404)
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
