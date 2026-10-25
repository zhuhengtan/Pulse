import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readJson } from './security.js'
import type { UpdateState } from './contracts.js'

export const updateRoot = (): string => resolve(process.env.PULSE_HOME ?? join(homedir(), '.pulse'))
export const scopeId = (directory: string): string => createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 32)
export const statePath = (root: string, directory: string): string => join(root, 'updates', 'scopes', scopeId(directory) + '.json')
export async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = path + '.' + randomUUID()
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(value); await file.sync() } finally { await file.close() }
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}
export async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value)) }
export function initialState(): UpdateState { return { schema: 1, autoDownload: true, sequence: 0, phase: 'idle', active: {}, pending: false, failed: [], blocked: [], available: [] } }
export async function readState(root: string, directory: string): Promise<UpdateState> {
  const state = await readJson(statePath(root, directory), initialState())
  if (state.schema !== 1 || !state.active || !Array.isArray(state.failed) || !Array.isArray(state.available)) throw new Error('UPDATE_STATE_INVALID')
  return state
}
/** O_EXCL lock shared by desktop, CLI and server. Never steal a live process's lock. */
export async function withUpdateLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const path = join(root, 'updates', 'update.lock'); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  for (let attempt = 0; ; attempt++) {
    try { const fd = await open(path, 'wx', 0o600); try { await fd.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await fd.close() }; break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)
      let dead = false
      if (Number.isInteger(owner?.pid)) { try { process.kill(owner.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' } }
      if (dead) {
        // Serialize stale-lock reclamation as well: two cleaners must not unlink
        // a fresh lock acquired between their PID check and unlink.
        const reaperPath = path + '.reap'
        const reaper = await open(reaperPath, 'wx', 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error })
        if (reaper) {
          try {
            await reaper.writeFile(JSON.stringify({ pid: process.pid }))
            if (await readFile(path, 'utf8').then(value => value === JSON.stringify(owner), () => false)) await rm(path)
          } finally { await reaper.close(); await rm(reaperPath, { force: true }) }
          continue
        }
      }
      if (!owner && Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 60000) throw new Error('UPDATE_LOCK_DAMAGED')
      if (attempt >= 300) throw new Error('UPDATE_BUSY')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try { return await work() } finally {
    if ((await readFile(path, 'utf8').then(JSON.parse).catch(() => ({}))).token === token) await rm(path, { force: true })
  }
}
