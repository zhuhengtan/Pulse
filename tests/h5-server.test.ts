import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalHost, getLocalNetworkIp, hostHeaderHostname, isAllowedH5Host, isLoopbackIp, H5Server } from '../packages/server/src/index.js'
import { H5AuthStore } from '../packages/server/src/h5/auth.js'

const temporaryDirectories: string[] = []

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
  it('serves pair page, handles pairing, and authorizes conversation endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-server-test-'))
    temporaryDirectories.push(dir)
    const host = createLocalHost({ dataDir: dir, root: dir })
    const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
    const info = await server.start()
    const baseUrl = `http://127.0.0.1:${info.port}`

    try {
      // 1. Check local /pair dashboard
      const pairRes = await fetch(`${baseUrl}/pair`)
      expect(pairRes.status).toBe(200)
      const pairHtml = await pairRes.text()
      expect(pairHtml).toContain('Pulse 个人助理 - 手机扫码配对')

      // 2. Mobile HTML entry /
      const chatRes = await fetch(`${baseUrl}/`)
      expect(chatRes.status).toBe(200)
      const chatHtml = await chatRes.text()
      expect(chatHtml).toContain('Pulse Assistant')
      expect(chatHtml).toContain("item.type === 'delta'")
      expect(chatHtml).toContain("item.type === 'waiting'")
      expect(chatHtml).not.toContain('assistant_turn')
      expect(chatHtml).not.toContain('effect_requested')

      // 3. Unauthorized access to /api/conversations gives 401
      const unauth = await fetch(`${baseUrl}/api/conversations`)
      expect(unauth.status).toBe(401)

      // 4. Pair device using active code
      const pairCodeInfo = server.createPairingCode()
      const pairReq = await fetch(`${baseUrl}/api/pair`, {
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
      const convListRes = await fetch(`${baseUrl}/api/conversations`, {
        headers: { Cookie: cookie! },
      })
      expect(convListRes.status).toBe(200)
      const conversations = await convListRes.json()
      expect(Array.isArray(conversations)).toBe(true)

      // 6. Create conversation
      const createConvRes = await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
      expect(createConvRes.status).toBe(200)
      const createdConv = await createConvRes.json()
      expect(createdConv.title).toBe('Test Chat')

      // 7. Get messages of created conversation
      const msgsRes = await fetch(`${baseUrl}/api/conversations/${createdConv.id}/messages`, {
        headers: { Cookie: cookie! },
      })
      expect(msgsRes.status).toBe(200)
      const msgs = await msgsRes.json()
      expect(Array.isArray(msgs)).toBe(true)

      const rejectedHost = await rawRequest(info.port, '/api/pair/qr', { host: '10.evil.example' })
      expect(rejectedHost.status).toBe(400)
      expect(rejectedHost.body).toContain('INVALID_HOST')

      const rejectedCwd = await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ title: 'Elsewhere', cwd: '/tmp' }),
      })
      expect(rejectedCwd.status).toBe(400)
      expect(await rejectedCwd.json()).toMatchObject({ error: 'CWD_NOT_ALLOWED' })
    } finally {
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
      expect(events.some((event) => event.type === 'run_finished')).toBe(true)
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
