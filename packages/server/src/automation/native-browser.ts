import { mkdir, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { automationError, type AutomationAction, type AutomationBackend, type BackendObservation } from './types.js'

/** Authenticated Electron host. No debugging port or executable page scripts cross this boundary. */
export class NativeBrowserHost {
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; cleanup(): void }>()
  constructor(private socket: WebSocket) {
    socket.on('message', raw => {
      let value: any
      try { value = JSON.parse(raw.toString()) } catch { socket.close(1003); return }
      if (!value || typeof value !== 'object' || typeof value.id !== 'string') { socket.close(1003); return }
      const request = this.pending.get(value.id)
      if (!request) return
      this.pending.delete(value.id); request.cleanup()
      if (value.error) request.reject(automationError(String(value.error).slice(0, 200)))
      else request.resolve(value.result)
    })
    socket.on('close', () => {
      for (const request of this.pending.values()) { request.cleanup(); request.reject(automationError('NATIVE_BROWSER_DISCONNECTED')) }
      this.pending.clear()
    })
    socket.on('error', () => socket.close())
  }
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (this.socket.readyState !== 1) return Promise.reject(automationError('NATIVE_BROWSER_DISCONNECTED'))
    if (signal?.aborted) return Promise.reject(automationError('AUTOMATION_CANCELLED'))
    if (this.pending.size >= 32) return Promise.reject(automationError('NATIVE_BROWSER_BUSY'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const abort = () => { this.pending.delete(id); cleanup(); reject(automationError('AUTOMATION_CANCELLED')); if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ method: 'cancel', params: { requestId: id } })) }
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(automationError('NATIVE_BROWSER_TIMEOUT')) }, 45000)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

export class NativeBrowserBackend implements AutomationBackend {
  private opened = false
  private closed = false
  constructor(private host: () => NativeBrowserHost | undefined, private id: string, private workspace: string, private profile: string, private policy: { allowNetwork: boolean; networkHosts?: string[] }) {}
  private async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    if (this.closed) throw automationError('AUTOMATION_SESSION_NOT_FOUND')
    const host = this.host()
    if (!host) throw automationError('NATIVE_BROWSER_DISCONNECTED')
    if (!this.opened) {
      const downloadDir = join(this.workspace, '.pulse', 'automation-downloads', this.id)
      await mkdir(downloadDir, { recursive: true })
      const path = relative(await realpath(this.workspace), await realpath(downloadDir))
      if (path.startsWith('..') || isAbsolute(path)) throw automationError('BROWSER_OUTPUT_OUTSIDE_WORKSPACE')
      await host.call('open', { id: this.id, profile: this.profile, downloadDir, ...this.policy }, signal); this.opened = true
    }
    return host.call(method, { id: this.id, ...params }, signal)
  }
  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (method === 'navigate' || method === 'newTab') {
      const value = String(params.url || 'about:blank')
      if (value !== 'about:blank') {
        let url: URL
        try { url = new URL(value) } catch { throw automationError('BROWSER_NETWORK_NOT_ALLOWED') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !this.policy.allowNetwork || this.policy.networkHosts && !this.policy.networkHosts.some(host => host.toLowerCase() === url.hostname.toLowerCase())) throw automationError('BROWSER_NETWORK_NOT_ALLOWED')
      }
    }
    if (method === 'upload') {
      if (!Array.isArray(params.files) || !params.files.every(file => typeof file === 'string')) throw automationError('INVALID_UPLOAD')
      const root = await realpath(this.workspace)
      params = { ...params, files: await Promise.all(params.files.map(async file => {
        const path = await realpath(resolve(root, file)), rel = relative(root, path)
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw automationError('UPLOAD_OUTSIDE_WORKSPACE')
        return path
      })) }
    }
    return this.request('command', { method, params }, signal) }
  async observe(signal?: AbortSignal): Promise<BackendObservation> { return this.request('observe', {}, signal) }
  async act(action: AutomationAction, observation: BackendObservation, signal?: AbortSignal): Promise<void> { await this.request('act', { action, geometry: observation.geometry }, signal) }
  async setControl(state: string, until?: number): Promise<void> { await this.request('control', { state, until }) }
  async release(): Promise<void> { if (this.opened && !this.closed) await this.request('release') }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.host()?.call('close', { id: this.id }).catch(() => undefined)
  }
}
