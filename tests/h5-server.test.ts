import { createServer, request as httpRequest } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalHost, getLocalNetworkIp, hostHeaderHostname, isAllowedH5Host, isLoopbackIp, H5Server, type RunHandle } from '../packages/server/src/index.js'
import { H5AuthStore } from '../packages/server/src/h5/auth.js'
import type { JarvisClient } from '../packages/server/src/jarvis/client.js'

const temporaryDirectories: string[] = []
type TestWebSocket = { on(event: 'open' | 'message' | 'error', listener: (value?: unknown) => void): void; send(value: string): void; close(): void }
const TestWebSocketConstructor = createRequire(import.meta.url)('../packages/server/node_modules/ws') as new (url: string, options: { headers: Record<string, string> }) => TestWebSocket

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('H5 Network & IP detection', () => {
  it('detects a non-empty IP address', () => {
    const ip = getLocalNetworkIp()
    expect(typeof ip).toBe('string')
    expect(ip.length).toBeGreaterThan(0)
  })

  it('correctly identifies loopback addresses', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true)
    expect(isLoopbackIp('::1')).toBe(true)
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackIp('localhost')).toBe(true)
    expect(isLoopbackIp('192.168.1.10')).toBe(false)
    expect(isLoopbackIp(undefined)).toBe(false)
  })

  it('accepts only localhost and addresses assigned to this machine', () => {
    expect(hostHeaderHostname('127.0.0.1:7331')).toBe('127.0.0.1')
    expect(hostHeaderHostname('[::1]:7331')).toBe('::1')
    expect(isAllowedH5Host('127.0.0.1:7331')).toBe(true)
    expect(isAllowedH5Host('[::1]:7331')).toBe(true)
    expect(isAllowedH5Host('localhost')).toBe(true)
    expect(isAllowedH5Host('10.evil.example')).toBe(false)
    expect(isAllowedH5Host('192.168.attacker.test')).toBe(false)
    expect(isAllowedH5Host('172.evil.example')).toBe(false)
    expect(isAllowedH5Host(undefined)).toBe(false)
    const lan = getLocalNetworkIp()
    if (lan !== '127.0.0.1') expect(isAllowedH5Host(lan)).toBe(true)
  })
})

describe('H5AuthStore', () => {
  it('handles pairing code generation and single-use consumption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-auth-test-'))
    temporaryDirectories.push(dir)
    const auth = new H5AuthStore(dir)
    await auth.init()

    const codeInfo = auth.createPairingCode()
    expect(codeInfo.code).toHaveLength(8)
    expect(codeInfo.expiresAt).toBeGreaterThan(Date.now())

    // Invalid code fails
    const invalid = await auth.pairDeviceWithCode('wrongcode', 'Test Phone')
    expect(invalid).toBeUndefined()

    // Valid code succeeds
    const paired = await auth.pairDeviceWithCode(codeInfo.code, 'My iPhone')
    expect(paired).toBeDefined()
    expect(paired?.token).toBeDefined()
    expect(paired?.device.name).toBe('My iPhone')

    // Single-use: same code fails on second attempt
    const reused = await auth.pairDeviceWithCode(codeInfo.code, 'Another Phone')
    expect(reused).toBeUndefined()

    // Token authenticates
    const device = await auth.authenticateToken(paired?.token)
    expect(device?.id).toBe(paired?.device.id)

    // Revocation works
    const revoked = await auth.revokeDevice(paired!.device.id)
    expect(revoked).toBe(true)
    const afterRevoke = await auth.authenticateToken(paired?.token)
    expect(afterRevoke).toBeUndefined()
  })
})

describe('H5Server End-to-End', () => {
  it('answers assistant chats directly without a task verifier and bounds long chat history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-assistant-direct-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({
      cwd: dir,
      dataDir: dir,
      provider: { provider: 'mock', defaultModel: 'mock' },
      providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } },
      providerModels: { mock: { provider: 'mock', model: 'mock' } },
      activeModel: 'mock',
      assistantModel: 'mock',
      mockResponse: '聊天已就绪',
    })
    try {
      await host.init()
      const conversation = await host.createConversation({ title: 'Pulse 助理' })
      for (let index = 0; index < 32; index++) {
        await host.appendAssistantUserMessage(conversation.id, {
          id: `history-${index}`,
          runId: `history-run-${index}`,
          text: `旧对话 ${index} ${'历史内容。'.repeat(180)}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        })
      }

      const run = await host.sendMessage(conversation.id, { text: '简单回复即可。', assistantChat: true })
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: '聊天已就绪' })
      await expect(run.taskOutcome()).resolves.toBeUndefined()

      const runtime = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')) as { state?: { state?: { effects?: Array<[string, { kind?: string }]> } } }
      expect(runtime.state?.state?.effects?.filter(([, effect]) => effect.kind === 'llm')).toHaveLength(1)
      const outcome = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', run.id, 'outcome.json'), 'utf8')) as { taskOutcome?: unknown }
      expect(outcome.taskOutcome).toBeUndefined()
    } finally {
      await host.close()
    }
  })

  it('exposes Jarvis context as a real tool in direct assistant chat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-assistant-jarvis-'))
    temporaryDirectories.push(dir)
    let queried = ''
    const jarvisClient = {
      openSession: async () => ({ id: 'jarvis-session-test', projectId: 'unassigned', workspace: dir }),
      buildContext: async (_sessionId: string, query: string) => {
        queried = query
        return { session: { id: 'jarvis-session-test', projectId: 'unassigned', workspace: dir }, text: '仅供本轮参考的 Jarvis 测试上下文。', memories: [], recentEvents: [] }
      },
    } as unknown as JarvisClient
    const host = createLocalHost({
      cwd: dir,
      dataDir: dir,
      provider: { provider: 'mock', defaultModel: 'mock' },
      providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } },
      providerModels: { mock: { provider: 'mock', model: 'mock' } },
      activeModel: 'mock',
      assistantModel: 'mock',
      jarvisClient,
      mockToolCalls: [{ name: 'jarvis.context', input: { query: 'Pulse 助理工作模式', scope: 'global' } }],
      mockAfterToolResponse: '已完成 Jarvis 查询。',
    })
    try {
      await host.init()
      const conversation = await host.createConversation({ title: 'Pulse 助理' })
      const run = await host.sendMessage(conversation.id, { text: '请调用 jarvis.context 查询 Pulse 助理工作模式。', assistantChat: true })
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: '已完成 Jarvis 查询。' })
      expect(queried).toBe('Pulse 助理工作模式')
      await expect(run.taskOutcome()).resolves.toBeUndefined()
      const runtime = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')) as any
      const effects = runtime.state?.state?.effects ?? []
      expect(effects.filter(([, effect]) => effect.kind === 'tool' && effect.input?.name === 'jarvis.context')).toHaveLength(1)
      const modelEffects = effects.filter(([, effect]) => effect.kind === 'llm').map(([, effect]) => effect)
      const lastModel = modelEffects.at(-1)
      expect((lastModel?.input?.inputs?.conversation ?? lastModel?.input?.request?.contextSpec?.conversation)?.some(message => message.content?.includes('already been called'))).toBe(true)
      expect(lastModel?.input?.toolDiscovery?.exclude).toContain('jarvis.context')
      expect(lastModel?.input?.tools?.tools?.some((tool: { name: string }) => tool.name === 'jarvis.context')).toBe(false)
      const providerHistory = lastModel?.input?.request?.contextSpec?.providerHistory as Array<{ role: string; name?: string; content?: string }> | undefined
      expect(providerHistory?.some(message => message.role === 'tool' && message.name === 'jarvis.context')).toBe(true)
      expect(providerHistory?.some(message => message.content?.includes('Runtime recovery notice'))).toBe(false)
    } finally {
      await host.close()
    }
  })

  it.each([false, true])('validates concise Jarvis memory writes in assistant chat (overlong: %s)', async (overlong) => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-assistant-remember-'))
    temporaryDirectories.push(dir)
    const rule = overlong ? '长'.repeat(361) : '来源不完整或项目归属不明确时，不得自动提升候选。'
    const candidates: any[] = []
    const evidence: string[] = []
    const jarvisClient = {
      redactText: (text: string) => text,
      openSession: async () => ({ id: 'session-remember', projectId: 'unassigned', workspace: dir }),
      buildContext: async () => ({ session: { projectId: 'unassigned' }, text: '' }),
      recordEvent: async (_session: string, _type: string, content: string) => { evidence.push(content); return { id: 'event-user-rule' } },
      recordCandidate: async (_session: string, input: any) => { candidates.push(input); return { id: 'memory-rule', status: 'candidate' } },
    } as unknown as JarvisClient
    const host = createLocalHost({ cwd: dir, dataDir: dir, jarvisClient, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', approvalMode: 'auto',
      mockToolCalls: [{ name: 'jarvis.remember', input: { title: '审核条件', content: rule, kind: 'constraint', scope: 'global' } }], mockAfterToolResponse: '已提交待审核。' })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: `请调用 jarvis.remember 记住这条规则：${rule}`, assistantChat: true })
      await run.outcome()
      await host.close() // Wait for the durable outbox to finish delivery.
      if (overlong) expect(candidates).toEqual([])
      else {
        expect(candidates).toHaveLength(1)
        expect(candidates[0]).toMatchObject({ content: rule, sourceRefs: ['event-user-rule'] })
        expect(evidence.join('\n')).toContain(rule)
      }
      const saved = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')) as any
      const model = saved.state.state.effects.find(([, effect]: any) => effect.kind === 'llm')[1]
      expect(JSON.stringify(model.input)).toContain('one reusable conclusion with necessary conditions')
    } finally { await host.close() }
  })

  it('lets direct assistant chat read workspace files without exposing write or shell tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-assistant-readonly-'))
    temporaryDirectories.push(dir)
    await writeFile(join(dir, 'notes.txt'), 'workspace reference')
    const host = createLocalHost({
      cwd: dir,
      dataDir: dir,
      provider: { provider: 'mock', defaultModel: 'mock' },
      providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } },
      providerModels: { mock: { provider: 'mock', model: 'mock' } },
      activeModel: 'mock',
      assistantModel: 'mock',
      mockToolCalls: [{ name: 'fs.read', input: { path: 'notes.txt' } }],
      mockAfterToolResponse: '文件内容是 workspace reference。',
    })
    try {
      await host.init()
      const conversation = await host.createConversation({ title: 'Pulse 助理' })
      const run = await host.sendMessage(conversation.id, { text: '读取 notes.txt 并告诉我内容。', assistantChat: true })
      await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded', text: '文件内容是 workspace reference。' })
      const runtime = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')) as { state?: { state?: { effects?: Array<[string, { kind?: string; input?: { name?: string } }]> } } }
      const effects = runtime.state?.state?.effects ?? []
      expect(effects.filter(([, effect]) => effect.kind === 'tool').map(([, effect]) => effect.input?.name)).toContain('fs.read')
      const modelEffects = effects.filter(([, effect]) => effect.kind === 'llm').map(([, effect]) => effect)
      const exposedTools = modelEffects.flatMap(effect => (effect.input as { tools?: { tools?: Array<{ name: string }> } } | undefined)?.tools?.tools?.map(tool => tool.name) ?? [])
      expect(exposedTools).toContain('fs.read')
      expect(exposedTools).not.toContain('fs.write')
      expect(exposedTools).not.toContain('shell.exec')
    } finally {
      await host.close()
    }
  })

  it('serves deep page entries and resolves archived conversation metadata with authentication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-routes-test-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ dataDir: dir, cwd: dir, jarvis: { enabled: false } })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const base = `http://127.0.0.1:${info.port}`
    try {
      for (const page of ['/chat', '/work', '/work/new?project=sample', '/work/conv-sample?workspace=files&file=README.md', '/settings', '/settings/models', '/settings/not-found', '/archive', '/pair']) {
        const response = await fetch(base + page)
        expect(response.status, page).toBe(200)
        expect(response.headers.get('content-type'), page).toContain('text/html')
        expect(await response.text(), page).toContain('<div id="root"></div>')
      }
      for (const path of ['/assets/missing.js', '/api/no-such-route', '/preview/00000000-0000-0000-0000-000000000000/']) {
        const response = await fetch(base + path)
        expect(response.status, path).not.toBe(200)
        expect(response.headers.get('content-type') ?? '', path).not.toContain('text/html')
      }
      const conversation = await host.createConversation({ title: 'Deep-linked archive', projectId: null })
      await host.updateConversationOrganization(conversation.id, { archivedAt: new Date().toISOString() })
      const path = `${base}/api/conversations/${conversation.id}`
      expect((await fetch(path)).status).toBe(401)
      const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
      const cookie = local.headers.get('set-cookie')!
      const response = await fetch(path, { headers: { Cookie: cookie } })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ id: conversation.id, title: 'Deep-linked archive', archivedAt: expect.any(String) })
      const missing = await fetch(base + '/api/conversations/conv-missing', { headers: { Cookie: cookie } })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: 'CONVERSATION_NOT_FOUND' })
    } finally { await server.stop(); await host.close() }
  })

  it('serves pair page, handles pairing, and authorizes conversation endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-test-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ dataDir: dir, cwd: dir, jarvis: { enabled: false } })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    const started = Date.now()
    const checkpoint = (phase: string) => { if (process.env.CI) console.info(`[H5 pairing] ${Date.now() - started}ms ${phase}`) }
    const request = async (url: string, init?: RequestInit) => {
      const phase = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
      checkpoint(`start ${phase}`)
      const response = await fetch(url, init)
      checkpoint(`response ${response.status} ${phase}`)
      return response
    }

    try {
      // 1. Check local /pair dashboard
      const pairRes = await request(`${baseUrl}/pair`)
      expect(pairRes.status).toBe(200)
      const pairHtml = await pairRes.text()
      expect(pairHtml).toContain('<div id="root"></div>')

      // 2. Mobile HTML entry /
      const chatRes = await request(`${baseUrl}/`)
      expect(chatRes.status).toBe(200)
      const chatHtml = await chatRes.text()
      expect(chatHtml).toContain('<div id="root"></div>')

      const rejectedLocalOrigin = await request(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: 'http://evil.example' } })
      expect(rejectedLocalOrigin.status).toBe(403)
      const localSession = await request(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl } })
      expect(localSession.status).toBe(200)
      expect(localSession.headers.get('set-cookie')).toContain('SameSite=Strict')
      const localCookie = localSession.headers.get('set-cookie')!
      const repeatedLocalSession = await request(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl, Cookie: localCookie } })
      expect(await repeatedLocalSession.json()).toEqual(await localSession.clone().json())
      const webHistory = await request(`${baseUrl}/api/conversations`, { headers: { Cookie: localCookie } })
      expect(webHistory.status).toBe(200)
      const assistantHistory = await request(`${baseUrl}/api/assistant`, { headers: { Cookie: localCookie } })
      expect(assistantHistory.status).toBe(200)
      const assistantView = await assistantHistory.json() as { conversation: { id: string; kind: string }; messages: Array<{ id: string; role: string }> }
      expect(assistantView.conversation.kind).toBe('assistant')
      expect((await webHistory.json() as Array<{ id: string }>).some(item => item.id === assistantView.conversation.id)).toBe(false)
      const assistantRequest = { requestId: 'assistant-request-0001', text: '你好，Pulse' }
      const acceptedAssistant = await request(`${baseUrl}/api/assistant/messages`, { method: 'POST', headers: { Cookie: localCookie, Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify(assistantRequest) })
      expect(acceptedAssistant.status).toBe(202)
      const acceptedBody = await acceptedAssistant.json() as { runId: string; state: string }
      expect(acceptedBody.runId).toMatch(/^run-/)
      const duplicateAssistant = await request(`${baseUrl}/api/assistant/messages`, { method: 'POST', headers: { Cookie: localCookie, Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify(assistantRequest) })
      expect(duplicateAssistant.status).toBe(202)
      expect(await duplicateAssistant.json()).toMatchObject({ runId: acceptedBody.runId, duplicate: true })
      const queuedAssistant = await request(`${baseUrl}/api/assistant/messages`, { method: 'POST', headers: { Cookie: localCookie, Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'assistant-request-0002', text: '第二条排队消息' }) })
      expect(queuedAssistant.status).toBe(202)
      const assistantAfterSend = await request(`${baseUrl}/api/assistant`, { headers: { Cookie: localCookie } }).then(response => response.json()) as { messages: Array<{ id: string; role: string }> }
      expect(assistantAfterSend.messages.filter(message => message.id === 'msg-assistant-request-0001')).toHaveLength(1)
      expect(assistantAfterSend.messages.filter(message => message.id === 'msg-assistant-request-0002')).toHaveLength(1)

      // 3. Unauthorized access to /api/conversations gives 401
      const unauth = await request(`${baseUrl}/api/conversations`)
      expect(unauth.status).toBe(401)

      // 4. Pair device using active code
      const pairCodeInfo = server.createPairingCode()
      const pairReq = await request(`${baseUrl}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairCodeInfo.code, name: 'Test Client' }),
      })
      expect(pairReq.status).toBe(200)
      const pairData = await pairReq.json()
      expect(pairData.ok).toBe(true)
      expect(pairData.token).toBeUndefined()
      const cookie = pairReq.headers.get('set-cookie')
      expect(cookie).toContain('pulse_device=')
      expect(cookie).toContain('HttpOnly')

      // 5. Authorized access using cookie
      const convListRes = await request(`${baseUrl}/api/conversations`, {
        headers: { Cookie: cookie! },
      })
      expect(convListRes.status).toBe(200)
      const conversations = await convListRes.json()
      expect(Array.isArray(conversations)).toBe(true)

      // 6. Create conversation
      const createConvRes = await request(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
      expect(createConvRes.status).toBe(200)
      const createdConv = await createConvRes.json()
      expect(createdConv.title).toBe('Test Chat')

      // 7. Get messages of created conversation
      const msgsRes = await request(`${baseUrl}/api/conversations/${createdConv.id}/messages`, {
        headers: { Cookie: cookie! },
      })
      expect(msgsRes.status).toBe(200)
      const msgs = await msgsRes.json()
      expect(Array.isArray(msgs)).toBe(true)

      const renamed = await request(`${baseUrl}/api/conversations/${createdConv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ title: 'Renamed Chat' }),
      })
      expect(renamed.status).toBe(200)
      expect(await renamed.json()).toMatchObject({ id: createdConv.id, title: 'Renamed Chat' })

      const deleted = await request(`${baseUrl}/api/conversations/${createdConv.id}`, { method: 'DELETE', headers: { Cookie: cookie! } })
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ ok: true })

      const rejectedHost = await rawRequest(info.port, '/api/pair/qr', { host: '10.evil.example' })
      expect(rejectedHost.status).toBe(400)
      expect(rejectedHost.body).toContain('INVALID_HOST')

      const rejectedCwd = await request(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ title: 'Elsewhere', cwd: '/tmp' }),
      })
      expect(rejectedCwd.status).toBe(400)
      expect(await rejectedCwd.json()).toMatchObject({ error: 'CWD_NOT_ALLOWED' })
    } finally {
      checkpoint("stop server")
      await server.stop()
      checkpoint("close host")
      await host.close()
      checkpoint("closed")
    }
  }, process.platform === 'win32' ? 120_000 : 30_000)

  it('protects editable config, project files, and local terminal sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-workbench-'))
    temporaryDirectories.push(dir)
    const projectDir = join(dir, 'project')
    await mkdir(projectDir)
    await writeFile(join(projectDir, 'note.txt'), 'project file')
    const outsideFile = join(dir, 'outside.txt')
    await writeFile(outsideFile, 'outside workspace')
    await symlink(outsideFile, join(projectDir, 'escape.txt'))
    const configPath = join(dir, 'config.json')
    const originalConfig = { jarvis: { token: 'jarvis-secret' }, capabilities: { mcpServers: { demo: { env: { ACCESS_TOKEN: 'mcp-secret' } } } }, customField: { kept: true } }
    await writeFile(configPath, JSON.stringify(originalConfig), { mode: 0o600 })
    const host = createLocalHost({ cwd: dir, dataDir: dir })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1', configuration: { path: configPath, prepare: async candidate => {
      const value = JSON.parse(await readFile(candidate, 'utf8')) as Record<string, unknown>
      if (value.invalid === true) throw new Error('CONFIG_INVALID_TEST')
      return { cwd: dir, dataDir: dir }
    } } })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    let previewServer: ReturnType<typeof createServer> | undefined
    try {
      const localSession = await fetch(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl } })
      const localCookie = localSession.headers.get('set-cookie') ?? ''
      const localHeaders = { Cookie: localCookie, Origin: baseUrl, 'Content-Type': 'application/json' }

      const paired = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Paired phone' }) })
      const pairedCookie = paired.headers.get('set-cookie') ?? ''
      expect((await fetch(`${baseUrl}/api/config`, { headers: { Cookie: pairedCookie } })).status).toBe(403)
      expect((await fetch(`${baseUrl}/api/terminals`, { headers: { Cookie: pairedCookie } })).status).toBe(403)

      const config = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: localCookie } }).then(response => response.json()) as { path: string; version: string; config: Record<string, any> }
      expect(config.path).toBe(configPath)
      expect(config.config.jarvis.token).toBe('__PULSE_KEEP_SECRET__')
      expect(config.config.capabilities.mcpServers.demo.env.ACCESS_TOKEN).toBe('__PULSE_KEEP_SECRET__')
      const candidate = structuredClone(config.config)
      candidate.customField = { kept: false }
      const validation = await fetch(`${baseUrl}/api/config/validate`, { method: 'POST', headers: localHeaders, body: JSON.stringify({ config: candidate }) })
      expect(validation.status).toBe(200)
      const saved = await fetch(`${baseUrl}/api/config`, { method: 'PUT', headers: localHeaders, body: JSON.stringify({ version: config.version, config: candidate }) })
      expect(saved.status).toBe(200)
      const savedConfig = JSON.parse(await readFile(configPath, 'utf8')) as typeof originalConfig & { customField: { kept: boolean } }
      expect(savedConfig.jarvis.token).toBe('jarvis-secret')
      expect(savedConfig.capabilities.mcpServers.demo.env.ACCESS_TOKEN).toBe('mcp-secret')
      expect(savedConfig.customField.kept).toBe(false)
      expect(JSON.parse(await readFile(`${configPath}.bak`, 'utf8'))).toEqual(originalConfig)
      // Windows file modes do not represent NTFS ACL permissions.
      if (process.platform !== 'win32') expect((await lstat(`${configPath}.bak`)).mode & 0o777).toBe(0o600)
      const conflict = await fetch(`${baseUrl}/api/config`, { method: 'PUT', headers: localHeaders, body: JSON.stringify({ version: config.version, config: candidate }) })
      expect(conflict.status).toBe(409)
      const invalid = await fetch(`${baseUrl}/api/config/validate`, { method: 'POST', headers: localHeaders, body: JSON.stringify({ config: { invalid: true } }) })
      expect(invalid.status).toBe(400)
      expect(JSON.parse(await readFile(configPath, 'utf8')).invalid).toBeUndefined()

      const added = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: localHeaders, body: JSON.stringify({ name: '项目 A', cwd: projectDir }) })
      expect(added.status).toBe(201)
      const project = await added.json() as { id: string; cwd: string }
      previewServer = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body>Preview</body></html>') })
      await new Promise<void>((resolve, reject) => { previewServer!.listen(0, '127.0.0.1', resolve); previewServer!.once('error', reject) })
      const previewPort = (previewServer.address() as { port: number }).port
      const previewRegistered = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: 'PATCH', headers: localHeaders, body: JSON.stringify({ previewUrl: `http://127.0.0.1:${previewPort}` }) })
      expect(previewRegistered.status).toBe(200)
      const ticket = await fetch(`${baseUrl}/api/projects/${project.id}/preview-ticket`, { method: 'POST', headers: localHeaders }).then(response => response.json()) as { url: string }
      const preview = await fetch(`${baseUrl}${ticket.url}`)
      expect(preview.headers.get('content-security-policy')).toContain(`ws://127.0.0.1:${info.port}`)
      expect(await preview.text()).toContain("u.pathname='/preview/'+ticket+'/__ws'")
      const conversation = await fetch(`${baseUrl}/api/conversations`, { method: 'POST', headers: { Cookie: localCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Project conversation', projectId: project.id }) }).then(response => response.json()) as { cwd: string; projectId: string }
      expect(conversation).toMatchObject({ cwd: project.cwd, projectId: project.id })
      const file = await fetch(`${baseUrl}/api/projects/${project.id}/file?path=note.txt`, { headers: { Cookie: localCookie } })
      expect(await file.json()).toMatchObject({ content: 'project file', binary: false })
      const traversal = await fetch(`${baseUrl}/api/projects/${project.id}/file?path=../outside.txt`, { headers: { Cookie: localCookie } })
      expect(traversal.status).toBe(403)
      const symlinkRead = await fetch(`${baseUrl}/api/projects/${project.id}/file?path=escape.txt`, { headers: { Cookie: localCookie } })
      expect(symlinkRead.status).toBe(403)

      expect((await fetch(`${baseUrl}/api/terminals`, { method: 'POST', headers: { Cookie: localCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }) })).status).toBe(403)
      const terminalResponse = await fetch(`${baseUrl}/api/terminals`, { method: 'POST', headers: localHeaders, body: JSON.stringify({ projectId: project.id }) })
      expect(terminalResponse.status).toBe(201)
      const terminal = await terminalResponse.json() as { id: string; projectId: string }
      expect(await fetch(`${baseUrl}/api/terminals?projectId=${project.id}`, { headers: { Cookie: localCookie } }).then(response => response.json())).toMatchObject([{ id: terminal.id, projectId: project.id }])
      await new Promise<void>((resolve, reject) => {
        const ws = new TestWebSocketConstructor(`ws://127.0.0.1:${info.port}/api/terminals/${terminal.id}/socket`, { headers: { Cookie: localCookie.split(';')[0]!, Origin: baseUrl } })
        let snapshotReceived = false
        let output = ''
        const timeout = setTimeout(() => { ws.close(); reject(new Error('TERMINAL_OUTPUT_TIMEOUT')) }, 4_000)
        ws.on('message', raw => {
          const message = JSON.parse(String(raw)) as { type?: string; data?: string }
          // Split the marker so terminal echo cannot satisfy the execution check.
          const command = `node -e "console.log('PULSE_TERMINAL_'+'TEST_OK')"\r`
          if (message.type === 'snapshot' && !snapshotReceived) { snapshotReceived = true; ws.send(JSON.stringify({ type: 'input', data: command })) }
          else if (message.type === 'output') output += message.data ?? ''
          if (output.includes('PULSE_TERMINAL_TEST_OK')) { clearTimeout(timeout); ws.close(); resolve() }
        })
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('TERMINAL_SOCKET_FAILED')) })
      })
      expect((await fetch(`${baseUrl}/api/terminals/${terminal.id}`, { method: 'DELETE', headers: { Cookie: localCookie, Origin: baseUrl } })).status).toBe(200)
    } finally {
      if (previewServer?.listening) await new Promise<void>(resolve => previewServer!.close(() => resolve()))
      await server.stop()
      await host.close()
    }
  })

  it('replays assistant text and completion events to a late SSE subscriber', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-sse-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockResponse: '手机上能看到回答' })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const code = server.createPairingCode().code
      const paired = await fetch(`${baseUrl}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name: 'SSE Phone' }),
      })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const created = await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'SSE' }),
      })
      const conversation = await created.json() as { id: string }
      const sent = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ text: '你好' }),
      })
      expect(sent.status).toBe(200)
      const { runId } = await sent.json() as { runId: string }
      const events = await readSse(`${baseUrl}/api/runs/${runId}/events`, cookie)
      expect(events.some((event) => event.type === 'text' && event.data === '手机上能看到回答')).toBe(true)
      expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
      expect(events.some((event) => ['delta', 'fact', 'observation'].includes(event.type ?? ''))).toBe(false)
      expect(events.some((event) => event.type === 'run_finished')).toBe(true)
      expect(events.every((event) => event.conversationId === conversation.id)).toBe(true)
      const snapshot = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } })
      expect(await snapshot.json()).toMatchObject({ runId, state: 'succeeded' })
      const staleStop = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: 'POST', headers: { Cookie: cookie } })
      expect(staleStop.status).toBe(404)
    } finally {
      await server.stop()
      await host.close()
    }
  })

  it.each([true, false])('only projects assistant-origin work into chat (assistant origin: %s)', async assistantOrigin => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-assistant-work-interaction-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockToolCalls: [
      { name: 'ask.choice', input: { prompt: 'Choose a mode', options: ['safe', 'fast'] } },
    ] })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const pair = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Assistant interaction test' }) })
      const cookie = pair.headers.get('set-cookie') ?? ''
      const conversation = assistantOrigin
        ? await host.createConversation({ title: 'Work needs an answer', origin: 'assistant' })
        : await fetch(`${baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Work needs an answer', origin: 'assistant' }) }).then(response => response.json()) as { id: string }
      // The public creation API cannot spoof the trusted chat-origin marker.
      expect((await host.getConversation(conversation.id)).summary.origin).toBe(assistantOrigin ? 'assistant' : undefined)
      const sent = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: 'Start work and ask me a question.' }) })
      const { runId } = await sent.json() as { runId: string }
      const snapshot = await vi.waitFor(async () => {
        const snapshot = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { interactions?: unknown[] }
        expect(snapshot.interactions?.length).toBeGreaterThan(0)
        return snapshot
      }, { timeout: 5_000, interval: 25 })
      const assistant = await fetch(`${baseUrl}/api/assistant`, { headers: { Cookie: cookie } }).then(response => response.json()) as { messages: Array<{ id: string; work?: { conversationId: string; title: string; state: string } }>; workInteractions: Array<{ runId: string; conversationId: string; title: string; approvalPolicy: string; kind: string; items: Array<{ input: Record<string, unknown> }> }> }
      if (assistantOrigin) {
        expect(assistant.workInteractions).toEqual([expect.objectContaining({ runId, conversationId: conversation.id, title: 'Start work and ask me a question.', approvalPolicy: 'manual', kind: 'ask', items: [expect.objectContaining({ input: expect.objectContaining({ prompt: 'Choose a mode' }) })] })])
        expect(assistant.messages.find(message => message.id === `work-live-${runId}`)?.work).toMatchObject({ conversationId: conversation.id, state: 'waiting' })
      } else {
        expect(assistant.workInteractions).toEqual([])
        expect(assistant.messages.filter(message => message.work)).toEqual([])
      }
      const interaction = (snapshot.interactions as typeof assistant.workInteractions)[0]!
      const answer = await fetch(`${baseUrl}/api/runs/${runId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ conversationId: conversation.id, groupId: interaction.groupId, requestId: 'assistant-work-answer-0001', answers: [{ effectId: interaction.items[0]!.effectId, value: { value: 'safe' } }] }) })
      expect(await answer.json()).toMatchObject({ ok: true, duplicate: false })
      const events = await readSse(`${baseUrl}/api/runs/${runId}/events`, cookie)
      expect(events.some(event => event.type === 'complete' && (event.data as { status?: string })?.status === 'succeeded')).toBe(true)
      const finalState = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { state: string }
      expect(finalState.state).toBe('succeeded')
      if (!assistantOrigin) {
        const finished = await fetch(`${baseUrl}/api/assistant`, { headers: { Cookie: cookie } }).then(response => response.json()) as typeof assistant
        expect(finished.messages.filter(message => message.work)).toEqual([])
      }
    } finally {
      await server.stop()
      await host.close()
    }
  })

  it('keeps ask siblings in one pending group and records an idempotent batch reply receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-interaction-batch-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockToolCalls: [
      { name: 'ask.choice', input: { prompt: 'Choose a mode', options: ['safe', 'fast'] } },
      { name: 'ask.multi', input: { prompt: 'Optional additions', options: ['red', 'blue'], min: 0, max: 2 } },
    ], mockAfterToolResponse: '全部已收到' })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const pair = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Batch test' }) })
      const cookie = pair.headers.get('set-cookie') ?? ''
      const created = await fetch(`${baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Question batch' }) })
      const conversation = await created.json() as { id: string; approvalPolicy?: string }
      expect(conversation.approvalPolicy).toBe('manual')
      const sent = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: 'Ask me two questions' }) })
      const { runId } = await sent.json() as { runId: string }
      const snapshot = await vi.waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } })
        const value = await response.json() as { interactions?: Array<{ groupId: string; kind: string; items: Array<{ effectId: string; input: Record<string, unknown> }> }> }
        expect(value.interactions?.length).toBeGreaterThan(0)
        return value
      }, { timeout: 5_000, interval: 25 })
      const groups = snapshot.interactions!
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ kind: 'ask' })
      expect(groups[0]?.items).toHaveLength(2)
      expect(JSON.stringify(groups)).not.toContain('Digest')

      const policy = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ approvalPolicy: 'delegate' }) })
      expect(await policy.json()).toMatchObject({ approvalPolicy: 'delegate' })
      const requestId = 'batch-request-0001'
      const payload = { conversationId: conversation.id, groupId: groups[0]!.groupId, requestId, answers: [
        { effectId: groups[0]!.items[0]!.effectId, value: { value: 'safe' } },
        { effectId: groups[0]!.items[1]!.effectId, value: { values: [] } },
      ] }
      const partial = await fetch(`${baseUrl}/api/runs/${runId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ ...payload, answers: payload.answers.slice(0, 1) }) })
      expect(partial.status).toBe(400)
      expect(await partial.json()).toMatchObject({ error: 'INTERACTION_GROUP_MISMATCH' })
      const accepted = await fetch(`${baseUrl}/api/runs/${runId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(payload) })
      expect(await accepted.json()).toMatchObject({ ok: true, duplicate: false })
      const duplicate = await fetch(`${baseUrl}/api/runs/${runId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(payload) })
      expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true })
      const reused = await fetch(`${baseUrl}/api/runs/${runId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ ...payload, answers: [{ ...payload.answers[0]!, value: { value: 'fast' } }, payload.answers[1]] }) })
      expect(reused.status).toBe(409)
      const events = await readSse(`${baseUrl}/api/runs/${runId}/events`, cookie)
      expect(events.some(event => event.type === 'complete' && (event.data as { status?: string })?.status === 'succeeded')).toBe(true)
      expect((await host.getConversationMessages(conversation.id)).some(message => message.text === '全部已收到')).toBe(true)
      const runState = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { state: string }
      expect(runState.state).toBe('succeeded')
      const receipt = JSON.parse(await readFile(join(dir, 'conversations', conversation.id, 'runs', runId, 'interaction-receipts.json'), 'utf8')) as Record<string, unknown>
      expect(receipt[requestId]).toBeDefined()
    } finally {
      await server.stop()
      await host.close()
    }
  })

  it('uses the separate local approval reviewer for a delegated, in-workspace write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-delegate-approval-'))
    temporaryDirectories.push(dir)
    let reviewerCalls = 0
    let reviewerRequest: Record<string, unknown> | undefined
    const reviewer = createServer(async (req, res) => {
      reviewerCalls++
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      reviewerRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'APPROVE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 22, completion_tokens: 1, total_tokens: 23 } }))
    })
    await new Promise<void>((resolve, reject) => { reviewer.listen(0, '127.0.0.1', () => resolve()); reviewer.once('error', reject) })
    const reviewerPort = (reviewer.address() as { port: number }).port
    const host = createLocalHost({
      cwd: dir,
      dataDir: dir,
      approvalMode: 'ask',
      mockToolCalls: [{ name: 'fs.list', input: { path: '.' } }, { name: 'fs.write', input: { path: 'delegated.txt', content: 'approved by the test reviewer' } }],
      mockAfterToolResponse: '文件已写入。',
      approvalReview: { provider: 'ollama', model: 'qwen3.5:4b', baseURL: `http://127.0.0.1:${reviewerPort}`, timeoutMs: 2_000 },
    })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const paired = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Delegation test' }) })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const conversation = await host.createConversation({ title: 'Delegated approval' })
      const sent = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: 'Create delegated.txt with the exact requested content.' }) })
      const { runId } = await sent.json() as { runId: string }
      let pending = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { interactions?: Array<{ kind: string }> }
        if (snapshot.interactions?.some(item => item.kind === 'approval')) { pending = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(pending).toBe(true)
      const switched = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ approvalPolicy: 'delegate' }) })
      expect(await switched.json()).toMatchObject({ approvalPolicy: 'delegate' })
      for (let attempt = 0; attempt < 150; attempt++) {
        const messages = await host.getConversationMessages(conversation.id)
        if (messages.some(message => message.text === '文件已写入。')) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      let runState = ''
      for (let attempt = 0; attempt < 100; attempt++) {
        runState = (await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { state: string }).state
        if (runState === 'succeeded') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(runState).toBe('succeeded')
      expect(await readFile(join(dir, 'delegated.txt'), 'utf8')).toBe('approved by the test reviewer')
      expect(reviewerCalls).toBe(1)
      expect(reviewerRequest).toMatchObject({ reasoning_effort: 'none', max_tokens: 128 })
      expect(JSON.stringify(reviewerRequest?.messages)).toContain('Apply the authorization review above and respond with exactly APPROVE or HANDOFF.')
      expect(JSON.stringify(reviewerRequest?.messages)).not.toContain('fs.list')
      const audit = await readFile(join(dir, 'conversations', conversation.id, 'runs', runId, 'approval-reviews.jsonl'), 'utf8')
      expect(audit).toContain('"status":"approved"')
      expect(audit).toContain('"inputTokens":22')
    } finally {
      await server.stop()
      await host.close()
      await new Promise<void>(resolve => reviewer.close(() => resolve()))
    }
  })

  it.each([
    { name: 'keeps an operation pending when the reviewer does not explicitly approve', path: 'ordinary.txt', response: 'HANDOFF', expectedCalls: 1 },
    { name: 'keeps sensitive paths for the user without calling the reviewer', path: '.env', response: 'APPROVE', expectedCalls: 0 },
  ])('$name', async ({ path, response, expectedCalls }) => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-delegate-handoff-'))
    temporaryDirectories.push(dir)
    let reviewerCalls = 0
    const reviewer = createServer((_req, res) => {
      reviewerCalls++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: response }, finish_reason: 'stop' }] }))
    })
    await new Promise<void>((resolve, reject) => { reviewer.listen(0, '127.0.0.1', resolve); reviewer.once('error', reject) })
    const reviewerPort = (reviewer.address() as { port: number }).port
    const host = createLocalHost({
      cwd: dir,
      dataDir: dir,
      approvalMode: 'ask',
      mockToolCalls: [{ name: 'fs.write', input: { path, content: 'must remain pending' } }],
      approvalReview: { provider: 'ollama', model: 'qwen3.5:4b', baseURL: `http://127.0.0.1:${reviewerPort}`, timeoutMs: 2_000 },
    })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const paired = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Delegation handoff test' }) })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const conversation = await host.createConversation({ title: 'Manual handoff' })
      const sent = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: `Create ${path} only if the user explicitly authorizes it.` }) })
      const { runId } = await sent.json() as { runId: string }
      let groupId: string | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { interactions?: Array<{ kind: string; groupId: string }> }
        groupId = snapshot.interactions?.find(item => item.kind === 'approval')?.groupId
        if (groupId) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(groupId).toBeTruthy()
      await fetch(`${baseUrl}/api/conversations/${conversation.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ approvalPolicy: 'delegate' }) })
      let pending = false
      for (let attempt = 0; attempt < 150; attempt++) {
        const snapshot = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { interactions?: Array<{ groupId: string }>; reviewNote?: string }
        pending = snapshot.interactions?.some(item => item.groupId === groupId) === true && Boolean(snapshot.reviewNote)
        if (pending) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(pending).toBe(true)
      expect(reviewerCalls).toBe(expectedCalls)
      await expect(readFile(join(dir, path), 'utf8')).rejects.toThrow()
      await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: 'POST', headers: { Cookie: cookie } })
      let finalState = ''
      for (let attempt = 0; attempt < 150; attempt++) {
        finalState = (await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } }).then(response => response.json()) as { state: string }).state
        if (finalState === 'cancelled') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(finalState).toBe('cancelled')
    } finally {
      await server.stop()
      await host.close()
      await new Promise<void>(resolve => reviewer.close(() => resolve()))
    }
  })

  it('blocks deleting an active conversation and cancels its current run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-active-run-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockToolCalls: [{ name: 'fs.write', input: { path: 'held.txt', content: 'held' } }] })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const code = server.createPairingCode().code
      const paired = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Control Test' }) })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const created = await fetch(`${baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Active' }) })
      const conversation = await created.json() as { id: string }
      const sent = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: 'wait for approval' }) })
      const { runId } = await sent.json() as { runId: string }
      const reconcile = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/reconcile`, { method: 'POST', headers: { Cookie: cookie } })
      expect(reconcile.status).toBe(409)
      const deleted = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
      expect(deleted.status).toBe(409)
      const stopped = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: 'POST', headers: { Cookie: cookie } })
      expect(stopped.status).toBe(200)
      const events = await readSse(`${baseUrl}/api/runs/${runId}/events`, cookie)
      expect(events.some(event => event.type === 'run_finished' && event.conversationId === conversation.id)).toBe(true)
    } finally {
      await server.stop()
      await host.close()
    }
  })

  it('explicitly ends an interrupted run before allowing the next message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-interrupted-run-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir, mockResponse: '新消息已正常发送。' })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const code = server.createPairingCode().code
      const paired = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Recovery Test' }) })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const created = await host.createConversation({ title: 'Interrupted' })
      const runId = 'run-interrupted-without-outcome'
      const manifestPath = join(dir, 'conversations', created.id, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      manifest.activeRunId = runId
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

      const snapshot = await fetch(`${baseUrl}/api/runs/${runId}/state`, { headers: { Cookie: cookie } })
      expect(await snapshot.json()).toMatchObject({ runId, state: 'interrupted' })
      const reconciled = await fetch(`${baseUrl}/api/conversations/${created.id}/runs/${runId}/reconcile`, { method: 'POST', headers: { Cookie: cookie } })
      expect(reconciled.status).toBe(200)
      expect(await reconciled.json()).toEqual({ cleared: true })
      expect((await host.getConversation(created.id)).summary.activeRunId).toBeUndefined()

      const sent = await fetch(`${baseUrl}/api/conversations/${created.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ text: '继续这个会话' }) })
      expect(sent.status).toBe(200)
      const { runId: nextRunId } = await sent.json() as { runId: string }
      const events = await readSse(`${baseUrl}/api/runs/${nextRunId}/events`, cookie)
      expect(events.some(event => event.type === 'text' && event.data === '新消息已正常发送。')).toBe(true)
    } finally {
      await server.stop()
      await host.close()
    }
  })

  it('resumes an interrupted run only after an explicit request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-resume-run-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir })
    const conversation = await host.createConversation({ title: 'Interrupted' })
    const runId = 'run-explicit-resume'
    const manifestPath = join(dir, 'conversations', conversation.id, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.activeRunId = runId
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    const events = (async function* () {
      yield { schemaVersion: 1 as const, type: 'text' as const, conversationId: conversation.id, runId, seq: 1, data: '恢复后完成' }
      yield { schemaVersion: 1 as const, type: 'complete' as const, conversationId: conversation.id, runId, seq: 2, data: { status: 'succeeded' } }
    })()
    const handle = { id: runId, conversationId: conversation.id, events, outcome: async () => ({ status: 'succeeded' }) } as unknown as RunHandle
    host.resumeRun = async () => handle
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const code = server.createPairingCode().code
      const paired = await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Resume Test' }) })
      const cookie = paired.headers.get('set-cookie') ?? ''
      const resume = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/resume`, { method: 'POST', headers: { Cookie: cookie } })
      expect(resume.status).toBe(200)
      expect(await resume.json()).toEqual({ runId })
      const received = await readSse(`${baseUrl}/api/runs/${runId}/events`, cookie)
      expect(received.some(event => event.type === 'text' && event.data === '恢复后完成')).toBe(true)
      expect(received.some(event => event.type === 'complete')).toBe(true)
    } finally {
      await server.stop()
      await host.close()
    }
  })

  it('restores only an accepted archived answer and marks unrecoverable legacy replies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-web-history-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ cwd: dir, dataDir: dir })
    const conversation = await host.createConversation({ title: 'Archive' })
    const conversationDir = join(dir, 'conversations', conversation.id)
    const runId = 'run-accepted'
    const runDir = join(conversationDir, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(conversationDir, 'messages.jsonl'), [
      { id: 'old', role: 'assistant', text: '旧候选答案加验收报告', runId, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'unknown', role: 'assistant', text: '无法确认的旧回复', runId: 'run-missing', createdAt: '2026-01-01T00:00:01.000Z' },
    ].map(message => JSON.stringify(message)).join('\n') + '\n')
    await writeFile(join(runDir, 'outcome.json'), JSON.stringify({ taskOutcome: { status: 'accepted', candidateResultRef: 'result-verified' } }))
    await writeFile(join(runDir, 'runtime.json'), JSON.stringify({ state: { state: { results: [['result-verified', { value: { text: '已验收的最终答案\n\n---\n\n**阶段报告**\n内部验收说明\n任务逐项验收通过。' } }]] } } }))
    const history = await host.getWebConversationMessages(conversation.id)
    expect(history[0]).toMatchObject({ id: 'old', text: '已验收的最终答案', restored: true })
    expect(history[1]).toMatchObject({ id: 'unknown', text: '无法确认的旧回复', legacy: true })
    await host.close()
  })

  it('migrates legacy model configuration on save and preserves qualified selections after reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-model-catalog-'))
    temporaryDirectories.push(dir)
    const configPath = join(dir, 'config.json')
    const originalConfig = {
      providers: { deepseek: { provider: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com' } },
      models: { flash: { displayName: 'same', provider: 'deepseek', modelCode: 'deepseek-flash' } },
      activeModel: 'flash',
      assistantModel: 'flash',
      frontModel: { enabled: true, provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434' },
      approvalReview: { provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434' },
    }
    await writeFile(configPath, JSON.stringify(originalConfig), { mode: 0o600 })
    let preparedConfig: Record<string, any> | undefined
    const host = createLocalHost({ cwd: dir, dataDir: dir, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock' })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1', configuration: { path: configPath, prepare: async candidate => {
      preparedConfig = JSON.parse(await readFile(candidate, 'utf8')) as Record<string, any>
      return { cwd: dir, dataDir: dir }
    } } })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`
    try {
      const local = await fetch(`${baseUrl}/api/session/local`, { method: 'POST', headers: { Origin: baseUrl } })
      const cookie = local.headers.get('set-cookie') ?? ''
      const headers = { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' }
      const first = await fetch(`${baseUrl}/api/config`, { headers }).then(response => response.json()) as { version: string; config: Record<string, any> }
      expect(first.config.activeModel).toBe('deepseek/flash')
      expect(first.config.providers.deepseek.models.flash.modelCode).toBe('deepseek-flash')
      expect(first.config.providers.ollama.models['qwen3.5:4b'].modelCode).toBe('qwen3.5:4b')
      expect(first.config.frontModel).toEqual({ enabled: true, model: 'ollama/qwen3.5:4b' })
      expect(first.config.approvalReview).toEqual({ model: 'ollama/qwen3.5:4b' })

      const saved = await fetch(`${baseUrl}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ version: first.version, config: first.config }) })
      expect(saved.status).toBe(200)
      expect(preparedConfig).not.toHaveProperty('models')
      expect(preparedConfig?.activeModel).toBe('deepseek/flash')
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ activeModel: 'deepseek/flash', frontModel: { model: 'ollama/qwen3.5:4b' }, approvalReview: { model: 'ollama/qwen3.5:4b' } })
      expect(JSON.parse(await readFile(`${configPath}.bak`, 'utf8'))).toEqual(originalConfig)

      const reloaded = await fetch(`${baseUrl}/api/config`, { headers }).then(response => response.json()) as { config: Record<string, any> }
      expect(reloaded.config.providers.deepseek.models.flash.modelCode).toBe('deepseek-flash')
      expect(reloaded.config.activeModel).toBe('deepseek/flash')
    } finally {
      await server.stop()
      await host.close()
    }
  })
})

function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function readSse(url: string, cookie: string): Promise<Array<{ type?: string; data?: unknown }>> {
  const response = await fetch(url, { headers: { Cookie: cookie } })
  expect(response.status).toBe(200)
  const body = await response.text()
  return body.split('\n\n').flatMap((block) => {
    const line = block.split('\n').find((item) => item.startsWith('data: '))
    if (!line) return []
    return [JSON.parse(line.slice(6)) as { type?: string; data?: unknown }]
  })
}
