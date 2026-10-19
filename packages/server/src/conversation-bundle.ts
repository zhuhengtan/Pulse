import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { ZipFile } from 'yazl'
import { open as openZip, type ZipFile as ReadZip, type Entry } from 'yauzl'
import { z } from 'zod'
import { hydrateRuntimeResultBodies, hydrateRuntimeSnapshotBodies, importRuntimePersistence, type RuntimePersistenceSnapshot } from '@hunterzhu/pulse-runtime'
import { isConversationId } from './security.js'
import { runPersistence } from './run-persistence.js'
import { redactJarvisText } from './jarvis/privacy.js'
import { workspaceStamp } from './task-controller/checkpoint.js'

export const BUNDLE_MAX_COMPRESSED = 256 * 1024 * 1024
export const BUNDLE_MAX_BYTES = 1024 * 1024 * 1024
export const BUNDLE_MAX_ENTRIES = 20_000
const MAX_TEXT = 128 * 1024 * 1024
const MAX_METADATA = 8 * 1024 * 1024
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value)
const unique = (items: string[]) => [...new Set(items)]

export class BundleError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
function fail(code: string, status = 400): never { throw new BundleError(code, status) }
export const transferManifestSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().refine(isConversationId), title: z.string(), cwd: z.string(),
  executionCwd: z.string().optional(), jarvisWorkspace: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(), runs: z.array(z.string().refine(safeId)).max(BUNDLE_MAX_ENTRIES),
  activeRunId: z.string().refine(safeId).optional(),
  approvalPolicy: z.enum(['manual', 'delegate']).optional(),
  artifacts: z.array(z.object({ path: z.string(), hash: z.string(), bytes: z.number(), runId: z.string(), mediaType: z.string().optional(), label: z.string().optional() })).optional(),
  projectId: z.string().optional(), projectUnassigned: z.boolean().optional(), origin: z.literal('assistant').optional(),
  pinned: z.boolean().optional(), archivedAt: z.string().optional(),
}).refine(value => new Set(value.runs).size === value.runs.length && (!value.activeRunId || value.runs.includes(value.activeRunId)))
export type TransferManifest = z.infer<typeof transferManifestSchema>
const stampSchema = z.object({ available: z.boolean(), files: z.record(z.string()), digest: z.string().optional() })
const metadataSchema = z.object({
  format: z.literal('pulse-work-conversation'), version: z.literal(1), exportedAt: z.string(),
  conversationId: z.string().refine(isConversationId),
  source: z.object({ cwd: z.string(), executionCwd: z.string(), stamp: stampSchema }),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(BUNDLE_MAX_ENTRIES),
  blockedReasons: z.array(z.string()).max(BUNDLE_MAX_ENTRIES), redactedFiles: z.array(z.string()).max(BUNDLE_MAX_ENTRIES),
})
export type BundleMetadata = z.infer<typeof metadataSchema>
export interface BundlePreview {
  token: string; conversationId: string; title: string; runCount: number; attachmentCount: number
  activeRunId?: string; blockedReasons: string[]; redactedFiles: number; expiresAt: string
}
export interface StagedBundle {
  directory: string; metadata: BundleMetadata; manifest: TransferManifest; digest: string
}
export interface TransferBinding {
  schemaVersion: 1; digest: string; importedAt: string; source: BundleMetadata['source']
  targetCwd: string; executionCwd: string; blockedReasons: string[]; intrinsicReasons: string[]
  runId?: string
}

/** ZIP names are portable data, never host paths. Case folding also prevents Windows collisions. */
export function validateBundlePath(name: string): string {
  if (!name || name.length > 1024 || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/') || name.endsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /[<>"|?*\x00-\x1f]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('BUNDLE_INVALID_PATH')
  if (posix.normalize(name) !== name) fail('BUNDLE_INVALID_PATH')
  return name
}

const rootFiles = new Set(['manifest.json', 'messages.jsonl', 'messages.jsonl.bak', 'attachment-references.json'])
const runDirectories = new Set(['runtime-results', 'runtime-snapshots', 'runtime-events', 'runtime.json.fact-inbox-dedupe', 'shell-output', 'check-definitions'])
const auditOnly = /^(?:jarvis(?:-.*)?|plan-gate|interaction-receipts|recovery-.*)\.json(?:l)?$/
function allowedConversationFile(path: string, manifest: TransferManifest): boolean {
  const parts = path.split('/')
  if (parts.length === 1) return rootFiles.has(path)
  if (parts[0] === 'attachments') return parts.length === 2 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(parts[1]!) && !parts[1]!.includes('..')
  if (parts[0] !== 'runs' || !manifest.runs.includes(parts[1]!)) return false
  if (parts.length === 3) return !auditOnly.test(parts[2]!) && (/^[A-Za-z0-9._-]+\.(?:json|jsonl|log|txt)$/.test(parts[2]!) || parts[2] === 'runtime.sqlite')
  return runDirectories.has(parts[2]!) && parts.slice(3).every(part => /^[A-Za-z0-9._-]+$/.test(part)) && !/\.(?:lock|tmp)$|\.tmp-/.test(parts.at(-1)!)
}

/** Only strings are redacted: token counts and other numeric accounting remain intact. */
export function redactBundleValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (/^(?:password|passwd|token|secret|credential|authorization|api[_-]?key|private[_-]?key|cookie|accessToken|refreshToken)$/i.test(key)) return '[REDACTED]'
    return redactJarvisText(value).replace(/(--?[\w-]*(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|cookie)[\w-]*(?:=|\s+))(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map((item, index) => typeof value[index - 1] === 'string' && /^--?(?:[\w-]*(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|cookie)[\w-]*|user)$/i.test(value[index - 1] as string) ? '[REDACTED]' : redactBundleValue(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactBundleValue(item, name)]))
  return value
}
function redactFile(path: string, body: Buffer): Buffer {
  const raw = body.toString('utf8')
  const line = (text: string) => { try { return JSON.stringify(redactBundleValue(JSON.parse(text))) } catch { return String(redactBundleValue(text)) } }
  if (path.endsWith('.json')) { try { return Buffer.from(JSON.stringify(redactBundleValue(JSON.parse(raw)), null, 2)) } catch { return Buffer.from(String(redactBundleValue(raw))) } }
  if (path.endsWith('.jsonl') || path.endsWith('.jsonl.bak')) return Buffer.from(raw.split('\n').map(text => text.trim() ? line(text) : '').join('\n'))
  return Buffer.from(String(redactBundleValue(raw)))
}
function changedByRedaction(path: string, before: Buffer, after: Buffer): boolean {
  const canonical = (text: string) => { try { return JSON.stringify(JSON.parse(text)) } catch { return text } }
  if (path.endsWith('.json')) return canonical(before.toString()) !== canonical(after.toString())
  if (path.endsWith('.jsonl') || path.endsWith('.jsonl.bak')) return before.toString().split('\n').filter(Boolean).map(canonical).join('\n') !== after.toString().split('\n').filter(Boolean).map(canonical).join('\n')
  return !before.equals(after)
}

/** Reads a stable SQLite transaction including its WAL; never copies an open main DB alone. */
function backupSqlite(source: string, destination: string): boolean {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly: boolean }) => { prepare(sql: string): { run(...args: unknown[]): unknown; all(): Array<Record<string, unknown>> }; close(): void } }
  const database = new DatabaseSync(source, { readOnly: true })
  try { database.prepare('VACUUM INTO ?').run(destination) } finally { database.close() }
  let copy: { prepare(sql: string): { run(...args: unknown[]): unknown; all(): Array<Record<string, unknown>> }; close(): void } | undefined
  let redacted = false
  try {
    copy = new DatabaseSync(destination)
    // UPDATE can leave the original value in freed cells or overflow pages.
    // Only the export copy is scrubbed; the live source stays read-only.
    copy.prepare('PRAGMA secure_delete = ON').run()
    const tables = ['runtime_snapshot', 'runtime_content', 'runtime_event_archive', 'runtime_sessions', 'runtime_session', 'runtime_fact_inbox_dedupe']
    const existing = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
    for (const table of tables) {
      if (!existing.has(table)) continue
      // SQLite runtime tables use ordinary rowids. Inspect all text fields, not just payload.
      for (const row of copy.prepare(`SELECT rowid AS _rowid, * FROM ${table}`).all()) {
        for (const [key, value] of Object.entries(row)) {
          if (key === '_rowid' || typeof value !== 'string') continue
          let next: string
          try { next = JSON.stringify(redactBundleValue(JSON.parse(value))) }
          catch { next = redactJarvisText(value) }
          let changed = next !== value
          try { changed = JSON.stringify(JSON.parse(value)) !== JSON.stringify(JSON.parse(next)) } catch { /* Plain text columns. */ }
          if (changed) { copy.prepare(`UPDATE ${table} SET "${key.replaceAll('"', '""')}" = ? WHERE rowid = ?`).run(next, row._rowid); redacted = true }
        }
      }
    }
    // Rebuild the redacted image so no old page contents enter the ZIP.
    if (redacted) copy.prepare('VACUUM').run()
  } finally {
    try { copy?.close() } catch { /* Ignore close failure */ }
  }
  return redacted
}

async function fileHash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}
async function safeTree(root: string, prefix = ''): Promise<string[]> {
  if ((await lstat(root)).isSymbolicLink()) fail('BUNDLE_SYMLINK_FORBIDDEN')
  const paths: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    validateBundlePath(path)
    if (/\.(?:lock|tmp)$|\.tmp-/.test(entry.name)) continue
    if (entry.isSymbolicLink()) fail('BUNDLE_SYMLINK_FORBIDDEN')
    if (entry.isDirectory()) paths.push(...await safeTree(join(root, entry.name), path))
    else if (entry.isFile()) paths.push(path)
    if (paths.length > BUNDLE_MAX_ENTRIES) fail('BUNDLE_TOO_MANY_FILES', 413)
  }
  return paths
}

export async function createConversationBundle(directory: string, manifest: TransferManifest): Promise<{ path: string; filename: string; cleanup(): Promise<void> }> {
  const temporary = await mkdtemp(join(tmpdir(), 'pulse-export-'))
  const spool = join(temporary, 'files')
  const files: BundleMetadata['files'] = []; const redactedFiles: string[] = []; const blockedReasons: string[] = []
  let bytes = 0
  try {
    const sourceRoot = manifest.executionCwd ?? manifest.cwd
    const beforeStamp = await workspaceStamp(sourceRoot)
    for (const path of await safeTree(directory)) {
      let name: string
      if (allowedConversationFile(path, manifest)) name = `conversation/${path}`
      else if (path.startsWith('import-diagnostics/')) name = `diagnostics/${path.slice('import-diagnostics/'.length)}`
      else if (path.startsWith('compactions/')) name = `diagnostics/${path}`
      else if (path.startsWith('runs/') && manifest.runs.includes(path.split('/')[1]!) && auditOnly.test(path.split('/').at(-1)!)) name = `diagnostics/${path}`
      else continue
      const input = join(directory, path), output = join(spool, name)
      const info = await lstat(input)
      if (!info.isFile() || info.isSymbolicLink()) fail('BUNDLE_SYMLINK_FORBIDDEN')
      if ((bytes += info.size) > BUNDLE_MAX_BYTES || info.size > MAX_TEXT) fail('BUNDLE_TOO_LARGE', 413)
      await mkdir(dirname(output), { recursive: true })
      let redacted = false
      if (path.endsWith('runtime.sqlite')) redacted = backupSqlite(input, output)
      else if (path.startsWith('attachments/') && !path.endsWith('.meta.json')) {
        // Binary uploads remain opaque; they are never interpreted as configuration or code.
        await copyFile(input, output)
      } else {
        const body = await readFile(input)
        const next = redactFile(path, body)
        redacted = changedByRedaction(path, body, next)
        await writeFile(output, next, { mode: 0o600 })
      }
      if (redacted) {
        redactedFiles.push(name)
        if (/runtime|input\.json|model-budget|checkpoint|check-definitions/.test(path)) blockedReasons.push('RECOVERY_DATA_REDACTED')
      }
      files.push({ path: name, bytes: (await stat(output)).size, sha256: await fileHash(output) })
    }
    // Validate external bodies and native integrity before advertising the active run as resumable.
    if (manifest.activeRunId && !blockedReasons.length) {
      try { await readBundleRuntime(join(spool, 'conversation'), manifest.activeRunId) }
      catch { blockedReasons.push('RECOVERY_SNAPSHOT_INCOMPLETE') }
    }
    // Opening the copied SQLite backend can update its journal-mode header. Hash its final closed image.
    for (const file of files) { file.bytes = (await stat(join(spool, file.path))).size; file.sha256 = await fileHash(join(spool, file.path)) }
    const afterStamp = await workspaceStamp(sourceRoot)
    if (!beforeStamp.available || !afterStamp.available) blockedReasons.push('WORKSPACE_FINGERPRINT_UNAVAILABLE')
    else if (beforeStamp.digest !== afterStamp.digest) blockedReasons.push('WORKSPACE_CHANGED_DURING_EXPORT')
    const metadata: BundleMetadata = { format: 'pulse-work-conversation', version: 1, exportedAt: new Date().toISOString(), conversationId: manifest.id, source: { cwd: manifest.cwd, executionCwd: sourceRoot, stamp: afterStamp }, files, redactedFiles, blockedReasons: unique(blockedReasons) }
    const messages = await readFile(join(spool, 'conversation/messages.jsonl'), 'utf8').catch(() => '')
    const markdown = `# ${manifest.title}\n\n` + messages.split('\n').filter(Boolean).flatMap(line => { try { const message = JSON.parse(line) as { role: string; text?: string }; return [`## ${message.role}\n\n${message.text ?? ''}\n`] } catch { return [] } }).join('\n')
    await writeFile(join(spool, 'chat.md'), markdown, { mode: 0o600 })
    await writeFile(join(spool, 'README.txt'), 'Pulse 工作会话迁移包 v1\nchat.md 可直接阅读。conversation/ 包含消息、附件和运行记录。diagnostics/ 仅供排查，不恢复授权。\n在目标机“工作”界面选择“导入会话”，绑定已同步的项目，再按检查结果继续任务。\n不含项目源码和全局配置，不迁移服务认证。上传附件为原始文件，请自行保管。\n' + (metadata.blockedReasons.length ? `恢复阻塞：${metadata.blockedReasons.join(', ')}\n` : ''), { mode: 0o600 })
    for (const name of ['chat.md', 'README.txt']) files.push({ path: name, bytes: (await stat(join(spool, name))).size, sha256: await fileHash(join(spool, name)) })
    if (files.length + 1 > BUNDLE_MAX_ENTRIES || files.some(file => file.bytes > MAX_TEXT) || files.reduce((sum, file) => sum + file.bytes, 0) > BUNDLE_MAX_BYTES) fail('BUNDLE_TOO_LARGE', 413)
    const manifestText = JSON.stringify(metadata, null, 2)
    if (Buffer.byteLength(manifestText) > MAX_METADATA) fail('BUNDLE_TOO_LARGE', 413)
    await writeFile(join(spool, 'bundle.json'), manifestText, { mode: 0o600 })
    const zip = new ZipFile()
    const path = join(temporary, 'conversation.zip')
    let compressedBytes = 0
    const done = pipeline(zip.outputStream, new Transform({ transform(chunk: Buffer, _encoding, callback) { compressedBytes += chunk.length; callback(compressedBytes > BUNDLE_MAX_COMPRESSED ? new BundleError('BUNDLE_TOO_LARGE', 413) : null, chunk) } }), createWriteStream(path, { mode: 0o600 }))
    for (const name of [...files.map(file => file.path), 'bundle.json']) zip.addFile(join(spool, name), name, { mode: 0o100600 })
    zip.end()
    await done
    return { path, filename: `pulse-${manifest.id}-${metadata.exportedAt.replace(/[:.]/g, '-')}.zip`, cleanup: () => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  } catch (error) { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); throw error }
}

async function extractZip(input: string, output: string): Promise<void> {
  const zip = await new Promise<ReadZip>((resolve, reject) => openZip(input, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error || !value ? reject(error) : resolve(value)))
  let bytes = 0; let count = 0
  const names = new Set<string>()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const abort = (error: unknown) => { if (!settled) { settled = true; zip.close(); reject(error instanceof BundleError ? error : new BundleError('BUNDLE_INVALID_ZIP')) } }
    zip.on('error', abort)
    zip.on('end', () => { if (!settled) { settled = true; resolve() } })
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        const name = validateBundlePath(entry.fileName), key = name.toLowerCase()
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if ((entry.generalPurposeBitFlag & 1) || (mode !== 0 && mode !== 0o100000) || names.has(key)) fail('BUNDLE_INVALID_ENTRY')
        names.add(key)
        if (++count > BUNDLE_MAX_ENTRIES || (bytes += entry.uncompressedSize) > BUNDLE_MAX_BYTES || entry.uncompressedSize > MAX_TEXT) fail('BUNDLE_TOO_LARGE', 413)
        const target = join(output, name)
        await mkdir(dirname(target), { recursive: true })
        const stream = await new Promise<import('node:stream').Readable>((resolve, reject) => zip.openReadStream(entry, (error, value) => error || !value ? reject(error) : resolve(value)))
        let size = 0
        await pipeline(stream, new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; callback(size > entry.uncompressedSize ? new BundleError('BUNDLE_INVALID_SIZE') : null, chunk) } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
        if (size !== entry.uncompressedSize) fail('BUNDLE_INVALID_SIZE')
        zip.readEntry()
      })().catch(abort)
    })
    zip.readEntry()
  })
}

export async function stageConversationBundle(input: AsyncIterable<Buffer | string>, temporaryRoot: string): Promise<StagedBundle> {
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'import-'))
  try {
    const archive = join(directory, 'upload.zip'), file = await open(archive, 'wx', 0o600)
    let bytes = 0
    try { for await (const chunk of input) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if ((bytes += buffer.length) > BUNDLE_MAX_COMPRESSED) fail('BUNDLE_TOO_LARGE', 413); await file.writeFile(buffer) } } finally { await file.close() }
    const digest = await fileHash(archive)
    const content = join(directory, 'content'); await mkdir(content)
    await extractZip(archive, content)
    if ((await stat(join(content, 'bundle.json'))).size > MAX_METADATA) fail('BUNDLE_INVALID_MANIFEST')
    const metadata = metadataSchema.parse(JSON.parse(await readFile(join(content, 'bundle.json'), 'utf8')))
    const manifest = transferManifestSchema.parse(JSON.parse(await readFile(join(content, 'conversation/manifest.json'), 'utf8')))
    if (manifest.id !== metadata.conversationId || manifest.cwd !== metadata.source.cwd || (manifest.executionCwd ?? manifest.cwd) !== metadata.source.executionCwd) fail('BUNDLE_INVALID_MANIFEST')
    const paths = await safeTree(content), listed = new Set<string>(['bundle.json'])
    let total = 0
    for (const file of metadata.files) {
      validateBundlePath(file.path)
      if (listed.has(file.path) || file.path.startsWith('conversation/') && !allowedConversationFile(file.path.slice(13), manifest) || !/^(?:conversation\/|diagnostics\/|chat\.md$|README\.txt$)/.test(file.path)) fail('BUNDLE_INVALID_MANIFEST')
      listed.add(file.path)
      if ((total += file.bytes) > BUNDLE_MAX_BYTES) fail('BUNDLE_TOO_LARGE', 413)
      const target = join(content, file.path)
      if ((await stat(target)).size !== file.bytes || await fileHash(target) !== file.sha256) fail('BUNDLE_HASH_MISMATCH')
    }
    if (paths.length !== listed.size || paths.some(path => !listed.has(path)) || !listed.has('conversation/manifest.json')) fail('BUNDLE_FILE_LIST_MISMATCH')
    for (const runId of manifest.runs) {
      const runDir = join(content, 'conversation/runs', runId)
      const runtime = await readdir(runDir).catch((): string[] => [])
      if (runtime.includes('runtime.sqlite') && runtime.includes('runtime.json')) fail('BUNDLE_RUNTIME_FORMAT_CONFLICT')
      if (!metadata.blockedReasons.includes('RECOVERY_DATA_REDACTED') && (runtime.includes('runtime.json') || runtime.includes('runtime.sqlite'))) {
        try { await readBundleRuntime(join(content, 'conversation'), runId) }
        catch { metadata.blockedReasons = unique([...metadata.blockedReasons, 'RECOVERY_SNAPSHOT_INCOMPLETE']) }
      }
    }
    return { directory, metadata, manifest, digest }
  } catch (error) { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); if (error instanceof BundleError) throw error; throw new BundleError('BUNDLE_INVALID_ARCHIVE') }
}

export async function readBundleRuntime(directory: string, runId: string) {
  if (!safeId(runId)) fail('BUNDLE_INVALID_RUN_ID')
  const root = join(directory, 'runs', runId)
  if (!await stat(join(root, 'runtime.json')).then(() => true, () => false) && !await stat(join(root, 'runtime.sqlite')).then(() => true, () => false)) fail('RECOVERY_SNAPSHOT_MISSING')
  const backend = await runPersistence(root)
  try {
    let snapshot = await backend.load()
    if (!snapshot) fail('RECOVERY_SNAPSHOT_MISSING')
    if (snapshot.snapshotBodies === 'external') { if (!backend.snapshotStore) fail('RECOVERY_SNAPSHOT_INCOMPLETE'); snapshot = await hydrateRuntimeSnapshotBodies(snapshot, backend.snapshotStore) }
    if (snapshot.resultBodies === 'external') { if (!backend.resultStore) fail('RECOVERY_SNAPSHOT_INCOMPLETE'); snapshot = await hydrateRuntimeResultBodies(snapshot, backend.resultStore) }
    const restored = importRuntimePersistence(snapshot)
    if (snapshot.eventArchive && snapshot.eventArchive.through > 0) {
      if (!backend.eventArchive) fail('RECOVERY_EVENT_ARCHIVE_MISSING')
      const events = await backend.eventArchive.read(0, snapshot.eventArchive.through)
      if (!events.length || events.at(-1)!.seq !== snapshot.eventArchive.through) fail('RECOVERY_EVENT_ARCHIVE_MISSING')
    }
    if (snapshot.factInbox?.dedupeLedger?.archivedThrough) {
      if (!backend.factInboxDedupeArchive) fail('RECOVERY_DEDUPE_ARCHIVE_MISSING')
      // Runtime.restore validates archive identity, prefix digest and membership before execution.
      const ledger = snapshot.factInbox.dedupeLedger
      if (backend.factInboxDedupeArchive.archiveId !== ledger.archiveId || backend.factInboxDedupeArchive.digestThrough(ledger.archivedThrough) !== ledger.archiveDigest) fail('RECOVERY_DEDUPE_ARCHIVE_MISSING')
    }
    return { snapshot, restored }
  } finally { await backend.close?.() }
}

export function unsafeRecoveryReasons(snapshot: RuntimePersistenceSnapshot): string[] {
  const restored = importRuntimePersistence(snapshot), reasons: string[] = []
  const root = [...restored.state.agents.values()].find(agent => agent.parentAgentId === undefined)
  if (!root || ['succeeded', 'failed', 'cancelled'].includes(root.state ?? '')) reasons.push('RECOVERY_TASK_ALREADY_FINISHED')
  for (const effect of restored.state.effects.values()) {
    if (effect.executionState === 'remote_unknown' || effect.sideEffectState === 'unknown') reasons.push('RECOVERY_SIDE_EFFECT_UNKNOWN')
    if (!effect.outcome && effect.kind === 'tool') {
      const input = effect.input as { name?: string; arguments?: unknown }
      if (/^(?:browser|computer|terminal)\./.test(input.name ?? '')) reasons.push('RECOVERY_MACHINE_RESOURCE_REQUIRED')
      // Claimed tool calls may have changed state before the source process stopped.
      if (snapshot.outbox.entries.some(entry => entry.effectId === effect.id && entry.state === 'claimed')) reasons.push('RECOVERY_SIDE_EFFECT_UNKNOWN')
      if (effect.sideEffectPolicy === 'write' || effect.sideEffectPolicy === 'external') reasons.push('RECOVERY_APPROVAL_RECONFIRM_REQUIRED')
    }
  }
  if (snapshot.quarantine?.length) reasons.push('RECOVERY_SIDE_EFFECT_UNKNOWN')
  if (pendingTransferredCalls(snapshot).some(call => /^(?:browser|computer|terminal)\./.test(call.name))) reasons.push('RECOVERY_MACHINE_RESOURCE_REQUIRED')
  if (snapshot.factInbox?.queue.some(envelope => {
    const fact = envelope.fact as { type?: string; effectId?: string }
    return /human|approval/.test(String(fact.type)) || Boolean(fact.effectId && restored.state.effects.get(fact.effectId)?.kind === 'human')
  })) reasons.push('RECOVERY_PENDING_AUTHORIZATION')
  return unique(reasons)
}

export function pendingTransferredCalls(snapshot: RuntimePersistenceSnapshot): Array<{ name: string; arguments: Record<string, unknown> }> {
  const { state } = importRuntimePersistence(snapshot)
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const add = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const call = raw as Record<string, unknown>, name = call.name ?? call.toolName, args = call.arguments ?? call.input
    if (typeof name === 'string' && args && typeof args === 'object' && !Array.isArray(args)) calls.push({ name, arguments: args as Record<string, unknown> })
  }
  for (const effect of state.effects.values()) {
    if (effect.outcome) continue
    if (effect.kind === 'tool') add(effect.input)
    if (effect.kind === 'human' && effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) && Array.isArray(effect.input.tools)) effect.input.tools.forEach(add)
  }
  for (const lane of state.lanes.values()) {
    const locals = lane.resume.locals as { $sdk?: Record<string, unknown> }
    for (const [key, value] of Object.entries(locals?.$sdk ?? {})) if (key.endsWith('QueuedTools') && Array.isArray(value)) for (const raw of value) add(raw?.input)
  }
  return calls
}

/** Only named path fields are portable. Shell command strings and arbitrary text are never rewritten. */
export function mapTransferredArguments(name: string, input: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const convert = (value: string): string => {
    if (value.split(/[\\/]/).includes('..')) fail('RECOVERY_PATH_NOT_PORTABLE', 409)
    const base = from.replaceAll('\\', '/').replace(/\/$/, ''), path = value.replaceAll('\\', '/')
    const target = to.replaceAll('\\', '/').replace(/\/$/, '')
    let relocated = value
    if (path === base) relocated = to
    else if (path.startsWith(`${base}/`)) relocated = join(to, ...path.slice(base.length + 1).split('/'))
    else if (!(path === target || path.startsWith(`${target}/`))) {
      if (posix.isAbsolute(path) || win32.isAbsolute(value)) fail('RECOVERY_PATH_NOT_PORTABLE', 409)
    }
    const normalized = relocated.replaceAll('\\', '/')
    if (normalized.split('/').includes('..')) fail('RECOVERY_PATH_NOT_PORTABLE', 409)
    if ((posix.isAbsolute(normalized) || win32.isAbsolute(relocated)) && normalized !== target && !normalized.startsWith(`${target}/`)) fail('RECOVERY_PATH_NOT_PORTABLE', 409)
    return relocated
  }
  const result = structuredClone(input)
  const fields = name === 'fs.move' ? ['source', 'destination'] : name.startsWith('fs.') ? ['path', 'from', 'to', 'directory', 'root'] : name === 'shell.exec' ? ['cwd'] : []
  for (const field of fields) if (typeof result[field] === 'string') result[field] = convert(result[field] as string)
  if (name === 'fs.apply_patches' && Array.isArray(result.patches)) result.patches = result.patches.map(item => { if (!item || typeof item !== 'object') fail('RECOVERY_PATH_NOT_PORTABLE', 409); return mapTransferredArguments('fs.apply_patch', item as Record<string, unknown>, from, to) })
  if (name === 'shell.exec') {
    // argv may contain opaque expressions or old-machine paths. Only cwd is safely relocatable.
    if (JSON.stringify([result.command, result.args]).includes(from) || (Array.isArray(result.args) && result.args.some(arg => typeof arg === 'string' && (posix.isAbsolute(arg) || win32.isAbsolute(arg))))) fail('RECOVERY_PATH_NOT_PORTABLE', 409)
  }
  return result
}

export async function transferWorkspaceReasons(source: { available: boolean; digest?: string | undefined }, target: string): Promise<string[]> {
  const stamp = await workspaceStamp(target)
  if (!source.available || !stamp.available) return ['WORKSPACE_FINGERPRINT_UNAVAILABLE']
  return source.digest === stamp.digest ? [] : ['WORKSPACE_CONTENT_MISMATCH']
}

/** A display projection only: approval digests and persisted calls retain their original identity. */
export function presentTransferredApproval(input: Record<string, import('@hunterzhu/pulse-runtime').JsonValue>, relocation: { source: string; target: string }): Record<string, import('@hunterzhu/pulse-runtime').JsonValue> {
  const result = structuredClone(input)
  if (Array.isArray(result.tools)) result.tools = result.tools.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const name = typeof raw.toolName === 'string' ? raw.toolName : typeof raw.name === 'string' ? raw.name : ''
    const args = raw.input ?? raw.arguments
    if (!name || !args || typeof args !== 'object' || Array.isArray(args)) return raw
    return { ...raw, ...(raw.input !== undefined ? { input: mapTransferredArguments(name, args, relocation.source, relocation.target) as import('@hunterzhu/pulse-runtime').JsonValue } : { arguments: mapTransferredArguments(name, args, relocation.source, relocation.target) as import('@hunterzhu/pulse-runtime').JsonValue }) }
  })
  return result
}
