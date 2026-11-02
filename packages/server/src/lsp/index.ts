import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, posix, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { defineTool, type ToolRegistry, type ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { resolveShellIdentity, windowsSystemExecutable } from '@hunterzhu/pulse-adapters'
import { LspFrames, lspFrame } from './protocol.js'

export interface LspServerConfig { command: string; args?: string[]; languages: Record<string, string>; readRoots?: string[]; initializationOptions?: Record<string, unknown> }
export interface LspConfig { enabled?: boolean; servers?: Record<string, LspServerConfig> }
export const lspTemplates: Record<string, LspServerConfig> = {
  typescript: { command: 'typescript-language-server', args: ['--stdio'], languages: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact' } },
  python: { command: 'pylsp', languages: { '.py': 'python' } },
  go: { command: 'gopls', languages: { '.go': 'go' } },
  rust: { command: 'rust-analyzer', languages: { '.rs': 'rust' }, initializationOptions: { checkOnSave: false } },
}
const SERVER_KEYS = new Set(['command', 'args', 'languages', 'readRoots', 'initializationOptions'])
const SYMBOL_LIMIT = 100
const SYMBOL_DEPTH = 8
export const LSP_CANCEL_QUIET_MS = 500
export const LSP_HELPER_EXIT_GRACE_MS = 250

function invalidConfig(): never { throw new Error('LSP_CONFIG_INVALID') }

function parseServer(raw: unknown): LspServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidConfig()
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!SERVER_KEYS.has(key)) invalidConfig()
  if (typeof input.command !== 'string' || input.command.length === 0 || input.command.length > 4000) invalidConfig()
  let args: string[] | undefined
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some(item => typeof item !== 'string' || item.length > 8000)) invalidConfig()
    args = [...input.args]
  }
  if (!input.languages || typeof input.languages !== 'object' || Array.isArray(input.languages)) invalidConfig()
  const languages: Record<string, string> = {}
  const languageEntries = Object.entries(input.languages as Record<string, unknown>)
  if (languageEntries.length === 0 || languageEntries.length > 64) invalidConfig()
  for (const [ext, id] of languageEntries) {
    if (!ext.startsWith('.') || ext.length > 32 || ext.includes('/') || ext.includes('\\') || typeof id !== 'string' || id.length === 0 || id.length > 128) invalidConfig()
    languages[ext] = id
  }
  let readRoots: string[] | undefined
  if (input.readRoots !== undefined) {
    if (!Array.isArray(input.readRoots) || input.readRoots.length > 32 || input.readRoots.some(item => typeof item !== 'string' || item.length === 0 || item.length > 4000)) invalidConfig()
    readRoots = [...input.readRoots]
  }
  let initializationOptions: Record<string, unknown> | undefined
  if (input.initializationOptions !== undefined) {
    if (!input.initializationOptions || typeof input.initializationOptions !== 'object' || Array.isArray(input.initializationOptions)) invalidConfig()
    try { initializationOptions = structuredClone(input.initializationOptions) as Record<string, unknown> } catch { invalidConfig() }
  }
  return { command: input.command, ...(args ? { args } : {}), languages, ...(readRoots ? { readRoots } : {}), ...(initializationOptions ? { initializationOptions } : {}) }
}

/** Explicit boolean enable, known keys only, and a clone that cannot retarget the workspace. */
export function parseLspConfig(value: unknown): LspConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidConfig()
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) if (key !== 'enabled' && key !== 'servers') invalidConfig()
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') invalidConfig()
  let servers: Record<string, LspServerConfig> | undefined
  if (input.servers !== undefined) {
    if (!input.servers || typeof input.servers !== 'object' || Array.isArray(input.servers)) invalidConfig()
    const entries = Object.entries(input.servers as Record<string, unknown>)
    if (entries.length > 32) invalidConfig()
    servers = {}
    for (const [name, raw] of entries) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) invalidConfig()
      servers[name] = parseServer(raw)
    }
  }
  return { enabled: input.enabled === true, ...(servers ? { servers } : {}) }
}

function pathApi(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? win32 : posix
}

/** UNC and extended-UNC paths. Rejected before any filesystem call. */
export function isUncPath(value: string): boolean {
  const normalized = value.replaceAll('/', '\\')
  if (normalized.startsWith('\\\\?\\UNC\\') || normalized.startsWith('\\\\.\\UNC\\')) return true
  if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) return false
  return normalized.startsWith('\\\\')
}

/** Local file URL path, or undefined for non-file, remote-host, and UNC targets. */
export function localFilePath(uri: string): string | undefined {
  let url: URL
  try { url = new URL(uri) } catch { return undefined }
  if (url.protocol !== 'file:') return undefined
  if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return undefined
  try {
    const file = fileURLToPath(url)
    return isUncPath(file) ? undefined : file
  } catch { return undefined }
}

/** True when a candidate is outside root without following symlinks or touching the filesystem. */
export function lexicalOutsideWorkspace(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  if (candidate.startsWith('file:')) {
    const file = localFilePath(candidate)
    if (file === undefined) return true
    candidate = file
  }
  const api = pathApi(platform)
  if (isUncPath(candidate)) return true
  const lexical = api.isAbsolute(candidate) ? api.normalize(candidate) : api.resolve(root, candidate)
  if (isUncPath(lexical)) return true
  const rel = api.relative(api.normalize(root), lexical)
  return api.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')
}

/** Absolute System32 taskkill. A bare name would be resolved from the project cwd before PATH. */
export function windowsSystemTaskkill(systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT): string | undefined {
  return windowsSystemExecutable('taskkill.exe', systemRoot)
}

async function locateWorkspaceFile(root: string, uri: string): Promise<string | undefined> {
  const file = localFilePath(uri)
  if (file === undefined || lexicalOutsideWorkspace(root, file)) return undefined
  let canonical: string
  try { canonical = await realpath(file) } catch { return undefined }
  if (lexicalOutsideWorkspace(root, canonical)) return undefined
  return pathApi().relative(root, canonical)
}

export interface OwnedHelper {
  pid?: number | undefined
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
  stdin?: { end(): unknown } | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'close', listener: () => void): unknown
}

export function ownedHelperLive(child: OwnedHelper, ownedPid: number | undefined): boolean {
  return ownedPid !== undefined && child.pid === ownedPid && child.exitCode == null && child.signalCode == null
}

/** End the helper's stdin, then on Windows kill only that same still-live process tree. */
export function releaseOwnedHelper(child: OwnedHelper | undefined, ownedPid: number | undefined, platform: NodeJS.Platform = process.platform, taskkill?: (file: string, args: string[]) => void): void {
  child?.stdin?.end()
  if (!child || !ownedHelperLive(child, ownedPid)) return
  if (platform !== 'win32') { child.kill('SIGTERM'); return }
  const timer = setTimeout(() => {
    if (!ownedHelperLive(child, ownedPid)) return
    const launch = taskkill ?? ((file: string, args: string[]) => {
      const tree = spawn(file, args, { stdio: 'ignore', windowsHide: true, cwd: win32.dirname(file) })
      tree.once('error', () => { if (ownedHelperLive(child, ownedPid)) child.kill('SIGTERM') })
      tree.unref()
    })
    const file = windowsSystemTaskkill()
    if (!file) { if (ownedHelperLive(child, ownedPid)) child.kill('SIGTERM'); return }
    try { launch(file, ['/PID', String(ownedPid), '/T', '/F']) } catch { if (ownedHelperLive(child, ownedPid)) child.kill('SIGTERM') }
  }, LSP_HELPER_EXIT_GRACE_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

type Document = { uri: string; path: string; hash: string; text: string; version: number; diagnostics?: { version?: number; items: any[] } }
type Pending = { resolve(value: any): void; reject(error: Error): void; cleanup(): void }
class Connection {
  private child: ChildProcessWithoutNullStreams | undefined
  private ownedPid: number | undefined
  private silence: ReturnType<typeof setTimeout> | undefined
  private next = 1
  private pending = new Map<number, Pending>()
  readonly documents = new Map<string, Document>()
  capabilities: Record<string, any> = {}
  private connecting: Promise<void> | undefined
  private closed = false
  constructor(readonly root: string, readonly config: LspServerConfig, readonly lifetime: AbortSignal) { lifetime.addEventListener('abort', () => this.close(), { once: true }) }
  async connect(): Promise<void> { return this.connecting ??= this.start() }
  private async start(): Promise<void> {
    this.lifetime.throwIfAborted()
    const identity = await resolveShellIdentity(this.config.command, this.config.args ?? [], this.root)
    this.lifetime.throwIfAborted()
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'PNPM_HOME', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key] !== undefined) env[key] = process.env[key]
    const spec = Buffer.from(JSON.stringify({ root: this.root, command: this.config.command, args: this.config.args ?? [], ...(this.config.readRoots ? { readRoots: this.config.readRoots } : {}), identity })).toString('base64')
    const child = this.child = spawn(process.execPath, [fileURLToPath(new URL('./worker.cjs', import.meta.url)), spec], { cwd: this.root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    this.ownedPid = child.pid
    const parser = new LspFrames(message => this.message(message))
    child.stdin.on('error', () => this.close())
    child.stderr.on('data', () => {})
    child.stdout.on('data', () => {})
    const output = child.stdio[3] as Readable
    output.on('data', chunk => { try { parser.push(chunk) } catch { this.close() } })
    // The RPC transport may end before the helper finishes native cleanup.
    output.once('end', () => this.close(true))
    output.once('error', () => this.close())
    child.once('error', () => this.close())
    child.once('close', () => { this.ownedPid = undefined; this.close() })
    const initial = await this.request('initialize', { processId: null, rootUri: pathToFileURL(this.root).href, workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: 'workspace' }], capabilities: { textDocument: { definition: { linkSupport: true }, diagnostic: { dynamicRegistration: false } } }, initializationOptions: this.config.initializationOptions ?? {} }, this.lifetime, process.platform === 'win32' ? 240000 : 30000)
    this.capabilities = initial?.capabilities ?? {}; this.notify('initialized', {})
  }
  private noteActivity(): void {
    if (!this.silence) return
    clearTimeout(this.silence)
    this.silence = undefined
  }
  private armSilence(): void {
    if (this.closed || this.silence) return
    this.silence = setTimeout(() => { this.silence = undefined; if (!this.closed) this.close() }, LSP_CANCEL_QUIET_MS)
    this.silence.unref()
  }
  private message(message: any): void {
    this.noteActivity()
    if (typeof message.method === 'string') {
      if (message.method === 'textDocument/publishDiagnostics') {
        const doc = this.documents.get(message.params?.uri)
        if (doc) doc.diagnostics = { ...(Number.isInteger(message.params.version) ? { version: message.params.version } : {}), items: Array.isArray(message.params.diagnostics) ? message.params.diagnostics.slice(0, 100) : [] }
      } else if (message.id !== undefined) {
        // Server requests cannot apply edits, run commands or load workspace settings.
        const allowed = message.method === 'workspace/configuration' || message.method === 'window/workDoneProgress/create'
        this.send({ jsonrpc: '2.0', id: message.id, ...(allowed ? { result: message.method === 'workspace/configuration' ? (message.params?.items ?? []).slice(0, 100).map(() => null) : null } : { error: { code: -32601, message: 'Read-only LSP client' } }) })
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id); pending.cleanup()
    if (message.error) pending.reject(new Error('LSP_REQUEST_FAILED')); else pending.resolve(message.result)
  }
  private send(value: unknown): void { if (this.closed || !this.child?.stdin.writable) throw new Error('LSP_SERVER_UNAVAILABLE'); this.child.stdin.write(lspFrame(value)) }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }) }
  request(method: string, params: unknown, signal: AbortSignal, timeoutMs = 15000): Promise<any> {
    signal.throwIfAborted()
    return new Promise((resolveValue, reject) => {
      const id = this.next++
      const finish = (error: Error, cancelled = false) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        try { this.notify('$/cancelRequest', { id }) } catch { /* The caller is already leaving this request. */ }
        reject(error)
        if (cancelled) this.armSilence()
      }
      const abort = () => finish(new Error('LSP_REQUEST_CANCELLED'), true)
      const timer = setTimeout(() => { finish(new Error('LSP_REQUEST_TIMEOUT')); this.close() }, timeoutMs)
      this.pending.set(id, { resolve: resolveValue, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) } })
      signal.addEventListener('abort', abort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch { finish(new Error('LSP_SERVER_UNAVAILABLE')) }
    })
  }
  close(drainNativeCleanup = false): void {
    if (this.closed) return; this.closed = true
    if (this.silence) { clearTimeout(this.silence); this.silence = undefined }
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error('LSP_SERVER_UNAVAILABLE')) }
    this.pending.clear(); this.documents.clear()
    const child = this.child
    const owned = this.ownedPid
    this.ownedPid = undefined
    // Natural transport EOF is not a stuck helper. End input to stop a target
    // that closed stdout but kept running, then let the trusted wrapper finish
    // bounded native cleanup instead of taskkilling it during ACL restoration.
    if (drainNativeCleanup) child?.stdin?.end()
    else releaseOwnedHelper(child, owned)
  }
  get unavailable(): boolean { return this.closed }
}

function cleanRange(value: any): unknown {
  const point = (v: any) => v && Number.isSafeInteger(v.line) && v.line >= 0 && Number.isSafeInteger(v.character) && v.character >= 0 ? { line: v.line, character: v.character } : undefined
  const start = point(value?.start), end = point(value?.end); return start && end ? { start, end } : undefined
}

async function collectSymbols(items: unknown[], depth: number, budget: { left: number }, root: string): Promise<{ nodes: unknown[]; truncated: boolean }> {
  if (depth > SYMBOL_DEPTH) return { nodes: [], truncated: items.length > 0 }
  const nodes: unknown[] = []
  let truncated = false
  for (const item of items) {
    if (budget.left <= 0) return { nodes, truncated: true }
    budget.left--
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, any>
    const uri = record.targetUri ?? record.uri ?? record.location?.uri
    const node: Record<string, unknown> = {
      name: String(record.name ?? '').slice(0, 500),
      kind: Number.isInteger(record.kind) ? record.kind : undefined,
      range: cleanRange(record.selectionRange ?? record.range ?? record.location?.range),
    }
    if (uri !== undefined) {
      const located = await locateWorkspaceFile(root, String(uri))
      if (!located) continue
      node.path = located
    }
    const children = Array.isArray(record.children) ? record.children : []
    if (children.length > 0) {
      const nested = await collectSymbols(children, depth + 1, budget, root)
      if (nested.nodes.length > 0) node.children = nested.nodes
      if (nested.truncated) truncated = true
    }
    nodes.push(node)
  }
  return { nodes, truncated }
}

export class LspService {
  private readonly connections = new Map<string, Connection>()
  private readonly config: LspConfig | undefined
  constructor(private readonly root: string, config: LspConfig | undefined, private readonly lifetime: AbortSignal) {
    this.config = config === undefined ? undefined : parseLspConfig(config)
  }
  private async document(path: string, signal: AbortSignal): Promise<{ connection: Connection; doc: Document }> {
    this.lifetime.throwIfAborted()
    if (this.config?.enabled !== true) throw new Error('CODE_SERVER_UNAVAILABLE')
    const root = await realpath(this.root)
    if (lexicalOutsideWorkspace(root, path)) throw new Error('CODE_PATH_OUTSIDE_WORKSPACE')
    const absolute = await realpath(pathApi().resolve(root, path))
    if (lexicalOutsideWorkspace(root, absolute)) throw new Error('CODE_PATH_OUTSIDE_WORKSPACE')
    const server = Object.entries(this.config.servers ?? {}).sort(([a], [b]) => a.localeCompare(b)).find(([, s]) => s.languages[extname(absolute)])
    if (!server) throw new Error('CODE_SERVER_UNAVAILABLE')
    const [key, config] = server
    let connection = this.connections.get(key)
    if (!connection || connection.unavailable) { connection = new Connection(root, config, this.lifetime); this.connections.set(key, connection) }
    try {
      await new Promise<void>((done, fail) => {
        const abort = () => { connection!.close(); fail(new Error('LSP_REQUEST_CANCELLED')) }; signal.addEventListener('abort', abort, { once: true })
        connection!.connect().then(done, fail).finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
      })
    } catch { connection.close(); throw new Error('CODE_SERVER_UNAVAILABLE') }
    const bytes = await readFile(absolute); if (bytes.length > 2 * 1024 * 1024) throw new Error('CODE_DOCUMENT_TOO_LARGE')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash = createHash('sha256').update(bytes).digest('hex'), uri = pathToFileURL(absolute).href
    let doc = connection.documents.get(uri)
    if (!doc) {
      if (connection.documents.size >= 32) { const [oldUri] = connection.documents.keys(); connection.notify('textDocument/didClose', { textDocument: { uri: oldUri } }); connection.documents.delete(oldUri!) }
      doc = { uri, path: absolute, text, hash, version: 1 }; connection.documents.set(uri, doc)
      connection.notify('textDocument/didOpen', { textDocument: { uri, languageId: config.languages[extname(absolute)], version: 1, text } })
    } else if (doc.hash !== hash) {
      doc.hash = hash; doc.text = text; doc.version++; delete doc.diagnostics
      connection.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] })
    }
    return { connection, doc }
  }
  async query(kind: 'definition' | 'references' | 'symbols' | 'diagnostics', input: { path: string; line?: number; column?: number }, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    const { connection, doc } = await this.document(input.path, signal), hash = doc.hash, version = doc.version
    signal.throwIfAborted()
    const position = { line: (input.line ?? 1) - 1, character: (input.column ?? 1) - 1 }
    let result: any, freshness: string = 'current'
    if (kind === 'diagnostics') {
      if (connection.capabilities.diagnosticProvider) result = (await connection.request('textDocument/diagnostic', { textDocument: { uri: doc.uri } }, signal))?.items ?? []
      else { result = doc.diagnostics?.items ?? []; freshness = doc.diagnostics?.version === version ? 'current' : 'unverified' }
    } else result = await connection.request(kind === 'symbols' ? 'textDocument/documentSymbol' : `textDocument/${kind}`, { textDocument: { uri: doc.uri }, position, ...(kind === 'references' ? { context: { includeDeclaration: true } } : {}) }, signal)
    const now = createHash('sha256').update(await readFile(doc.path)).digest('hex')
    if (now !== hash || doc.version !== version) freshness = 'stale'
    const raw = Array.isArray(result) ? result : result ? [result] : []
    const note = 'Navigation/diagnostics do not grant full-file read coverage or replace compilation/acceptance.'
    const root = await realpath(this.root)
    if (kind === 'symbols') {
      const collected = await collectSymbols(raw, 1, { left: SYMBOL_LIMIT }, root)
      return { path: input.path, hash, version, freshness, items: collected.nodes, truncated: collected.truncated, note }
    }
    const items: unknown[] = []
    for (const item of raw.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue
      const uri = item.targetUri ?? item.uri ?? item.location?.uri
      if (uri) {
        const rel = await locateWorkspaceFile(root, String(uri))
        if (!rel) continue
        items.push({ path: rel, range: cleanRange(item.targetSelectionRange ?? item.range ?? item.location?.range) })
      } else if (kind === 'diagnostics') items.push({ message: String(item.message ?? '').slice(0, 2000), range: cleanRange(item.range), severity: Number.isInteger(item.severity) ? item.severity : undefined, code: typeof item.code === 'string' ? item.code.slice(0, 100) : Number.isFinite(item.code) ? item.code : undefined })
    }
    return { path: input.path, hash, version, freshness, items, truncated: raw.length > 100, note }
  }
}
export function registerLspTools(registry: ToolRegistry, service: LspService): void {
  for (const kind of ['definition', 'references', 'symbols', 'diagnostics'] as const) registry.register(defineTool({
    name: `code.${kind}`, description: `Read-only LSP ${kind}; requires an explicitly configured installed language server. Line/column inputs are one-based UTF-16 positions. No installation or network access.`,
    input: z.object({ path: z.string().min(1).max(2000), ...(['definition', 'references'].includes(kind) ? { line: z.number().int().positive(), column: z.number().int().positive() } : {}) }).strict(), output: z.unknown(), sideEffectPolicy: 'read', retrySafety: 'read_only', defaultTimeoutMs: process.platform === 'win32' ? 270000 : 45000,
    execute: (input: { path: string; line?: number; column?: number }, context: ToolContext) => service.query(kind, input, context.signal),
  }))
}
