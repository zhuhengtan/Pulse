import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import type { JsonValue } from '@hunterzhu/pulse-runtime'
import type { AssistantEvent, LocalHost, RunHandle } from '../index.js'
import { H5AuthStore } from './auth.js'
import { SleepInhibitor } from './caffeinate.js'
import { getLocalNetworkIp, isAllowedH5Host, isLoopbackIp } from './network.js'
import { renderMobileChatHtml, renderPairHtml } from './ui.js'

interface SseClient {
  res: ServerResponse
  sent: number
}

// Jarvis uses 7330 for its API and 7331 for MCP.
export const DEFAULT_H5_PORT = 7332

export interface H5ServerOptions {
  port?: number
  host?: string
  dataDir: string
}

export class H5Server {
  private readonly port: number
  private effectivePort: number
  private readonly hostAddress: string
  private readonly auth: H5AuthStore
  private readonly inhibitor = new SleepInhibitor()
  private server: Server | undefined = undefined
  private readonly activeRuns = new Map<string, RunHandle>()
  private readonly runEventBuffers = new Map<string, AssistantEvent[]>()
  private readonly runSseClients = new Map<string, Set<SseClient>>()
  private readonly bufferTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly host: LocalHost,
    options: H5ServerOptions
  ) {
    this.port = options.port ?? DEFAULT_H5_PORT
    this.effectivePort = this.port
    this.hostAddress = options.host ?? '0.0.0.0'
    this.auth = new H5AuthStore(options.dataDir)
  }

  async start(): Promise<{ port: number; lanIp: string; pairUrl: string }> {
    await this.auth.init()
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message !== 'INVALID_JSON' && message !== 'PAYLOAD_TOO_LARGE') {
          process.stderr.write(`h5 request failed: ${message}\n`)
        }
        if (!res.headersSent) {
          const status = message === 'PAYLOAD_TOO_LARGE' ? 413 : message === 'INVALID_JSON' ? 400 : 500
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: message === 'PAYLOAD_TOO_LARGE' || message === 'INVALID_JSON' ? message : 'INTERNAL_ERROR' }))
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(this.port, this.hostAddress, () => resolve())
      server.on('error', reject)
    })
    this.server = server

    const addr = server.address()
    this.effectivePort = typeof addr === 'object' && addr ? addr.port : this.port

    const lanIp = getLocalNetworkIp()
    const pairing = this.auth.createPairingCode()
    const pairUrl = `http://${lanIp}:${this.effectivePort}/?code=${pairing.code}`

    return { port: this.effectivePort, lanIp, pairUrl }
  }

  async stop(): Promise<void> {
    this.inhibitor.dispose()
    for (const timer of this.bufferTimers.values()) clearTimeout(timer)
    this.bufferTimers.clear()
    for (const clients of this.runSseClients.values()) {
      for (const client of clients) {
        try { if (!client.res.writableEnded) client.res.end() } catch { /* already closed */ }
      }
    }
    this.runSseClients.clear()
    this.runEventBuffers.clear()
    this.activeRuns.clear()
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
      this.server = undefined
    }
  }

  getLanIp(): string {
    return getLocalNetworkIp()
  }

  getPairUrl(code: string): string {
    const lanIp = this.getLanIp()
    return `http://${lanIp}:${this.effectivePort}/?code=${code}`
  }

  createPairingCode(): { code: string; pairUrl: string; expiresAt: number } {
    const info = this.auth.createPairingCode()
    return {
      code: info.code,
      pairUrl: this.getPairUrl(info.code),
      expiresAt: info.expiresAt,
    }
  }

  async listDevices() {
    return this.auth.listDevices()
  }

  async revokeDevice(id: string) {
    return this.auth.revokeDevice(id)
  }

  private parseCookies(req: IncomingMessage): Record<string, string> {
    const header = req.headers.cookie
    if (!header) return {}
    const out: Record<string, string> = {}
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k) out[k] = decodeURIComponent(v.join('='))
    }
    return out
  }

  private async parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1024 * 1024) {
          req.destroy()
          reject(new Error('PAYLOAD_TOO_LARGE'))
        }
      })
      req.on('end', () => {
        if (!data.trim()) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('INVALID_JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname
    const method = req.method ?? 'GET'
    const remoteIp = req.socket.remoteAddress
    const loopback = isLoopbackIp(remoteIp)

    const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
    if (!isAllowedH5Host(hostHeader)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'INVALID_HOST' }))
      return
    }

    // 1. Laptop-only pair management screen: /pair
    if (pathname === '/pair' && method === 'GET') {
      if (!loopback) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('403 Forbidden: 配对管理页面仅允许在当前电脑本机访问。')
        return
      }
      const lanIp = this.getLanIp()
      const pair = this.createPairingCode()
      const qrSvg = await QRCode.toString(pair.pairUrl, { type: 'svg', margin: 1 })
      const devices = await this.auth.listDevices()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderPairHtml(qrSvg, pair.pairUrl, pair.code, lanIp, this.effectivePort, devices))
      return
    }

    // 2. Mobile chat HTML entry: /
    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderMobileChatHtml())
      return
    }

    // 3. API: Pair exchange: POST /api/pair
    if (pathname === '/api/pair' && method === 'POST') {
      const body = await this.parseJsonBody(req)
      const code = typeof body.code === 'string' ? body.code : ''
      const name = typeof body.name === 'string' ? body.name : req.headers['user-agent'] ?? 'Mobile Device'
      const paired = await this.auth.pairDeviceWithCode(code, name)
      if (!paired) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'INVALID_OR_EXPIRED_PAIRING_CODE' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `pulse_device=${paired.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
      })
      res.end(JSON.stringify({ ok: true, deviceId: paired.device.id }))
      return
    }

    // 4. API: Local QR info for CLI: GET /api/pair/qr (Loopback only)
    if (pathname === '/api/pair/qr' && method === 'GET') {
      if (!loopback) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'LOOPBACK_ONLY' }))
        return
      }
      const lanIp = this.getLanIp()
      const pair = this.createPairingCode()
      const qrSvg = await QRCode.toString(pair.pairUrl, { type: 'svg', margin: 1 })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, lanIp, port: this.effectivePort, code: pair.code, pairUrl: pair.pairUrl, qrSvg, expiresAt: pair.expiresAt }))
      return
    }

    // 5. Auth gate for remaining /api/* endpoints
    const cookies = this.parseCookies(req)
    const authHeader = req.headers.authorization
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
    const token = cookies.pulse_device || bearer
    const authedDevice = await this.auth.authenticateToken(token)

    // Allow loopback access to manage devices without token
    if (!authedDevice && !(loopback && pathname.startsWith('/api/devices'))) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }))
      return
    }

    // 6. Devices management: GET /api/devices, POST /api/devices/:id/revoke
    if (pathname === '/api/devices' && method === 'GET') {
      const devices = await this.auth.listDevices()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(devices))
      return
    }

    const revokeMatch = pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/)
    if (revokeMatch && method === 'POST') {
      const deviceId = revokeMatch[1]
      if (deviceId) {
        const ok = await this.auth.revokeDevice(deviceId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok }))
        return
      }
    }

    // 7. Conversations: GET /api/conversations, POST /api/conversations
    if (pathname === '/api/conversations' && method === 'GET') {
      const list = await this.host.listConversations()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(list))
      return
    }

    if (pathname === '/api/conversations' && method === 'POST') {
      const body = await this.parseJsonBody(req)
      if (typeof body.cwd === 'string' && body.cwd.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'CWD_NOT_ALLOWED' }))
        return
      }
      const title = typeof body.title === 'string' ? body.title.slice(0, 80) : '新对话'
      const created = await this.host.createConversation({ title })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(created.summary))
      return
    }

    // 8. Messages: GET /api/conversations/:id/messages
    const messagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/)
    if (messagesMatch && method === 'GET') {
      const convId = messagesMatch[1]
      if (convId) {
        const msgs = await this.host.getConversationMessages(convId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(msgs))
        return
      }
    }

    // 9. Send message: POST /api/conversations/:id/messages
    if (messagesMatch && method === 'POST') {
      const convId = messagesMatch[1]
      if (convId) {
        const body = await this.parseJsonBody(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'MESSAGE_REQUIRED' }))
          return
        }

        const handle = await this.host.sendMessage(convId, { text })
        const runId = handle.id
        this.activeRuns.set(runId, handle)
        this.runEventBuffers.set(runId, [])
        this.runSseClients.set(runId, new Set())
        this.inhibitor.acquire()
        void this.consumeRun(runId, handle)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ runId }))
        return
      }
    }

    // 10. SSE: GET /api/runs/:id/events
    const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (runEventsMatch && method === 'GET') {
      const runId = runEventsMatch[1]
      if (runId) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.flushHeaders?.()

        const buffer = this.runEventBuffers.get(runId) ?? []
        const client: SseClient = { res, sent: 0 }
        const clients = this.runSseClients.get(runId)
        if (clients) {
          clients.add(client)
          this.flushClient(client, buffer, clients)
        } else {
          for (const event of buffer) {
            if (!this.writeSse(res, event)) break
            client.sent++
          }
        }
        if (!this.activeRuns.has(runId)) {
          this.writeSse(res, { type: 'run_finished', runId })
          try { res.end() } catch { /* already closed */ }
          clients?.delete(client)
          return
        }
        let live = clients
        if (!live) {
          live = new Set()
          this.runSseClients.set(runId, live)
        }
        live.add(client)
        this.flushClient(client, this.runEventBuffers.get(runId) ?? buffer, live)
        req.on('close', () => {
          live?.delete(client)
        })
        return
      }
    }

    // 11. Approval reply: POST /api/runs/:id/reply
    const runReplyMatch = pathname.match(/^\/api\/runs\/([^/]+)\/reply$/)
    if (runReplyMatch && method === 'POST') {
      const runId = runReplyMatch[1]
      const handle = runId ? this.activeRuns.get(runId) : undefined
      if (!handle) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'RUN_NOT_ACTIVE' }))
        return
      }
      const body = await this.parseJsonBody(req)
      const effectId = typeof body.effectId === 'string' ? body.effectId : ''
      const value = h5ReplyValue(body)
      if (!effectId || !value) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'REPLY_INVALID' }))
        return
      }
      await handle.reply(effectId, value)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // 12. Cancel run: POST /api/runs/:id/cancel
    const runCancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
    if (runCancelMatch && method === 'POST') {
      const runId = runCancelMatch[1]
      const handle = runId ? this.activeRuns.get(runId) : undefined
      if (handle) {
        await handle.cancel('USER_REQUESTED')
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'NOT_FOUND' }))
  }

  private async consumeRun(runId: string, handle: RunHandle): Promise<void> {
    try {
      for await (const event of handle.events) this.publish(runId, event)
    } finally {
      this.finishStream(runId)
      this.inhibitor.release()
    }
  }

  private publish(runId: string, event: AssistantEvent): void {
    const buffer = this.runEventBuffers.get(runId)
    if (!buffer) return
    buffer.push(event)
    const clients = this.runSseClients.get(runId)
    if (!clients) return
    for (const client of [...clients]) this.flushClient(client, buffer, clients)
  }

  private flushClient(client: SseClient, buffer: AssistantEvent[], clients: Set<SseClient>): void {
    while (client.sent < buffer.length) {
      if (client.res.writableEnded || client.res.destroyed) {
        clients.delete(client)
        return
      }
      const event = buffer[client.sent]
      if (!event) return
      if (!this.writeSse(client.res, event)) {
        clients.delete(client)
        return
      }
      client.sent++
    }
  }

  private finishStream(runId: string): void {
    const clients = this.runSseClients.get(runId)
    if (clients) {
      for (const client of clients) {
        if (client.res.writableEnded || client.res.destroyed) continue
        this.writeSse(client.res, { type: 'run_finished', runId })
        try { client.res.end() } catch { /* already closed */ }
      }
    }
    this.activeRuns.delete(runId)
    this.runSseClients.delete(runId)
    const existing = this.bufferTimers.get(runId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.runEventBuffers.delete(runId)
      this.bufferTimers.delete(runId)
    }, 60_000)
    timer.unref()
    this.bufferTimers.set(runId, timer)
  }

  private writeSse(res: ServerResponse, event: unknown): boolean {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      return true
    } catch {
      return false
    }
  }
}

function h5ReplyValue(body: Record<string, unknown>): JsonValue | undefined {
  if (typeof body.approved === 'boolean') {
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined
    return { approved: body.approved, ...(reason ? { reason } : {}) }
  }
  if (typeof body.text === 'string') return { text: body.text }
  if (typeof body.value === 'string' && body.value.length > 0) return { value: body.value }
  if (Array.isArray(body.values) && body.values.length > 0 && body.values.every((item) => typeof item === 'string')) {
    return { values: body.values }
  }
  return undefined
}
