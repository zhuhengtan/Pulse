import { createServer, connect, type Server, type Socket } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { AutomationSessionManager } from './manager.js'
import { automationError } from './types.js'

export interface AutomationEndpoint { path: string; token: string }
export interface AutomationClient { request(method: string, args: unknown[], signal?: AbortSignal): Promise<any> }
export class LocalAutomationClient implements AutomationClient {
  constructor(private readonly manager: AutomationSessionManager) {}
  async request(method: string, args: any[], signal?: AbortSignal): Promise<any> {
    if (signal) { if (method === 'observe' || method === 'wait') args[2] = signal; if (method === 'command') args[4] = signal; if (method === 'act') args[6] = signal }
    if (!['list', 'open', 'observe', 'command', 'act', 'wait', 'control', 'closeOwner', 'releaseOwner'].includes(method)) throw automationError('AUTOMATION_METHOD_NOT_ALLOWED')
    return (this.manager[method as keyof AutomationSessionManager] as Function).apply(this.manager, args)
  }
}
export class RemoteAutomationClient implements AutomationClient {
  constructor(private readonly endpoint: AutomationEndpoint) {}
  request(method: string, args: unknown[], signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(automationError('AUTOMATION_CANCELLED')); return }
      const socket = connect(this.endpoint.path)
      let buffer = '', done = false
      const finish = (error?: Error, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(value) }
      const abort = () => finish(automationError('AUTOMATION_RESULT_UNKNOWN'))
      const timer = setTimeout(abort, method === 'wait' ? 1800000 : 90000)
      signal?.addEventListener('abort', abort, { once: true })
      socket.on('connect', () => socket.write(JSON.stringify({ token: this.endpoint.token, method, args }) + '\n'))
      socket.on('error', error => finish(error))
      socket.on('end', () => { if (!done) finish(automationError('AUTOMATION_BROKER_DISCONNECTED')) })
      socket.on('data', chunk => {
        buffer += chunk.toString()
        if (buffer.length > 8 * 1024 * 1024) { finish(automationError('AUTOMATION_FRAME_TOO_LARGE')); return }
        if (!buffer.includes('\n')) return
        try { const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); finish(response.error ? automationError(response.error) : undefined, response.result) } catch { finish(automationError('AUTOMATION_PROTOCOL_ERROR')) }
      })
    })
  }
}
export class AutomationBroker {
  private server: Server | undefined
  endpoint: AutomationEndpoint | undefined
  private starting: Promise<AutomationEndpoint> | undefined
  private readonly sockets = new Set<Socket>()
  constructor(private readonly manager: AutomationSessionManager, private readonly dataDir: string) {}
  start(): Promise<AutomationEndpoint> { return this.starting ??= this.startInternal().catch(error => { this.starting = undefined; throw error }) }
  private async startInternal(): Promise<AutomationEndpoint> {
    if (this.endpoint) return this.endpoint
    const token = randomBytes(32).toString('hex')
    const root = join('/tmp', 'pulse-auto-' + createHash('sha256').update(userInfo().username).digest('hex').slice(0,8))
    if (process.platform !== 'win32') await mkdir(root, { recursive: true, mode: 0o700 })
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\pulse-automation-${token.slice(0, 20)}` : join(root, `${token.slice(0, 12)}.sock`)
    const client = new LocalAutomationClient(this.manager)
    const server = this.server = createServer(socket => {
      this.sockets.add(socket)
      let buffer = '', processed = false
      const controller = new AbortController()
      socket.on('close', () => { this.sockets.delete(socket); controller.abort() })
      socket.on('error', () => controller.abort())
      socket.setTimeout(90000, () => socket.destroy())
      socket.on('data', chunk => {
        if (processed) return
        buffer += chunk.toString()
        if (buffer.length > 65536) { socket.destroy(); return }
        if (!buffer.includes('\n')) return
        processed = true
        void (async () => {
          try {
            const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
            if (request.token !== token || !Array.isArray(request.args)) throw automationError('AUTOMATION_UNAUTHORIZED')
            const args = request.args
            // Abort cancelled worker operations at the backend boundary.
            if (request.method === 'observe' || request.method === 'wait') args[2] = controller.signal
            if (request.method === 'wait') socket.setTimeout(1800000)
            if (request.method === 'command') args[4] = controller.signal
            if (request.method === 'act') args[6] = controller.signal
            const result = await client.request(request.method, args)
            socket.end(JSON.stringify({ result: result ?? null }) + '\n')
          } catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'AUTOMATION_FAILED' }) + '\n') }
        })()
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve() }) })
    if (process.platform !== 'win32') await chmod(path, 0o600)
    this.endpoint = { path, token }
    return this.endpoint
  }
  async close(): Promise<void> { for (const socket of this.sockets) socket.destroy(); await this.manager.suspend(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); if (this.endpoint && process.platform !== 'win32') await unlink(this.endpoint.path).catch(() => undefined); this.endpoint = undefined; this.starting = undefined }
}
