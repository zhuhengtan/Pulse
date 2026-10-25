import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Stable reader protocol; the SQL implementation travels with the backend. */
export class ReaderClient {
  private child: ChildProcess
  private pending = new Map<string, { resolve(value: { status: number; body: unknown }): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  constructor(directory: string, node = process.execPath, entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/updates/reader.js' : './reader.js', import.meta.url))) {
    this.child = spawn(node, [entry, directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    this.child.on('message', raw => { const value = raw as { id: string; status: number; body: unknown }; const item = this.pending.get(value.id); if (item) { this.pending.delete(value.id); clearTimeout(item.timer); item.resolve(value) } })
    this.child.on('error', error => this.fail(error)); this.child.on('exit', () => this.fail(new Error('READER_DISCONNECTED')))
  }
  private fail(error: Error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }; this.pending.clear() }
  query(path: string): Promise<{ status: number; body: unknown }> {
    if (!this.child.connected || this.pending.size >= 64) return Promise.reject(new Error('READER_UNAVAILABLE'))
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { this.pending.delete(id); reject(new Error('READER_TIMEOUT')) }, 10000)
      this.pending.set(id, { resolve, reject, timer }); this.child.send({ protocol: 1, id, path })
    })
  }
  close(): void { this.fail(new Error('READER_CLOSED')); if (this.child.connected) this.child.disconnect(); this.child.kill('SIGTERM') }
}
