import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { replaceStateFile } from './atomic-file.js'

let walSequence = 0
function nextOrder(): number {
  walSequence += 1
  return Date.now() * 1000 + (walSequence % 1000)
}

export type WalDisposition = 'confirmed' | 'unconfirmed' | 'unknown'

export interface WalRecord {
  effectId: string
  runId: string
  laneId: string
  agentId?: string
  conversationId?: string
  path: string
  destination?: string
  preState: 'present' | 'absent'
  beforeHash: string | null
  intendedPostHash: string | null
  status: 'pending' | 'landed' | 'committed'
  kind?: 'write' | 'delete' | 'move'
  createdAt: number
  order?: number
}

export interface RollbackEntry {
  path: string
  preState: 'present' | 'absent'
  beforeHash: string | null
  expectedPostHash: string
  state: 'pending' | 'restored' | 'conflict'
  error?: string
}

export interface RollbackJournal {
  rollbackId: string
  runId: string
  entries: RollbackEntry[]
  status: 'pending' | 'completed' | 'conflict'
  createdAt: number
}

function walError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code, retryable: false })
}

export class FileSnapshotManager {
  private readonly blobsDir: string
  private readonly walDir: string
  private readonly rollbacksDir: string
  private readonly historyDir: string

  constructor(readonly root: string, readonly fsTool: FilesystemTool) {
    this.blobsDir = resolve(root, '.pulse/file-snapshots/blobs')
    this.walDir = resolve(root, '.pulse/file-snapshots/wal')
    this.rollbacksDir = resolve(root, '.pulse/file-snapshots/rollbacks')
    this.historyDir = resolve(root, '.pulse/file-snapshots/history')
  }

  /** Create the snapshot store one real directory at a time. A symlink is refused before any write. */
  private async ensureDirs(): Promise<void> {
    const lexical = resolve(this.root)
    const physicalRoot = await realpath(lexical).catch(() => { throw walError('WAL_PATH_ESCAPE') })
    const base = join(lexical, '.pulse', 'file-snapshots')
    for (const target of [join(lexical, '.pulse'), base, join(base, 'blobs'), join(base, 'wal'), join(base, 'rollbacks'), join(base, 'history')]) {
      await this.ensureRealDirectory(physicalRoot, target)
    }
  }

  private async ensureRealDirectory(physicalRoot: string, target: string): Promise<void> {
    let info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (info?.isSymbolicLink()) throw walError('WAL_PATH_ESCAPE')
    if (!info) {
      const parentInfo = await lstat(dirname(target)).catch(() => undefined)
      if (!parentInfo || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw walError('WAL_PATH_ESCAPE')
      try { await mkdir(target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw walError('WAL_PATH_ESCAPE')
    const opened = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
    if (!opened) throw walError('WAL_PATH_ESCAPE')
    try { if (!(await opened.stat()).isDirectory()) throw walError('WAL_PATH_ESCAPE') } finally { await opened.close().catch(() => undefined) }
    const physicalRel = relative(physicalRoot, await realpath(target)).replaceAll('\\', '/')
    if (physicalRel.startsWith('..') || isAbsolute(physicalRel)) throw walError('WAL_PATH_ESCAPE')
  }

  private workspacePath(path: string): string {
    const rel = relative(this.root, resolve(this.root, path)).replaceAll('\\', '/')
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw walError('WAL_PATH_ESCAPE')
    if (rel.split('/').includes('.pulse')) throw walError('WAL_INTERNAL_PATH')
    return rel
  }

  /** Stable store name for one conversation, run, and effect. Lane and agent stay in the name so equal numbers do not overwrite. */
  private storeFile(dir: string, owner: { conversationId?: string; runId: string; effectId: string; laneId?: string; agentId?: string }): string {
    const raw = [owner.conversationId ?? '', owner.runId, owner.effectId, owner.laneId ?? '', owner.agentId ?? ''].join('/')
    const visible = raw.replaceAll('/', '__')
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(visible) ? visible : createHash('sha256').update(raw).digest('hex')
    const target = resolve(dir, `${name}.json`)
    const rel = relative(dir, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw walError('WAL_PATH_ESCAPE')
    return target
  }

  /** An old record with no conversation is never treated as the caller. Lane or agent is checked only when both sides recorded one. */
  private matchesOwner(record: WalRecord, owner: { conversationId?: string; runId: string; effectId: string; laneId?: string; agentId?: string }, allowMissingConversation = false): boolean {
    if (record.effectId !== owner.effectId || record.runId !== owner.runId) return false
    if (owner.laneId && record.laneId && owner.laneId !== record.laneId) return false
    if (owner.agentId && record.agentId && owner.agentId !== record.agentId) return false
    const recordConversation = record.conversationId ?? ''
    const ownerConversation = owner.conversationId ?? ''
    if (!recordConversation || !ownerConversation) return allowMissingConversation && recordConversation === ownerConversation
    return recordConversation === ownerConversation
  }

  private async atomicBytes(target: string, bytes: Uint8Array): Promise<void> {
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing?.isSymbolicLink()) throw walError('WAL_PATH_ESCAPE')
    const parent = await lstat(dirname(target)).catch(() => undefined)
    if (!parent || parent.isSymbolicLink() || !parent.isDirectory()) throw walError('WAL_PATH_ESCAPE')
    const temporary = `${target}.tmp-${process.pid}-${process.hrtime.bigint().toString()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    try { await replaceStateFile(temporary, target) }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
    const directory = await open(dirname(target), 'r').catch(() => undefined)
    if (directory) { try { await directory.sync() } catch { /* not every filesystem can sync a directory */ } finally { await directory.close().catch(() => undefined) } }
  }

  private async saveBlob(hash: string, bytes: Buffer): Promise<void> {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== hash) throw walError('WAL_BLOB_CORRUPT')
    const target = join(this.blobsDir, hash)
    const existingInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existingInfo?.isSymbolicLink()) throw walError('WAL_PATH_ESCAPE')
    const existing = existingInfo ? await readFile(target) : undefined
    if (existing) {
      if (createHash('sha256').update(existing).digest('hex') !== hash) throw walError('WAL_BLOB_CORRUPT')
      return
    }
    await this.atomicBytes(target, bytes)
    const written = await readFile(target)
    if (createHash('sha256').update(written).digest('hex') !== hash) throw walError('WAL_BLOB_CORRUPT')
  }

  private async writeRecord(record: WalRecord): Promise<void> {
    const existing = (await this.loadStored(this.walDir)).find((item) => this.matchesOwner(item.record, record, true))
    await this.atomicBytes(existing?.file ?? this.storeFile(this.walDir, record), Buffer.from(JSON.stringify(record), 'utf8'))
  }

  private parseRecord(raw: string): WalRecord {
    let value: WalRecord
    try { value = JSON.parse(raw) as WalRecord } catch { throw walError('WAL_RECORD_CORRUPT') }
    const hashOk = (hash: unknown) => hash === null || (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    if (!value || typeof value.effectId !== 'string' || typeof value.path !== 'string' || typeof value.runId !== 'string' || typeof value.laneId !== 'string') throw walError('WAL_RECORD_CORRUPT')
    if (!['pending', 'landed', 'committed'].includes(value.status) || !['present', 'absent'].includes(value.preState) || !hashOk(value.beforeHash) || !hashOk(value.intendedPostHash)) throw walError('WAL_RECORD_CORRUPT')
    return value
  }

  async beginJournal(info: { effectId: string; runId: string; laneId: string; agentId: string; conversationId: string; path: string; before: Buffer | null; next: Uint8Array | null }): Promise<void> {
    await this.ensureDirs()
    const path = this.workspacePath(info.path)
    const beforeHash = info.before ? createHash('sha256').update(info.before).digest('hex') : null
    const intendedPostHash = info.next ? createHash('sha256').update(info.next).digest('hex') : null
    if (info.before && beforeHash) await this.saveBlob(beforeHash, info.before)
    await this.writeRecord({
      effectId: info.effectId, runId: info.runId, laneId: info.laneId, agentId: info.agentId, conversationId: info.conversationId,
      path, preState: info.before ? 'present' : 'absent', beforeHash, intendedPostHash, status: 'pending',
      kind: info.next ? 'write' : 'delete', createdAt: Date.now(), order: nextOrder(),
    })
  }

  async beginMove(info: { effectId: string; runId: string; laneId: string; agentId: string; conversationId: string; source: string; destination: string; before: Buffer }): Promise<void> {
    await this.ensureDirs()
    const path = this.workspacePath(info.source)
    const destination = this.workspacePath(info.destination)
    const beforeHash = createHash('sha256').update(info.before).digest('hex')
    await this.saveBlob(beforeHash, info.before)
    await this.writeRecord({
      effectId: info.effectId, runId: info.runId, laneId: info.laneId, agentId: info.agentId, conversationId: info.conversationId,
      path, destination, preState: 'present', beforeHash, intendedPostHash: beforeHash, status: 'pending', kind: 'move', createdAt: Date.now(), order: nextOrder(),
    })
  }

  /** Move persisted successful writes for these owners out of the pending log. Bytes stay as they are. */
  async settleConfirmed(owners: ReadonlyArray<{ conversationId: string; runId: string; effectId: string; laneId?: string; agentId?: string }>): Promise<void> {
    if (owners.length === 0 || !await this.containedDirectory(this.walDir)) return
    for (const stored of await this.loadStored(this.walDir)) {
      if (!owners.some((owner) => this.matchesOwner(stored.record, owner))) continue
      await this.retainHistory(stored.record)
      await this.removeStoreFile(stored.file)
    }
  }

  async markLanded(owner: { conversationId: string; runId: string; effectId: string; laneId?: string; agentId?: string }): Promise<void> {
    if (!await this.containedDirectory(this.walDir)) return
    for (const stored of await this.loadStored(this.walDir)) {
      if (!this.matchesOwner(stored.record, owner, true)) continue
      stored.record.status = 'landed'
      await this.atomicBytes(stored.file, Buffer.from(JSON.stringify(stored.record), 'utf8'))
    }
  }

  /** Prepare a write with WAL logging prior to modifying the disk. */
  async executeWithWal<T>(params: { effectId: string; runId: string; laneId: string; path: string; newBytes: Uint8Array; expectedHash?: string | null; signal?: AbortSignal; conversationId?: string; agentId?: string }, action: () => Promise<T>): Promise<T> {
    const safe = this.workspacePath(params.path)
    const before = params.expectedHash === null ? null : await this.readContained(resolve(this.root, safe))
    const beforeHash = before ? createHash('sha256').update(before).digest('hex') : null
    if (params.expectedHash !== undefined && beforeHash !== params.expectedHash) throw walError('FILE_BASELINE_CONFLICT')
    const conversationId = params.conversationId ?? ''
    const agentId = params.agentId ?? 'wal'
    await this.beginJournal({ effectId: params.effectId, runId: params.runId, laneId: params.laneId, agentId, conversationId, path: params.path, before, next: params.newBytes })
    const result = await action()
    await this.markLanded({ effectId: params.effectId, runId: params.runId, laneId: params.laneId, agentId, conversationId })
    return result
  }

  async reconcilePendingWal(signal?: AbortSignal, classify?: (record: WalRecord) => Promise<WalDisposition>): Promise<{ cleaned: string[]; restored: string[]; conflicts: Array<{ path: string; currentHash: string | null; beforeHash: string | null; intendedPostHash: string | null }> }> {
    if (signal?.aborted) throw walError('ABORTED')
    const records = await this.loadStored(this.walDir)
    const classified: Array<{ record: WalRecord; disposition: WalDisposition; file: string }> = []
    for (const stored of records) {
      const disposition = classify ? await classify(stored.record) : stored.record.status === 'pending' ? 'unconfirmed' : 'confirmed'
      if (disposition === 'unknown') throw walError('WAL_RECOVERY_UNKNOWN', `WAL_RECOVERY_UNKNOWN:${stored.record.path}`)
      classified.push({ record: stored.record, disposition, file: stored.file })
    }
    const cleaned: string[] = []
    const restored: string[] = []
    const conflicts: Array<{ path: string; currentHash: string | null; beforeHash: string | null; intendedPostHash: string | null }> = []
    for (const item of classified.filter((item) => item.record.kind === 'move')) await this.reconcileMove(item.record, item.disposition, item.file, cleaned, restored, conflicts, signal)
    const writes = classified.filter((item) => item.record.kind !== 'move')
    const byPath = new Map<string, Array<{ record: WalRecord; disposition: WalDisposition; file: string }>>()
    for (const item of writes) {
      const group = byPath.get(item.record.path) ?? []
      group.push(item)
      byPath.set(item.record.path, group)
    }
    for (const group of byPath.values()) await this.reconcileChain(group, cleaned, restored, conflicts, signal)
    if (conflicts.length > 0) throw Object.assign(walError('WAL_RECOVERY_EXTERNAL_CONFLICT', `WAL_RECOVERY_EXTERNAL_CONFLICT: external modifications detected during recovery on ${conflicts.map(c => c.path).join(', ')}`), { details: { conflicts } })
    return { cleaned, restored, conflicts }
  }

  private async reconcileChain(group: Array<{ record: WalRecord; disposition: WalDisposition; file: string }>, cleaned: string[], restored: string[], conflicts: Array<{ path: string; currentHash: string | null; beforeHash: string | null; intendedPostHash: string | null }>, signal?: AbortSignal): Promise<void> {
    const ordered = [...group].sort((a, b) => (a.record.order ?? a.record.createdAt) - (b.record.order ?? b.record.createdAt) || a.record.effectId.localeCompare(b.record.effectId))
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.record.beforeHash !== ordered[index - 1]!.record.intendedPostHash) {
        conflicts.push({ path: ordered[index]!.record.path, currentHash: await this.hashOf(ordered[index]!.record.path), beforeHash: ordered[index]!.record.beforeHash, intendedPostHash: ordered[index]!.record.intendedPostHash })
        return
      }
    }
    let pending = ordered
    while (pending.length > 0) {
      const currentHash = await this.hashOf(pending[0]!.record.path)
      let match = -1
      for (let index = pending.length - 1; index >= 0; index -= 1) if (pending[index]!.record.intendedPostHash === currentHash) { match = index; break }
      const origin = pending[0]!.record.beforeHash
      if (match < 0 && currentHash !== origin) {
        conflicts.push({ path: pending[0]!.record.path, currentHash, beforeHash: pending[0]!.record.beforeHash, intendedPostHash: pending[pending.length - 1]!.record.intendedPostHash })
        return
      }
      const tail = match < 0 ? pending : pending.slice(match + 1)
      if (tail.some((item) => item.disposition === 'confirmed')) {
        conflicts.push({ path: pending[0]!.record.path, currentHash, beforeHash: tail[0]!.record.beforeHash, intendedPostHash: tail[0]!.record.intendedPostHash })
        return
      }
      for (const item of tail) { await this.removeStoreFile(item.file); cleaned.push(item.record.path) }
      if (match < 0) return
      const matched = pending[match]!
      if (matched.disposition === 'confirmed') {
        for (const item of pending.slice(0, match + 1)) {
          if (item.disposition === 'confirmed') await this.retainHistory(item.record)
          await this.removeStoreFile(item.file)
          cleaned.push(item.record.path)
        }
        return
      }
      await this.restore(matched.record, signal)
      await this.removeStoreFile(matched.file)
      restored.push(matched.record.path)
      pending = pending.slice(0, match)
    }
  }

  /** Keep a verified preimage after crash recovery no longer needs the WAL record. */
  private async retainHistory(record: WalRecord): Promise<void> {
    await this.ensureDirs()
    if ((await this.loadStored(this.historyDir)).some((item) => this.matchesOwner(item.record, record))) return
    const file = this.storeFile(this.historyDir, record)
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing?.isSymbolicLink()) throw walError('WAL_PATH_ESCAPE')
    if (existing) return
    await this.atomicBytes(file, Buffer.from(JSON.stringify({ ...record, status: 'committed' }), 'utf8'))
  }

  /** Refuse a snapshot directory whose own path or any ancestor is a symlink or leaves the workspace. Missing is not an error. */
  private async containedDirectory(target: string): Promise<boolean> {
    const lexicalRoot = resolve(this.root)
    const physicalRoot = await realpath(lexicalRoot).catch(() => { throw walError('WAL_PATH_ESCAPE') })
    const rel = relative(lexicalRoot, resolve(target)).replaceAll('\\', '/')
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw walError('WAL_PATH_ESCAPE')
    let current = lexicalRoot
    for (const part of rel.split('/').filter(Boolean)) {
      current = join(current, part)
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!info) return false
      if (info.isSymbolicLink() || !info.isDirectory()) throw walError('WAL_PATH_ESCAPE')
      const opened = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
      if (!opened) throw walError('WAL_PATH_ESCAPE')
      try { if (!(await opened.stat()).isDirectory()) throw walError('WAL_PATH_ESCAPE') } finally { await opened.close().catch(() => undefined) }
    }
    const physicalRel = relative(physicalRoot, await realpath(current)).replaceAll('\\', '/')
    if (physicalRel.startsWith('..') || isAbsolute(physicalRel)) throw walError('WAL_PATH_ESCAPE')
    return true
  }

  private async removeStoreFile(file: string): Promise<void> {
    if (!await this.containedDirectory(dirname(file))) throw walError('WAL_PATH_ESCAPE')
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return
    if (info.isSymbolicLink() || !info.isFile()) throw walError('WAL_PATH_ESCAPE')
    await rm(file)
  }

  private async loadStored(dir: string): Promise<Array<{ record: WalRecord; file: string }>> {
    if (!await this.containedDirectory(dir)) return []
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    const records: Array<{ record: WalRecord; file: string }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const target = join(dir, name)
      const info = await lstat(target)
      if (info.isSymbolicLink() || !info.isFile()) throw walError('WAL_PATH_ESCAPE')
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try { records.push({ record: this.parseRecord(await handle.readFile({ encoding: 'utf8' })), file: target }) } finally { await handle.close().catch(() => undefined) }
    }
    return records
  }

  private async loadRecords(dir: string): Promise<WalRecord[]> {
    return (await this.loadStored(dir)).map((item) => item.record)
  }

  async modificationScope(targets: Array<{ path: string; expectedPostHash: string }>): Promise<{ conversationId: string; runId: string }> {
    const records = [...await this.loadRecords(this.walDir), ...await this.loadRecords(this.historyDir)]
    const selected: WalRecord[] = []
    for (const target of targets) {
      const path = this.workspacePath(target.path)
      const hits = records.filter((record) => record.path === path && record.intendedPostHash === target.expectedPostHash && record.kind !== 'move')
      if (hits.length === 0) throw walError('ROLLBACK_BASELINE_MISSING')
      selected.push(hits.sort((a, b) => (b.order ?? b.createdAt) - (a.order ?? a.createdAt))[0]!)
    }
    const scopes = new Set(selected.map((record) => `${record.conversationId ?? ''}\n${record.runId}`))
    if (scopes.size !== 1) throw walError('ROLLBACK_SCOPE_MISMATCH')
    const [conversationId, runId] = [...scopes][0]!.split('\n')
    if (!conversationId || !runId) throw walError('ROLLBACK_SCOPE_MISMATCH')
    return { conversationId, runId }
  }

  private async reconcileMove(record: WalRecord, disposition: WalDisposition, file: string, cleaned: string[], restored: string[], conflicts: Array<{ path: string; currentHash: string | null; beforeHash: string | null; intendedPostHash: string | null }>, signal?: AbortSignal): Promise<void> {
    const destination = record.destination ?? ''
    const sourceHash = await this.hashOf(record.path)
    const destHash = destination ? await this.hashOf(destination) : null
    const conflict = () => conflicts.push({ path: record.path, currentHash: destHash, beforeHash: record.beforeHash, intendedPostHash: record.intendedPostHash })
    if (!destination) { conflict(); return }
    if (disposition === 'confirmed') {
      if (destHash === record.beforeHash && sourceHash === null) { await this.removeStoreFile(file); cleaned.push(record.path); return }
      conflict(); return
    }
    if (sourceHash === record.beforeHash && destHash === null) { await this.removeStoreFile(file); cleaned.push(record.path); return }
    if (destHash === record.beforeHash && sourceHash === null && record.beforeHash) {
      const blob = await this.verifiedBlob(record.beforeHash)
      await this.fsTool.writeBytesIfUnchanged(record.path, blob, null, signal)
      await this.fsTool.removeIfUnchanged(destination, record.beforeHash, signal)
      if (await this.hashOf(record.path) !== record.beforeHash || await this.hashOf(destination) !== null) throw walError('WAL_RESTORE_MISMATCH')
      await this.removeStoreFile(file)
      restored.push(record.path)
      return
    }
    conflict()
  }

  private async readContained(target: string): Promise<Buffer | null> {
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isFile()) throw walError('WAL_PATH_ESCAPE')
    const physicalRoot = await realpath(this.root)
    const physicalRel = relative(physicalRoot, await realpath(target)).replaceAll('\\', '/')
    if (physicalRel.startsWith('..') || isAbsolute(physicalRel)) throw walError('WAL_PATH_ESCAPE')
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { return await handle.readFile() } finally { await handle.close().catch(() => undefined) }
  }

  private async hashOf(path: string): Promise<string | null> {
    const safe = this.workspacePath(path)
    const target = resolve(this.root, safe)
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isFile()) throw walError('WAL_PATH_ESCAPE')
    const physicalRoot = await realpath(this.root)
    const physicalRel = relative(physicalRoot, await realpath(target)).replaceAll('\\', '/')
    if (physicalRel.startsWith('..') || isAbsolute(physicalRel)) throw walError('WAL_PATH_ESCAPE')
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { return createHash('sha256').update(await handle.readFile()).digest('hex') } finally { await handle.close().catch(() => undefined) }
  }

  private async verifiedBlob(hash: string): Promise<Buffer> {
    if (!await this.containedDirectory(this.blobsDir)) throw walError('WAL_BLOB_MISSING')
    const target = join(this.blobsDir, hash)
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') throw walError('WAL_BLOB_MISSING'); throw error })
    if (info.isSymbolicLink() || !info.isFile()) throw walError('WAL_PATH_ESCAPE')
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const bytes = await handle.readFile()
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw walError('WAL_BLOB_CORRUPT')
      return bytes
    } finally { await handle.close().catch(() => undefined) }
  }

  private async restore(record: WalRecord, signal?: AbortSignal): Promise<void> {
    const current = await this.hashOf(record.path)
    if (record.intendedPostHash === null) {
      if (record.beforeHash === null || record.preState !== 'present') throw walError('ROLLBACK_BASELINE_MISSING')
      if (current !== null) throw walError('WAL_RECOVERY_EXTERNAL_CONFLICT')
      const blob = await this.verifiedBlob(record.beforeHash)
      const written = await this.fsTool.writeBytesIfUnchanged(record.path, blob, null, signal)
      if (written.hash !== record.beforeHash || await this.hashOf(record.path) !== record.beforeHash) throw walError('WAL_RESTORE_MISMATCH')
      return
    }
    if (record.preState === 'absent' || record.beforeHash === null) {
      if (current !== record.intendedPostHash) throw walError('WAL_RECOVERY_EXTERNAL_CONFLICT')
      await this.fsTool.removeIfUnchanged(record.path, record.intendedPostHash, signal)
      if (await this.hashOf(record.path) !== null) throw walError('WAL_RESTORE_MISMATCH')
      return
    }
    if (current !== record.intendedPostHash) throw walError('WAL_RECOVERY_EXTERNAL_CONFLICT')
    const blob = await this.verifiedBlob(record.beforeHash)
    const written = await this.fsTool.writeBytesIfUnchanged(record.path, blob, record.intendedPostHash, signal)
    if (written.hash !== record.beforeHash || await this.hashOf(record.path) !== record.beforeHash) throw walError('WAL_RESTORE_MISMATCH')
  }

  /** Explicit multi-file rollback. A missing baseline is a conflict, never a successful restore. */
  async rollback(rollbackId: string, runId: string, targets: Array<{ path: string; expectedPostHash: string }>, signal?: AbortSignal): Promise<RollbackJournal> {
    await this.ensureDirs()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(rollbackId)) throw walError('ROLLBACK_ID_INVALID')
    const journalFile = join(this.rollbacksDir, `${rollbackId}.json`)
    const journalInfo = await lstat(journalFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (journalInfo?.isSymbolicLink()) throw walError('WAL_PATH_ESCAPE')
    let journal: RollbackJournal
    const existingRaw = journalInfo ? await readFile(journalFile, 'utf8') : undefined
    if (existingRaw) journal = JSON.parse(existingRaw) as RollbackJournal
    else {
      const records = [...await this.loadRecords(this.walDir), ...await this.loadRecords(this.historyDir)]
      journal = {
        rollbackId, runId, status: 'pending', createdAt: Date.now(),
        entries: targets.map((target) => {
          const path = this.workspacePath(target.path)
          const matched = records.filter((record) => record.path === path && record.intendedPostHash === target.expectedPostHash && record.kind !== 'move').sort((a, b) => (b.order ?? b.createdAt) - (a.order ?? a.createdAt))[0]
          return { path, preState: matched?.preState ?? 'present', beforeHash: matched?.beforeHash ?? null, expectedPostHash: target.expectedPostHash, state: 'pending' as const, ...(matched ? {} : { error: 'ROLLBACK_BASELINE_MISSING' }) }
        }),
      }
      await this.atomicBytes(journalFile, Buffer.from(JSON.stringify(journal), 'utf8'))
    }
    let hasConflict = journal.entries.some((entry) => entry.error === 'ROLLBACK_BASELINE_MISSING' && entry.beforeHash === null && entry.state === 'pending')
    for (const entry of journal.entries) {
      if (entry.state === 'restored') continue
      if (entry.beforeHash === null && entry.preState !== 'absent') {
        entry.state = 'conflict'
        entry.error = 'ROLLBACK_BASELINE_MISSING'
        hasConflict = true
        continue
      }
      try {
        const currentHash = await this.hashOf(entry.path)
        if (currentHash === entry.beforeHash || (entry.preState === 'absent' && currentHash === null)) { entry.state = 'restored'; continue }
        if (currentHash !== entry.expectedPostHash) throw walError('ROLLBACK_TARGET_MODIFIED_EXTERNALLY')
        if (entry.preState === 'absent') await this.fsTool.removeIfUnchanged(entry.path, entry.expectedPostHash, signal)
        else if (entry.beforeHash) {
          const blob = await this.verifiedBlob(entry.beforeHash)
          const written = await this.fsTool.writeBytesIfUnchanged(entry.path, blob, entry.expectedPostHash, signal)
          if (written.hash !== entry.beforeHash) throw walError('WAL_RESTORE_MISMATCH')
        } else throw walError('ROLLBACK_BASELINE_MISSING')
        if ((entry.preState === 'absent' && await this.hashOf(entry.path) !== null) || (entry.beforeHash && await this.hashOf(entry.path) !== entry.beforeHash)) throw walError('WAL_RESTORE_MISMATCH')
        entry.state = 'restored'
      } catch (error) {
        entry.state = 'conflict'
        entry.error = (error as { code?: string }).code ?? (error as Error).message
        hasConflict = true
      }
    }
    journal.status = hasConflict ? 'conflict' : 'completed'
    await this.atomicBytes(journalFile, Buffer.from(JSON.stringify(journal), 'utf8'))
    if (hasConflict) throw Object.assign(walError('ROLLBACK_TARGET_MODIFIED_EXTERNALLY'), { details: { journal } })
    return journal
  }
}

export function effectOwnsWalRecord(effect: { agentId?: string; ownerLaneId?: string } | undefined, record: WalRecord): boolean {
  if (!effect) return false
  if (record.agentId && effect.agentId && record.agentId !== effect.agentId) return false
  if (record.laneId && effect.ownerLaneId && record.laneId !== effect.ownerLaneId) return false
  return true
}

export function dispositionForEffect(effect: { executionState?: string; sideEffectState?: string; outcome?: { status?: string }; input?: unknown } | undefined): WalDisposition {
  if (!effect) return 'unconfirmed'
  if (effect.sideEffectState === 'unknown' || effect.executionState === 'remote_unknown') return 'unknown'
  const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, unknown> : undefined
  const name = typeof input?.name === 'string' ? input.name : ''
  if (name === 'shell.exec' || name === 'shell.start' || name === 'shell.poll') return 'unknown'
  if (effect.outcome?.status === 'succeeded' || effect.executionState === 'succeeded') return 'confirmed'
  return 'unconfirmed'
}
