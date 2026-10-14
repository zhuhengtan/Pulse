import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { AutomationAction, AutomationBackend, BackendObservation } from './types.js'
import { automationError } from './types.js'

export class DesktopBackend implements AutomationBackend {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 0
  private handshake: Promise<void> | undefined
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  constructor(private readonly helperPath = resolve(import.meta.dirname, `../../native/${process.platform}-${process.arch}/pulse-desktop-helper` + (process.platform === 'win32' ? '.exe' : '')), private readonly displayId?: string) {}
  private start(): void {
    if (this.child) return
    if (!existsSync(this.helperPath)) throw automationError('DESKTOP_HELPER_NOT_INSTALLED:run pnpm desktop:build')
    const manifestPath = resolve(dirname(this.helperPath), 'manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.protocolVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw automationError('DESKTOP_HELPER_INCOMPATIBLE')
      for (const [name, hash] of Object.entries(manifest.hashes ?? {})) {
        if (!name.split('/').every(part => /^[a-zA-Z0-9_ .-]+$/.test(part) && part !== '.' && part !== '..') || createHash('sha256').update(readFileSync(resolve(dirname(this.helperPath), name))).digest('hex') !== hash) throw automationError('DESKTOP_HELPER_CHECKSUM_MISMATCH')
      }
    }
    const child = this.child = spawn(this.helperPath, [], { stdio: 'pipe', shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT, DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } })
    const fail = (error: Error) => { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); if (this.child === child) { this.child = undefined; this.handshake = undefined } }
    child.on('error', fail)
    child.on('exit', () => fail(automationError('DESKTOP_HELPER_EXITED')))
    child.stderr.on('data', () => undefined)
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.length > 8 * 1024 * 1024) { child.kill(); fail(automationError('DESKTOP_FRAME_TOO_LARGE')); return }
      try {
        const response = JSON.parse(line)
        const pending = this.pending.get(response.id)
        if (!pending) return
        this.pending.delete(response.id)
        if (response.error) pending.reject(automationError(String(response.error.message ?? response.error)))
        else pending.resolve(response.result)
      } catch { child.kill(); fail(automationError('DESKTOP_PROTOCOL_ERROR')) }
    })
  }
  async call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw automationError('AUTOMATION_CANCELLED')
    this.start()
    if (method !== 'hello') {
      await (this.handshake ??= this.call('hello', {}, signal).then(value => { if (value.protocolVersion !== 1) throw automationError('DESKTOP_PROTOCOL_VERSION_MISMATCH') }))
    }
    const id = ++this.nextId
    return new Promise((resolvePromise, reject) => {
      const abort = () => { finish(); this.pending.delete(id); this.child?.kill(); reject(automationError('DESKTOP_ACTION_RESULT_UNKNOWN')) }
      const timer = setTimeout(abort, ['observe', 'requestPermissions'].includes(method) ? 85000 : 30000)
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve: value => { finish(); resolvePromise(value) }, reject: error => { finish(); reject(error) } })
      signal?.addEventListener('abort', abort, { once: true })
      this.child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...(this.displayId ? { displayId: this.displayId } : {}) } }) + '\n')
    })
  }
  observe(signal?: AbortSignal): Promise<BackendObservation> { return this.call('observe', {}, signal) }
  async act(action: AutomationAction, observation: BackendObservation, signal?: AbortSignal): Promise<void> { await this.call('act', { action, geometry: observation.geometry }, signal) }
  async release(): Promise<void> { if (this.child) await this.call('release').catch(() => undefined) }
  async close(): Promise<void> {
    await this.release()
    const child = this.child
    if (child && child.exitCode === null) await new Promise<void>(resolvePromise => {
      const finish = () => { clearTimeout(timer); resolvePromise() }
      const timer = setTimeout(() => { child.kill(); resolvePromise() }, 1000)
      child.once('exit', finish)
      child.stdin.end()
    })
    this.child = undefined; this.handshake = undefined
  }
}
