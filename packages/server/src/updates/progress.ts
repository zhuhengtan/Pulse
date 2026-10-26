import { readFile, rm, readdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { atomicJson, statePath } from './store.js'

const maxAge = 60_000
export interface DownloadProgress { component: string; received: number; total: number }
const progressPath = (root: string, dataDir: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('UPDATE_PROGRESS_ID_INVALID')
  return `${statePath(root, dataDir)}.progress-${id}.json`
}
export async function readDownloadProgress(root: string, dataDir: string, id: string | undefined, phase: string, now = Date.now()): Promise<DownloadProgress | undefined> {
  if (!id || phase !== 'downloading') return undefined
  try {
    const item = JSON.parse(await readFile(progressPath(root, dataDir, id), 'utf8')) as Record<string, unknown>
    if (item.id !== id || !['backend', 'frontend'].includes(String(item.component)) || typeof item.updatedAt !== 'number' || item.updatedAt > now + 5000 || now - item.updatedAt > maxAge) return undefined
    if (!Number.isSafeInteger(item.received) || !Number.isSafeInteger(item.total) || Number(item.received) < 0 || Number(item.total) <= 0 || Number(item.received) > Number(item.total)) return undefined
    return { component: String(item.component), received: Number(item.received), total: Number(item.total) }
  } catch { return undefined }
}
/** One immutable identity per download; old callbacks and cleanup cannot touch a newer job. */
export class DownloadProgressWriter {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private lastWrite = -Infinity
  private lastComponent = ''
  private received = 0
  constructor(private root: string, private dataDir: string, readonly id: string, private now = Date.now) {}
  async start(): Promise<void> {
    const path = progressPath(this.root, this.dataDir, this.id), prefix = basename(statePath(this.root, this.dataDir)) + '.progress-'
    const names = (await readdir(dirname(path)).catch(() => [])).filter(name => name.startsWith(prefix) && name.endsWith('.json') && name !== basename(path))
    const old = await Promise.all(names.map(async name => ({ path: `${dirname(path)}/${name}`, mtime: (await stat(`${dirname(path)}/${name}`).catch(() => undefined))?.mtimeMs ?? 0 })))
    for (const item of old.sort((a, b) => b.mtime - a.mtime).slice(7)) await rm(item.path, { force: true }).catch(() => undefined)
  }
  update(value: DownloadProgress): void {
    if (this.closed || !['backend', 'frontend'].includes(value.component) || !Number.isSafeInteger(value.received) || !Number.isSafeInteger(value.total) || value.total <= 0 || value.received < 0 || value.received > value.total) return
    const changed = this.lastComponent !== value.component
    if (!changed && value.received < this.received) return
    this.received = value.received
    if (!changed && this.now() - this.lastWrite < 250) return
    this.lastComponent = value.component; this.lastWrite = this.now()
    const record = { ...value, id: this.id, updatedAt: this.lastWrite }
    this.tail = this.tail.catch(() => undefined).then(() => atomicJson(progressPath(this.root, this.dataDir, this.id), record))
    // Progress is optional; a diagnostics write failure must not corrupt a completed download.
    void this.tail.catch(() => undefined)
  }
  async finish(): Promise<void> {
    this.closed = true
    await this.tail.catch(() => undefined)
    await rm(progressPath(this.root, this.dataDir, this.id), { force: true }).catch(() => undefined)
  }
}
