import { AttachmentStore, MAX_ATTACHMENT_REQUEST, attachmentDownload } from '../attachments.js'
import { createServer, IncomingMessage, type Server, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { normalizeModelConfig, parseModelSelectionId } from '../model-config.js'
import { execFile } from 'node:child_process'
import { access, chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type * as pty from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'
import QRCode from 'qrcode'
import type { JsonValue } from '@hunterzhu/pulse-runtime'
import type { AssistantEvent, ConversationSummary, LocalHost, LocalHostOptions, RunHandle } from '../index.js'
import type { WebAttachment, WebAssistantMessageReceipt, WebLane, WebRunLanes, WebAssistantWorkInteraction, WebMessage, WebPendingInteraction, WebProject, WebRunEvent, WebRunSnapshot } from '../protocol.js'
import { H5AuthStore } from './auth.js'
import { createHostDirectory, hostFilesystemError, hostPathRoots, listHostPaths } from './host-filesystem.js'
import type { HostPathMode } from '../protocol.js'
import { compactTraceEvents, prepareRunEvent, traceWatermark } from './trace.js'
import { AssistantConversationStore, type QueuedAssistantMessage } from './assistant.js'
import { H5ProjectCatalog } from './projects.js'
import { H5WorkspaceManager } from './workspaces.js'
import { startH5WorkWorker, type H5WorkWorkerLaunchOptions } from './work-worker.js'
import { SleepInhibitor } from './caffeinate.js'
import { getLocalNetworkIp, isAllowedH5Host, isLoopbackIp } from './network.js'
import { safeShellEnv, searchWorkspace, within } from '../security.js'
import { BundleError, stageConversationBundle, type StagedBundle, type BundlePreview } from '../conversation-bundle.js'
import { pipeline } from 'node:stream/promises'

const execFileAsync = promisify(execFile)

function isSafePathId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.includes('/') && !value.includes('\\') && !value.includes('..')
}

interface SseClient {
  res: ServerResponse
  sent: number
}

interface TerminalSession {
  id: string
  projectId: string
  deviceId: string
  process: pty.IPty
  clients: Set<WebSocket>
  output: string
  exited?: { code: number; signal?: number }
  closedAt?: number
}

// Jarvis uses 7330 for its API and 7331 for MCP.
export const DEFAULT_H5_PORT = 7332
const webDistCandidates = [
  resolve(fileURLToPath(new URL('../web/', import.meta.url))),
  resolve(fileURLToPath(new URL('../../../web/dist/', import.meta.url))),
]
const assetTypes: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }
const KEEP_SECRET = '__PULSE_KEEP_SECRET__'
const require = createRequire(import.meta.url)

async function ensurePtyHelperExecutable(): Promise<void> {
  // Only Darwin's native implementation executes spawn-helper.
  if (process.platform !== 'darwin') return
  const packageRoot = resolve(dirname(require.resolve('node-pty')), '..')
  // Match node-pty's native loader so source builds use their own helper too.
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    try { require(join(packageRoot, directory, 'pty.node')) } catch { continue }
    const helper = join(packageRoot, directory, 'spawn-helper')
    const info = await stat(helper)
    if (!info.isFile()) throw new Error('PTY_HELPER_MISSING')
    // Some package mirrors extract the published helper without its executable bit.
    if ((info.mode & 0o111) === 0) await chmod(helper, 0o755)
    return
  }
  throw new Error('PTY_HELPER_MISSING')
}

function configVersion(raw: string): string { return createHash('sha256').update(raw).digest('hex') }
function maskConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(config)
  const jarvis = copy.jarvis && typeof copy.jarvis === 'object' && !Array.isArray(copy.jarvis) ? copy.jarvis as Record<string, unknown> : undefined
  if (jarvis && typeof jarvis.token === 'string' && jarvis.token) jarvis.token = KEEP_SECRET
  const capabilities = copy.capabilities && typeof copy.capabilities === 'object' && !Array.isArray(copy.capabilities) ? copy.capabilities as Record<string, unknown> : undefined
  const servers = capabilities?.mcpServers && typeof capabilities.mcpServers === 'object' && !Array.isArray(capabilities.mcpServers) ? capabilities.mcpServers as Record<string, unknown> : undefined
  for (const server of Object.values(servers ?? {})) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue
    const env = (server as Record<string, unknown>).env
    if (env && typeof env === 'object' && !Array.isArray(env)) for (const key of Object.keys(env)) (env as Record<string, unknown>)[key] = KEEP_SECRET
  }
  return copy
}

function preserveConfigSecrets(existing: Record<string, unknown>, candidate: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(candidate)
  const oldJarvis = existing.jarvis && typeof existing.jarvis === 'object' && !Array.isArray(existing.jarvis) ? existing.jarvis as Record<string, unknown> : undefined
  const newJarvis = copy.jarvis && typeof copy.jarvis === 'object' && !Array.isArray(copy.jarvis) ? copy.jarvis as Record<string, unknown> : undefined
  if (newJarvis?.token === KEEP_SECRET) {
    if (typeof oldJarvis?.token === 'string') newJarvis.token = oldJarvis.token
    else delete newJarvis.token
  }
  const oldCaps = existing.capabilities && typeof existing.capabilities === 'object' && !Array.isArray(existing.capabilities) ? existing.capabilities as Record<string, unknown> : undefined
  const newCaps = copy.capabilities && typeof copy.capabilities === 'object' && !Array.isArray(copy.capabilities) ? copy.capabilities as Record<string, unknown> : undefined
  const oldServers = oldCaps?.mcpServers && typeof oldCaps.mcpServers === 'object' && !Array.isArray(oldCaps.mcpServers) ? oldCaps.mcpServers as Record<string, unknown> : undefined
  const newServers = newCaps?.mcpServers && typeof newCaps.mcpServers === 'object' && !Array.isArray(newCaps.mcpServers) ? newCaps.mcpServers as Record<string, unknown> : undefined
  for (const [id, value] of Object.entries(newServers ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const nextEnv = (value as Record<string, unknown>).env
    const prior = oldServers?.[id] && typeof oldServers[id] === 'object' && !Array.isArray(oldServers[id]) ? (oldServers[id] as Record<string, unknown>).env : undefined
    const priorEnv = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior as Record<string, unknown> : {}
    if (nextEnv && typeof nextEnv === 'object' && !Array.isArray(nextEnv)) {
      for (const [key, secret] of Object.entries(nextEnv as Record<string, unknown>)) if (secret === KEEP_SECRET && typeof priorEnv[key] === 'string') (nextEnv as Record<string, unknown>)[key] = priorEnv[key]
    }
  }
  return copy
}

export interface H5ServerOptions {
  port?: number
  host?: string
  dataDir: string
  configuration?: { path: string; prepare: (candidatePath: string) => Promise<LocalHostOptions> }
  /** CLI entry used to launch isolated work-run processes. Omitted in embedded/test hosts. */
  workWorker?: H5WorkWorkerLaunchOptions
}

export class H5Server {
  private readonly port: number
  private effectivePort: number
  private readonly hostAddress: string
  private readonly dataDir: string
  private webDistDirectory: string | undefined
  private readonly auth: H5AuthStore
  private readonly projects: H5ProjectCatalog
  private readonly workspaces: H5WorkspaceManager
  private readonly assistantInbox: AssistantConversationStore
  private readonly configuration: H5ServerOptions['configuration']
  private readonly workWorker: H5ServerOptions['workWorker']
  private readonly inhibitor = new SleepInhibitor()
  private server: Server | undefined = undefined
  private readonly activeRuns = new Map<string, RunHandle>()
  private readonly runConsumers = new Set<Promise<void>>()
  private readonly runConversations = new Map<string, string>()
  private readonly runEventBuffers = new Map<string, AssistantEvent[]>()
  private readonly runSseClients = new Map<string, Set<SseClient>>()
  private readonly bufferTimers = new Map<string, NodeJS.Timeout>()
  private readonly reviewNotes = new Map<string, string>()
  private readonly approvalReviewControllers = new Map<string, AbortController>()
  private readonly approvalReviewAgain = new Set<string>()
  private readonly batchReplyLocks = new Map<string, Promise<void>>()
  private readonly previewTickets = new Map<string, { projectId: string; origin: string; expiresAt: number }>()
  private readonly terminals = new Map<string, TerminalSession>()
  private readonly assistantPendingRuns = new Set<string>()
  private assistantPump: Promise<void> | undefined
  private serviceLock: Awaited<ReturnType<typeof open>> | undefined
  private stopping = false
  private jarvisSyncTimer: NodeJS.Timeout | undefined
  private readonly chatSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_ATTACHMENT_REQUEST })
  private readonly chatSubscriptions = new Map<WebSocket, Map<string, number>>()
  private dataChanged: (() => void) | undefined
  private readonly runSnapshots = new Map<string, WebRunSnapshot>()
  private readonly projectionWrites = new Map<string, Promise<unknown>>()
  private readonly projectionTimers = new Map<string, NodeJS.Timeout>()
  private readonly terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private readonly automationSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private readonly previewSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  private configWriteTail: Promise<void> = Promise.resolve()
  private readonly bundleImports = new Map<string, { bundle: StagedBundle; deviceId: string; timer: NodeJS.Timeout; expiresAt: number }>()
  private readonly bundleUploads = new Map<string, number>()

  constructor(
    private readonly host: LocalHost,
    options: H5ServerOptions
  ) {
    this.port = options.port ?? DEFAULT_H5_PORT
    this.effectivePort = this.port
    this.hostAddress = options.host ?? '0.0.0.0'
    this.dataDir = resolve(options.dataDir)
    this.auth = new H5AuthStore(options.dataDir)
    this.projects = new H5ProjectCatalog(options.dataDir)
    this.workspaces = new H5WorkspaceManager(options.dataDir)
    this.assistantInbox = new AssistantConversationStore(options.dataDir)
    this.configuration = options.configuration
    this.workWorker = options.workWorker
    this.host.setAssistantWorkTools({
      start: (projectId, task) => this.startWorkFromAssistant(projectId, task),
      list: projectId => this.listWorkSessions(projectId),
      status: conversationId => this.workStatus(conversationId),
      send: (conversationId, text) => this.sendToWork(conversationId, text),
      stop: conversationId => this.stopWork(conversationId),
      resume: conversationId => this.resumeWork(conversationId),
    })
  }

  private async configText(path = this.configuration?.path): Promise<string> {
    if (!path) throw new Error('CONFIGURATION_UNAVAILABLE')
    return readFile(path, 'utf8').catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? '{}' : Promise.reject(error))
  }

  private async withConfigWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.configWriteTail
    let release!: () => void
    this.configWriteTail = new Promise<void>(resolveLock => { release = resolveLock })
    await previous
    try { return await operation() } finally { release() }
  }

  private parseConfig(text: string): Record<string, unknown> {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_OBJECT_REQUIRED')
    return value as Record<string, unknown>
  }

  private async validateConfigCandidate(config: Record<string, unknown>): Promise<{ text: string; options: LocalHostOptions }> {
    if (!this.configuration) throw new Error('CONFIGURATION_UNAVAILABLE')
    const normalizedConfig = normalizeModelConfig(config)
    const text = `${JSON.stringify(normalizedConfig, null, 2)}\n`
    const temporary = `${this.configuration.path}.${randomUUID()}.validate.tmp`
    await mkdir(dirname(this.configuration.path), { recursive: true })
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
      await chmod(temporary, 0o600)
      const options = await this.configuration.prepare(temporary)
      return { text, options }
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  private async replaceConfig(text: string): Promise<void> {
    if (!this.configuration) throw new Error('CONFIGURATION_UNAVAILABLE')
    const path = this.configuration.path
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
      await chmod(temporary, 0o600)
      if (await access(path).then(() => true, () => false)) {
        const backup = `${path}.bak`
        await copyFile(path, backup)
        await chmod(backup, 0o600)
      }
      await rename(temporary, path)
      await chmod(path, 0o600)
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  private configSources(): Record<string, unknown> {
    const vars = ['PULSE_CONFIG', 'PULSE_DATA_DIR', 'PULSE_MODEL', 'PULSE_APPROVAL_MODE', 'PULSE_MAX_TURNS', 'PULSE_MAX_MODEL_CALLS', 'PULSE_MAX_RUNTIME_MS', 'PULSE_AUTO_COMPACT_PERCENT', 'PULSE_ALLOW_NETWORK', 'PULSE_JARVIS_ENABLED', 'PULSE_JARVIS_API_URL', 'PULSE_FRONT_MODEL']
    return Object.fromEntries(vars.filter(name => process.env[name] !== undefined).map(name => [name, { source: 'environment', active: true }]))
  }

  private async acquireService(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const path = join(this.dataDir, 'service.lock')
    for (;;) {
      try { this.serviceLock = await open(path, 'wx', 0o600); await this.serviceLock.writeFile(JSON.stringify({ pid: process.pid, protocol: 1 })); return }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const previous = await readFile(path, 'utf8')
        const owner = JSON.parse(previous) as { pid: number }
        try { process.kill(owner.pid, 0); throw new Error('PULSE_SERVICE_ALREADY_RUNNING') }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
        if (await readFile(path, 'utf8') === previous) await rm(path, { force: true })
      }
    }
  }
  private async releaseService(): Promise<void> {
    if (!this.serviceLock) return
    await this.serviceLock.close(); this.serviceLock = undefined
    await rm(join(this.dataDir, 'service.json'), { force: true })
    await rm(join(this.dataDir, 'service.lock'), { force: true })
  }

  async start(): Promise<{ port: number; lanIp: string; pairUrl: string }> {
    this.stopping = false
    await this.acquireService()
    try {
    await this.auth.init()
    const assistantId = await this.assistantInbox.init(async () => (await this.host.createConversation({ title: 'Pulse 助理' })).id)
    for (const message of this.assistantInbox.transcript(true)) {
      await this.host.appendAssistantUserMessage(assistantId, { id: `msg-${message.requestId}`, runId: message.runId, text: message.text, createdAt: message.createdAt, ...(message.attachments ? { attachments: message.attachments } : {}), ...(message.skills ? { skills: message.skills } : {}), ...(message.mentionedFiles ? { mentionedFiles: message.mentionedFiles } : {}) })
    }
    const initialConversations = (await this.host.listConversations()).filter(conversation => conversation.id !== assistantId)
    await this.projects.migrate(initialConversations)
    for (const conversation of initialConversations) if (!conversation.projectId && !conversation.projectUnassigned && !conversation.archivedAt) {
      const project = await this.projects.findByCwd(conversation.cwd)
      if (project) await this.host.updateConversationOrganization(conversation.id, { projectId: project.id })
    }
    for (const candidate of webDistCandidates) {
      if (await access(resolve(candidate, 'index.html')).then(() => true, () => false)) { this.webDistDirectory = candidate; break }
    }
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message !== 'INVALID_JSON' && message !== 'PAYLOAD_TOO_LARGE') {
          process.stderr.write(`h5 request failed: ${message}\n`)
        }
        if (!res.headersSent) {
          const status = message === 'PAYLOAD_TOO_LARGE' ? 413 : message === 'INVALID_JSON' ? 400 : message === 'CONVERSATION_BUSY' || message === 'REQUEST_ID_REUSED' || message === 'ASSISTANT_MESSAGE_ALREADY_COMPLETED' ? 409 : 500
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: message === 'PAYLOAD_TOO_LARGE' || message === 'INVALID_JSON' || message === 'CONVERSATION_BUSY' || message === 'REQUEST_ID_REUSED' || message === 'ASSISTANT_MESSAGE_ALREADY_COMPLETED' ? message : 'INTERNAL_ERROR' }))
        } else if (!res.writableEnded) {
          res.destroy(err instanceof Error ? err : undefined)
        }
      })
    })
    server.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').startsWith('/api/chat/socket')) void this.handleChatUpgrade(req, socket, head)
      else if ((req.url ?? '').startsWith('/api/automation/socket')) void this.handleAutomationUpgrade(req, socket, head)
      else if ((req.url ?? '').startsWith('/preview/')) void this.handlePreviewUpgrade(req, socket, head)
      else void this.handleTerminalUpgrade(req, socket, head)
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(this.port, this.hostAddress, () => resolve())
      server.on('error', reject)
    })
    this.server = server
    this.dataChanged = this.host.conversationData.onChange(revision => {
      for (const client of this.chatSockets.clients) this.sendChat(client, { type: 'changed', revision })
    })
    void this.pumpAssistantInbox()
    void this.host.retryJarvisSync()
    this.jarvisSyncTimer = setInterval(() => { void this.host.retryJarvisSync() }, 15_000)

    const addr = server.address()
    this.effectivePort = typeof addr === 'object' && addr ? addr.port : this.port

    const lanIp = getLocalNetworkIp()
    const pairing = this.auth.createPairingCode()
    const pairUrl = `http://${lanIp}:${this.effectivePort}/?code=${pairing.code}`

    await writeFile(join(this.dataDir, 'service.json'), JSON.stringify({ protocol: 1, pid: process.pid, port: this.effectivePort, dataDir: this.dataDir }), { mode: 0o600 })
    return { port: this.effectivePort, lanIp, pairUrl }
    } catch (error) { await this.releaseService(); throw error }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.dataChanged?.(); this.dataChanged = undefined
    for (const timer of this.projectionTimers.values()) clearTimeout(timer)
    this.projectionTimers.clear()
    for (const client of this.chatSockets.clients) client.close(1001, 'Service stopped')
    this.chatSubscriptions.clear()
    for (const entry of this.bundleImports.values()) { clearTimeout(entry.timer); await rm(entry.bundle.directory, { recursive: true, force: true }) }
    this.bundleImports.clear()
    await Promise.all([...this.activeRuns.values()].map(handle => (handle.shutdown ? handle.shutdown() : handle.cancel('SERVER_STOPPED')).catch(() => undefined)))
    // A sendMessage call can still be starting and not yet appear in activeRuns.
    // The pump joins that launch and shuts it down without dispatching its queue.
    await this.assistantPump?.catch(() => undefined)
    await Promise.allSettled([...this.runConsumers])
    await Promise.allSettled([...this.runSnapshots].map(([runId, snapshot]) => this.host.conversationData.call('saveState', `run:${runId}`, snapshot)))
    this.assistantInbox.close()
    await this.workspaces.close()
    if (this.jarvisSyncTimer) clearInterval(this.jarvisSyncTimer)
    this.jarvisSyncTimer = undefined
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
    this.runConversations.clear()
    this.previewTickets.clear()
    for (const terminal of this.terminals.values()) {
      for (const client of terminal.clients) client.close(1001, 'Pulse server stopped')
      try { terminal.process.kill() } catch { /* process already exited */ }
    }
    this.terminals.clear()
    for (const client of this.automationSockets.clients) client.close(1001, 'Pulse server stopped')
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
      this.server = undefined
    }
    await this.releaseService()
  }

  private attachRun(handle: RunHandle, consume = true): void {
    const runId = handle.id
    const conversationId = handle.conversationId
    this.activeRuns.set(runId, handle)
    this.runConversations.set(runId, conversationId)
    if (!this.runEventBuffers.has(runId)) this.runEventBuffers.set(runId, [])
    if (!this.runSseClients.has(runId)) this.runSseClients.set(runId, new Set())
    this.inhibitor.acquire()
    if (consume) void this.consumeRun(runId, handle)
  }

  private readonly workStarts = new Map<string, { digest: string; promise: Promise<RunHandle> }>()
  private async startConversationRun(conversationId: string, text: string, options?: { requestId?: string; attachments?: WebAttachment[]; skills?: string[]; mentionedFiles?: string[] }): Promise<RunHandle> {
    const key = options?.requestId ? `${conversationId}:${options.requestId}` : undefined
    const digest = createHash('sha256').update(JSON.stringify({ text, options })).digest('hex')
    const prior = key ? this.workStarts.get(key) : undefined
    if (prior) { if (prior.digest !== digest) throw new Error('REQUEST_ID_REUSED'); return prior.promise }
    const promise = (async () => {
      await this.prepareWorkConversation(conversationId)
      await this.host.prepareAutomation()
      const handle = this.workWorker
        ? await startH5WorkWorker({ ...this.workWorker, runtimeOptions: this.host.getWorkWorkerOptions() }, { conversationId, text, ...options })
        : await this.host.sendMessage(conversationId, { text, ...options })
      this.attachRun(handle)
      return handle
    })()
    if (key) this.workStarts.set(key, { digest, promise })
    try { return await promise } finally { if (key) this.workStarts.delete(key) }
  }

  private async prepareWorkConversation(conversationId: string): Promise<void> {
    const conversation = await this.host.getConversation(conversationId)
    const projectId = conversation.summary.projectId
    if (!projectId) return
    const project = await this.projects.get(projectId)
    if (!project || !project.available) throw new Error('PROJECT_NOT_AVAILABLE')
    const prepared = await this.workspaces.prepare(conversationId, project.id, project.cwd)
    await this.host.setConversationExecutionWorkspace(conversationId, prepared.cwd, project.cwd)
    if (conversation.summary.origin === 'assistant') await this.assistantInbox.linkWork(conversationId, project.id, conversation.summary.title)
  }

  private async pumpAssistantInbox(): Promise<void> {
    if (this.stopping) return
    if (this.assistantPump) return this.assistantPump
    this.assistantPump = (async () => {
      const conversationId = this.assistantInbox.conversationId
      while (!this.stopping) {
        const message = await this.assistantInbox.next()
        if (!message) return
        if (this.stopping) { await this.assistantInbox.update(message.runId, 'interrupted', 'Server stopped before launch'); return }
        this.assistantPendingRuns.add(message.runId)
        this.runConversations.set(message.runId, conversationId)
        this.runEventBuffers.set(message.runId, [])
        this.runSseClients.set(message.runId, new Set())
        try {
          await this.host.appendAssistantUserMessage(conversationId, {
            id: `msg-${message.messageId}`,
            runId: message.runId,
            text: message.text,
            createdAt: message.createdAt,
            ...(message.attachments ? { attachments: message.attachments } : {}),
            ...(message.skills ? { skills: message.skills } : {}),
            ...(message.mentionedFiles ? { mentionedFiles: message.mentionedFiles } : {}),
          })
          if (this.stopping) { await this.assistantInbox.update(message.runId, 'interrupted', 'Server stopped before launch'); return }
          const handle = await this.host.sendMessage(conversationId, {
            text: message.text,
            assistantChat: true,
            runId: message.runId,
            requestId: message.messageId,
            userMessageRecorded: true,
            ...(message.attachments ? { attachments: message.attachments } : {}),
            ...(message.skills ? { skills: message.skills } : {}),
            ...(message.mentionedFiles ? { mentionedFiles: message.mentionedFiles } : {}),
          })
          this.attachRun(handle, false)
          if (this.stopping) await (handle.shutdown ? handle.shutdown() : handle.cancel('SERVER_STOPPED'))
          await this.consumeRun(message.runId, handle)
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'ASSISTANT_REPLY_FAILED'
          await this.assistantInbox.update(message.runId, 'failed', detail)
          this.pushEvent(message.runId, { type: 'error', runId: message.runId, seq: 1, conversationId, data: { message: detail.slice(0, 240) } })
          this.pushEvent(message.runId, { type: 'complete', runId: message.runId, seq: 2, conversationId, data: { status: 'failed', errorCode: 'ASSISTANT_REPLY_FAILED' } })
          this.assistantPendingRuns.delete(message.runId)
          this.finishStream(message.runId)
        } finally {
          this.assistantPendingRuns.delete(message.runId)
        }
      }
    })().finally(() => {
      this.assistantPump = undefined
      // A message can be enqueued after next() observed an empty inbox but
      // before this promise's finally callback. Recheck after releasing pump.
      if (!this.stopping && this.assistantInbox.hasQueued()) queueMicrotask(() => { void this.pumpAssistantInbox() })
    })
    return this.assistantPump
  }

  private async startWorkFromAssistant(projectId: string, task: string): Promise<{ conversationId: string; projectId: string; title: string }> {
    const project = await this.projects.get(projectId)
    if (!project || !project.available) throw new Error('PROJECT_NOT_AVAILABLE')
    const title = task.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Pulse 工作会话'
    const conversation = await this.host.createConversation({ title, cwd: project.cwd, projectId: project.id, origin: 'assistant' })
    await this.assistantInbox.linkWork(conversation.id, project.id, title)
    queueMicrotask(() => { void this.startConversationRun(conversation.id, task).catch(async error => {
      const detail = error instanceof Error ? error.message : 'WORK_START_FAILED'
      process.stderr.write(`[pulse] work start failed: ${detail.slice(0, 180)}\n`)
      await this.assistantInbox.addWorkNotice({ id: `work-start-${conversation.id}`, role: 'assistant', createdAt: new Date().toISOString(), text: `无法启动工作会话：${detail.slice(0, 160)}`, work: { conversationId: conversation.id, projectId: project.id, title, state: 'failed' } }).catch(() => undefined)
    }) })
    return { conversationId: conversation.id, projectId: project.id, title }
  }

  private async listWorkSessions(projectId?: string): Promise<unknown> {
    const assistantId = this.assistantInbox.conversationId
    const conversations = await this.host.listConversations()
    const sessions = conversations.filter(item => item.id !== assistantId && !item.archivedAt && (!projectId || item.projectId === projectId)).slice(0, 40).map(item => ({ conversationId: item.id, title: item.title, projectId: item.projectId, active: Boolean(item.activeRunId), updatedAt: item.updatedAt }))
    if (projectId) return sessions
    const projects = (await this.projects.list()).map(item => ({ id: item.id, name: item.name, cwd: item.cwd, available: item.available }))
    return { projects, sessions }
  }

  private async workStatus(conversationId: string): Promise<unknown> {
    if (conversationId === this.assistantInbox.conversationId) throw new Error('WORK_SESSION_REQUIRED')
    const conversation = await this.host.getConversation(conversationId)
    const handle = conversation.summary.activeRunId ? this.activeRuns.get(conversation.summary.activeRunId) : undefined
    const messages = await this.host.getConversationMessages(conversationId)
    return { conversationId, title: conversation.summary.title, projectId: conversation.summary.projectId, state: handle ? 'running' : conversation.summary.activeRunId ? 'interrupted' : 'idle', pending: handle ? await handle.pendingInteractions() : [], latestMessage: messages.at(-1)?.text.slice(0, 2_000) }
  }

  private async sendToWork(conversationId: string, text: string): Promise<void> {
    if (conversationId === this.assistantInbox.conversationId) throw new Error('WORK_SESSION_REQUIRED')
    const conversation = await this.host.getConversation(conversationId)
    const active = conversation.summary.activeRunId ? this.activeRuns.get(conversation.summary.activeRunId) : undefined
    if (active) { await active.submitHumanInput(text); return }
    await this.startConversationRun(conversationId, text)
  }

  private async stopWork(conversationId: string): Promise<void> {
    const conversation = await this.host.getConversation(conversationId)
    const active = conversation.summary.activeRunId ? this.activeRuns.get(conversation.summary.activeRunId) : undefined
    if (!active) throw new Error('RUN_NOT_ACTIVE')
    await active.cancel('USER_REQUESTED')
  }

  private async resumeWork(conversationId: string): Promise<void> {
    if (conversationId === this.assistantInbox.conversationId) throw new Error('WORK_SESSION_REQUIRED')
    await this.resumeConversationRun(conversationId)
  }

  private async resumeConversationRun(conversationId: string): Promise<RunHandle> {
    const binding = await this.host.getTransferBinding(conversationId)
    if (binding) {
      const conversation = await this.host.getConversation(conversationId)
      if (binding.runId === conversation.summary.activeRunId) {
        const reasons = await this.host.preflightTransferredRecovery(conversationId, binding.targetCwd)
        if (reasons.length) throw new BundleError(reasons.join(';'), 409)
        const project = conversation.summary.projectId ? await this.projects.get(conversation.summary.projectId) : undefined
        if (!project?.available || project.cwd !== binding.targetCwd) throw new BundleError('PROJECT_NOT_AVAILABLE', 409)
        const prepared = await this.workspaces.prepare(conversationId, project.id, project.cwd)
        await this.host.bindTransferredWorkspace(conversationId, prepared.cwd)
      }
    }
    await this.host.prepareAutomation()
    const handle = this.workWorker
      ? await startH5WorkWorker({ ...this.workWorker, runtimeOptions: this.host.getWorkWorkerOptions() }, { conversationId, text: '', resume: true })
      : await this.host.resumeRun(conversationId)
    this.attachRun(handle)
    return handle
  }

  private async assistantView(before?: string): Promise<{ conversation: unknown; messages: unknown[]; receipts: WebAssistantMessageReceipt[]; workInteractions: WebAssistantWorkInteraction[]; before?: string; revision: number }> {
    await Promise.allSettled([...this.projectionWrites.values()])
    return this.host.conversationData.call('assistantView', before)
  }

  private async handlePreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number, label: string) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`)
    }
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const match = url.pathname.match(/^\/preview\/([0-9a-f-]{36})\/__ws(?:\/(.*))?$/i)
      const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
      const origin = typeof req.headers.origin === 'string' ? new URL(req.headers.origin) : undefined
      if (!match?.[1] || !host || !isAllowedH5Host(host) || !isLoopbackIp(req.socket.remoteAddress)) { reject(403, 'Forbidden'); return }
      if (!origin || origin.origin !== `http://${host}`) { reject(403, 'Forbidden'); return }
      const ticket = this.previewTickets.get(match[1])
      if (!ticket || ticket.expiresAt < Date.now()) { this.previewTickets.delete(match[1]); reject(404, 'Not Found'); return }
      const project = await this.projects.get(ticket.projectId)
      if (!project?.previewUrl || project.previewUrl !== ticket.origin) { reject(410, 'Gone'); return }
      const path = (match[2] ?? '').split('/').map(part => encodeURIComponent(decodeURIComponent(part))).join('/')
      const target = new URL(`/${path}${url.search}`, `${ticket.origin}/`)
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
      this.previewSockets.handleUpgrade(req, socket, head, client => {
        const upstream = new WebSocket(target, [], { handshakeTimeout: 5_000, maxPayload: 1024 * 1024 })
        let closed = false
        const closeBoth = (code = 1000, reason = 'Preview connection closed') => {
          if (closed) return
          closed = true
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason)
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason)
        }
        client.on('message', (data, binary) => {
          if (upstream.readyState !== WebSocket.OPEN) return
          if (upstream.bufferedAmount > 1024 * 1024) { closeBoth(1013, 'Preview output is too far behind'); return }
          upstream.send(data, { binary })
        })
        upstream.on('message', (data, binary) => {
          if (client.readyState !== WebSocket.OPEN) return
          if (client.bufferedAmount > 1024 * 1024) { closeBoth(1013, 'Preview output is too far behind'); return }
          client.send(data, { binary })
        })
        upstream.on('error', () => closeBoth(1011, 'Preview websocket unavailable'))
        client.on('error', () => closeBoth(1011, 'Preview websocket closed'))
        client.on('close', () => closeBoth())
        upstream.on('close', () => closeBoth())
      })
    } catch { reject(400, 'Bad Request') }
  }

  private sendChat(client: WebSocket, value: unknown): void {
    if (client.readyState !== WebSocket.OPEN) return
    if (client.bufferedAmount > 2 * 1024 * 1024) { client.close(1013, 'Resync required'); return }
    client.send(JSON.stringify(value))
  }

  private async handleChatUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    try {
      const host = req.headers.host, origin = req.headers.origin
      if (typeof host !== 'string' || !isAllowedH5Host(host) || typeof origin !== 'string' || new URL(origin).origin !== `http://${host}` || new URL(req.url!, `http://${host}`).pathname !== '/api/chat/socket') { reject(); return }
      const token = this.parseCookies(req).pulse_device
      if (!await this.auth.authenticateToken(token)) { reject(); return }
      this.chatSockets.handleUpgrade(req, socket, head, client => {
        const subscriptions = new Map<string, number>(); this.chatSubscriptions.set(client, subscriptions)
        let inFlight = 0
        client.on('error', () => {})
        client.on('close', () => this.chatSubscriptions.delete(client))
        client.on('message', raw => { void (async () => {
          if (!await this.auth.authenticateToken(token)) { client.close(1008, 'Authorization revoked'); return }
          const frame = JSON.parse(raw.toString()) as { id?: string; type?: string; path?: string; method?: string; body?: unknown; runId?: string; after?: number }
          if (frame.type === 'ping') { this.sendChat(client, { type: 'pong' }); return }
          if (frame.type === 'unsubscribe' && frame.runId) { subscriptions.delete(frame.runId); return }
          if (frame.type === 'subscribe' && frame.runId) {
            const id = await this.host.findConversationByRunId(frame.runId)
            if (id !== this.assistantInbox.conversationId && !this.assistantPendingRuns.has(frame.runId)) throw new Error('CHAT_RUN_REQUIRED')
            const after = Math.max(0, Number(frame.after) || 0)
            subscriptions.set(frame.runId, after)
            const events = this.runEventBuffers.get(frame.runId) as unknown as WebRunEvent[] | undefined
            if (!events?.length || after > 0 && (events[0]?.seq ?? 0) > after + 1) {
              const snapshot = await this.snapshotRun(frame.runId, (events ?? []) as unknown as AssistantEvent[], this.activeRuns.has(frame.runId) || this.assistantPendingRuns.has(frame.runId))
              this.sendChat(client, { type: 'event', event: { type: 'resync', runId: frame.runId, seq: snapshot.seq, data: snapshot } }); subscriptions.set(frame.runId, snapshot.seq)
              return
            }
            for (const event of events ?? []) if ((event.seq ?? 0) > after) { this.sendChat(client, { type: 'event', event }); subscriptions.set(frame.runId, event.seq ?? 0) }
            if (!this.activeRuns.has(frame.runId) && !this.assistantPendingRuns.has(frame.runId)) this.sendChat(client, { type: 'event', event: { type: 'run_finished', runId: frame.runId, seq: Math.max(after, events?.at(-1)?.seq ?? 0) + 1 } })
            return
          }
          if (frame.type !== 'request' || typeof frame.id !== 'string' || frame.id.length > 128 || typeof frame.path !== 'string' || inFlight >= 32) throw new Error('CHAT_REQUEST_INVALID')
          const path = new URL(frame.path, 'http://pulse.local')
          const allowed = path.pathname === '/api/assistant' || path.pathname === '/api/assistant/messages' || /^\/api\/assistant\/runs\/[^/]+\/cancel$/.test(path.pathname) || /^\/api\/data\/conversations\/[^/]+\/(messages|body|search)$/.test(path.pathname) || path.pathname === '/api/conversations'
          if (!allowed || !['GET','POST'].includes(frame.method ?? 'GET')) throw new Error('CHAT_METHOD_INVALID')
          inFlight++
          try {
            const result = await this.dispatchChatRequest(req, path.pathname + path.search, frame.method ?? 'GET', frame.body)
            this.sendChat(client, { type: 'response', id: frame.id, ...result })
          } catch (error) { this.sendChat(client, { type: 'response', id: frame.id, status: error instanceof Error && ['CONVERSATION_BUSY', 'REQUEST_ID_REUSED'].includes(error.message) ? 409 : 400, body: { error: error instanceof Error ? error.message : 'CHAT_FAILED' } }) }
          finally { inFlight-- }
        })().catch(() => client.close(1003, 'Invalid chat request')) })
        void this.host.conversationData.call<number>('revision').then(revision => this.sendChat(client, { type: 'changed', revision }))
      })
    } catch { reject() }
  }

  /** Reuse the same authenticated route handlers without making a loopback HTTP request. */
  private dispatchChatRequest(source: IncomingMessage, path: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolveRequest, rejectRequest) => {
      const req = new IncomingMessage(source.socket)
      req.complete = true
      req.url = path; req.method = method; req.headers = { ...source.headers, 'content-type': 'application/json' }
      if (body !== undefined) req.push(JSON.stringify(body)); req.push(null)
      const res = new ServerResponse(req)
      res.end = ((chunk?: string | Buffer) => { let value: unknown = null; try { value = JSON.parse(String(chunk ?? 'null')) } catch { value = String(chunk ?? '') }; resolveRequest({ status: res.statusCode, body: value }); return res }) as typeof res.end
      void this.handleRequest(req, res).catch(rejectRequest)
    })
  }

  private async handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number, label: string) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`)
    }
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const match = url.pathname.match(/^\/api\/terminals\/([0-9a-f-]{36})\/socket$/i)
      const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
      const origin = typeof req.headers.origin === 'string' ? new URL(req.headers.origin) : undefined
      if (!match?.[1] || !host || !isAllowedH5Host(host) || !isLoopbackIp(req.socket.remoteAddress)) { reject(403, 'Forbidden'); return }
      if (!origin || origin.origin !== `http://${host}`) { reject(403, 'Forbidden'); return }
      const device = await this.auth.authenticateToken(this.parseCookies(req).pulse_device)
      if (!device || device.scope !== 'local') { reject(401, 'Unauthorized'); return }
      const terminal = this.terminals.get(match[1])
      if (!terminal || terminal.deviceId !== device.id) { reject(404, 'Not Found'); return }
      this.terminalSockets.handleUpgrade(req, socket, head, client => {
        terminal.clients.add(client)
        client.send(JSON.stringify({ type: 'snapshot', data: terminal.output, ...(terminal.exited ? { exit: terminal.exited } : {}) }))
        client.on('message', message => {
          if (Buffer.byteLength(message.toString()) > 16 * 1024 || terminal.exited) return
          let value: unknown
          try { value = JSON.parse(message.toString()) } catch { client.close(1003, 'Invalid message'); return }
          if (!value || typeof value !== 'object' || Array.isArray(value)) { client.close(1003, 'Invalid message'); return }
          const data = value as Record<string, unknown>
          if (data.type === 'input' && typeof data.data === 'string' && data.data.length <= 12 * 1024) terminal.process.write(data.data)
          else if (data.type === 'resize' && Number.isInteger(data.cols) && Number.isInteger(data.rows) && Number(data.cols) >= 2 && Number(data.cols) <= 300 && Number(data.rows) >= 2 && Number(data.rows) <= 200) {
            try { terminal.process.resize(Number(data.cols), Number(data.rows)) } catch { /* exited between resize and socket event */ }
          } else if (data.type !== 'ping') client.close(1003, 'Unsupported message')
        })
        client.on('close', () => terminal.clients.delete(client))
        client.on('error', () => terminal.clients.delete(client))
      })
    } catch { reject(400, 'Bad Request') }
  }

  private async handleAutomationUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    try {
      const host = req.headers.host, origin = req.headers.origin
      if (typeof host !== 'string' || !isAllowedH5Host(host) || typeof origin !== 'string' || new URL(origin).origin !== `http://${host}` || req.url !== '/api/automation/socket') { reject(); return }
      const token = this.parseCookies(req).pulse_device
      const allowed = async () => { const device = await this.auth.authenticateToken(token); return device && ((device.scope === 'local' && isLoopbackIp(req.socket.remoteAddress)) || device.automationControl === true) ? device : undefined }
      if (!await allowed()) { reject(); return }
      this.automationSockets.handleUpgrade(req, socket, head, client => {
        let sequence = 0, previous = '', pending = false
        const emit = async () => {
          if (pending || client.readyState !== WebSocket.OPEN) return
          pending = true
          try {
            if (!await allowed()) { client.close(1008, 'Permission revoked'); return }
            const data = this.host.automation.list(), serialized = JSON.stringify(data)
            if (serialized !== previous) { previous = serialized; client.send(JSON.stringify({ type: 'automation', seq: ++sequence, sessions: data })) }
          } finally { pending = false }
        }
        void emit().catch(() => client.close(1011))
        const timer = setInterval(() => { void emit().catch(() => client.close(1011)) }, 500)
        client.on('message', message => { if (message.toString() === 'ping') client.send('pong'); else client.close(1003, 'Use authenticated HTTP input endpoint') })
        client.on('close', () => clearInterval(timer))
        client.on('error', () => clearInterval(timer))
      })
    } catch { reject() }
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

  private async parseJsonBody(req: IncomingMessage, maxBytes = MAX_ATTACHMENT_REQUEST): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = ''
      let bytes = 0
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk)
        data += chunk
        if (bytes > maxBytes) {
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

  private async saveAttachments(conversationId: string, attachments: unknown[]): Promise<WebAttachment[]> {
    if (!Array.isArray(attachments) || attachments.length === 0) return []
    return new AttachmentStore(this.dataDir, conversationId).save(attachments)
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

    if (pathname === '/pair' && !loopback) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('配对管理页仅允许在本机打开。')
      return
    }

    // Web UI routes and fingerprinted assets are served from the standalone workspace build.
    const webPage = pathname === '/' || /^\/(chat|work|settings|archive|pair)(\/[^.]*)?$/.test(pathname)
    if (method === 'GET' && (webPage || pathname.startsWith('/assets/'))) {
      const relativePath = webPage ? 'index.html' : pathname.slice(1)
      const webRoot = this.webDistDirectory
      if (!webRoot) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Pulse Web assets are missing. Build packages/web before starting H5.'); return }
      const path = resolve(webRoot, relativePath)
      if (path !== webRoot && !path.startsWith(`${webRoot}${sep}`)) {
        res.writeHead(404).end()
        return
      }
      try {
        const [content, file] = await Promise.all([readFile(path), stat(path)])
        res.writeHead(200, { 'Content-Type': webPage ? 'text/html; charset=utf-8' : assetTypes[extname(path)] ?? 'application/octet-stream', 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'Content-Length': file.size })
        res.end(content)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Pulse Web assets are missing. Build packages/web before starting H5.')
      }
      return
    }

    const previewResource = pathname.match(/^\/preview\/([0-9a-f-]{36})(?:\/(.*))?$/i)
    if (previewResource?.[1] && method === 'GET') {
      const ticket = this.previewTickets.get(previewResource[1])
      if (!ticket || ticket.expiresAt < Date.now()) { this.previewTickets.delete(previewResource[1]); res.writeHead(404).end(); return }
      const project = await this.projects.get(ticket.projectId)
      if (!project?.previewUrl || new URL(project.previewUrl).origin !== ticket.origin) { res.writeHead(410).end(); return }
      try {
        const relativePath = previewResource[2] ?? ''
        const target = new URL(`/${relativePath.split('/').map(part => encodeURIComponent(decodeURIComponent(part))).join('/')}${url.search}`, `${ticket.origin}/`)
        if (target.origin !== ticket.origin) { res.writeHead(403).end(); return }
        const upstream = await fetch(target, { redirect: 'manual', headers: { Accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*' }, signal: AbortSignal.timeout(12_000) })
        if (upstream.status >= 300 && upstream.status < 400) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('预览服务重定向已被阻止。'); return }
        const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
        let payload = Buffer.from(await upstream.arrayBuffer())
        if (payload.byteLength > 8 * 1024 * 1024) { res.writeHead(413).end(); return }
        if (contentType.includes('text/html')) {
          let html = payload.toString('utf8')
          const prefix = `/preview/${previewResource[1]}/`
          html = html.replace(/(\b(?:src|href|action)=['"])\/(?!\/)/gi, `$1${prefix}`)
          html = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<base href="${prefix}">`) : `<base href="${prefix}">\n${html}`
          const bridge = `<script>(function(){const ticket=${JSON.stringify(previewResource[1])};const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct:function(Target,args){try{const u=new URL(args[0],location.href);if((u.protocol==='ws:'||u.protocol==='wss:')&&u.hostname===location.hostname){u.protocol=location.protocol==='https:'?'wss:':'ws:';u.host=location.host;u.pathname='/preview/'+ticket+'/__ws'+u.pathname;args[0]=u.toString()}}catch(_){}return Reflect.construct(Target,args)}})})();</script>`
          html = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${bridge}`) : `${bridge}\n${html}`
          payload = Buffer.from(html, 'utf8')
        }
        res.writeHead(upstream.status, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws://${hostHeader}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Length': payload.byteLength,
        })
        res.end(payload)
      } catch { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('预览服务暂时无法访问。') }
      return
    }

    // Local browser session bootstrap is restricted to a real loopback connection and same-origin POST.
    if (pathname === '/api/session/local' && method === 'POST') {
      if (!loopback) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'LOCAL_ONLY' })); return }
      const origin = req.headers.origin
      let sameOrigin = false
      try { sameOrigin = typeof origin === 'string' && new URL(origin).origin === `http://${hostHeader}` } catch { sameOrigin = false }
      if (!sameOrigin) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SAME_ORIGIN_REQUIRED' })); return }
      const cookies = this.parseCookies(req)
      const local = await this.auth.getOrCreateLocalDevice(cookies.pulse_device)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': `pulse_device=${local.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` })
      res.end(JSON.stringify({ ok: true, deviceId: local.device.id, scope: 'local' }))
      return
    }

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

    const localAdmin = loopback && authedDevice?.scope === 'local'
    const canBrowseHostPaths = Boolean(authedDevice)
    const canRegisterProject = Boolean(authedDevice)
    const requireSameOrigin = (): boolean => {
      let origin: string | undefined
      try { origin = typeof req.headers.origin === 'string' ? new URL(req.headers.origin).origin : undefined } catch { origin = undefined }
      return Boolean(origin && origin === `http://${hostHeader}`)
    }

    const canControlAutomation = localAdmin || authedDevice?.automationControl === true
    const automationPermission = pathname.match(/^\/api\/devices\/([^/]+)\/automation$/)
    if (automationPermission && method === 'POST') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403).end(); return }
      const body = await this.parseJsonBody(req)
      if (typeof body.enabled !== 'boolean') { res.writeHead(400).end(); return }
      const ok = await this.auth.setAutomationControl(automationPermission[1]!, body.enabled)
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok }))
      return
    }
    if (pathname === '/api/automation/vision-probe' && method === 'POST') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403).end(); return }
      const body = await this.parseJsonBody(req)
      if (typeof body.model !== 'string') { res.writeHead(400).end(); return }
      try { const result = await this.host.probeVisionModel(body.model); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result)) }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({error: error instanceof Error ? error.message : 'VISION_PROBE_FAILED'})) }
      return
    }
    if (pathname.startsWith('/api/automation/')) {
      if (!canControlAutomation) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'AUTOMATION_CONTROL_REQUIRED' })); return }
      try {
        const manager = this.host.automation
        const options = this.host.getAutomationOptions()
        if (pathname === '/api/automation/doctor' && method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await this.host.automationDoctor())); return }
        if (pathname === '/api/automation/permissions' && method === 'POST') {
          if (!localAdmin || !requireSameOrigin()) { res.writeHead(403).end(); return }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await this.host.requestAutomationPermissions())); return
        }
        const target = pathname.match(/^\/api\/automation\/sessions\/([^/]+)(?:\/(observe|frame|control|input|heartbeat|command))?$/)
        let value: unknown
        if (pathname === '/api/automation/sessions' && method === 'GET') value = { sessions: manager.list(), ...options }
        else if (pathname === '/api/automation/sessions' && method === 'POST') {
          if (!requireSameOrigin() || options.approvalMode === 'read-only') { res.writeHead(403).end(); return }
          const body = await this.parseJsonBody(req)
          if (!['browser', 'computer'].includes(String(body.kind)) || !options.enabled.includes(String(body.kind)) || (body.mode !== undefined && !['dedicated','existing'].includes(String(body.mode)))) { res.writeHead(400).end(); return }
          const project = typeof body.projectId === 'string' ? await this.projects.get(body.projectId) : undefined
          if (!project) { res.writeHead(400).end(); return }
          value = await manager.open(body.kind as 'browser' | 'computer', `device:${authedDevice!.id}`, project.cwd, body.mode as 'dedicated' | 'existing' | undefined)
        } else if (target && method === 'GET' && target[2] === 'frame') {
          const frame = await manager.frame(target[1]!)
          res.writeHead(200, { 'Content-Type': frame.mediaType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(frame.bytes); return
        } else if (target && method === 'POST') {
          if (!requireSameOrigin()) { res.writeHead(403).end(); return }
          const body = await this.parseJsonBody(req)
          if (target[2] === 'heartbeat' && typeof body.lease === 'string') { manager.heartbeat(target[1]!, authedDevice!.id, body.lease); value = { ok: true } }
          else if (target[2] === 'observe') { const { pulseImage: _image, ...view } = await manager.observe(target[1]!); value = view }
          else {
            if (options.approvalMode === 'read-only') { res.writeHead(403).end(); return }
            if (target[2] === 'command' && typeof body.lease === 'string' && typeof body.method === 'string' && body.params && typeof body.params === 'object' && !Array.isArray(body.params)) value = await manager.manualCommand(target[1]!, body.method, body.params as Record<string, unknown>, authedDevice!.id, body.lease)
            else if (target[2] === 'control' && ['pause', 'resume', 'takeover', 'close'].includes(String(body.action))) value = await manager.control(target[1]!, body.action as 'pause' | 'resume' | 'takeover' | 'close', authedDevice!.id)
            else if (target[2] === 'input' && typeof body.frameId === 'string' && typeof body.requestId === 'string' && typeof body.lease === 'string') value = await manager.act(target[1]!, body.frameId, body.action, body.requestId, undefined, body.lease)
            else { res.writeHead(400).end(); return }
          }
        } else { res.writeHead(404).end(); return }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); return
      } catch (error) { res.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'AUTOMATION_FAILED' })); return }
    }
    if (pathname === '/api/session' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, queueScope: createHash('sha256').update(resolve(this.dataDir)).digest('hex').slice(0, 32), deviceId: authedDevice?.id, localAdmin, canBrowseHostPaths, canRegisterProject, canUseTerminal: localAdmin, canEditConfig: localAdmin, canControlAutomation }))
      return
    }

    if (pathname === '/api/approval-policy' && (method === 'GET' || method === 'PUT')) {
      if (method === 'PUT') {
        if (!requireSameOrigin()) { res.writeHead(403).end(); return }
        const { policy } = await this.parseJsonBody(req)
        if (policy !== 'manual' && policy !== 'delegate') { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'APPROVAL_POLICY_INVALID' })); return }
        await this.setGlobalApprovalPolicy(policy)
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ policy: await this.globalApprovalPolicy() }))
      return
    }

    if (pathname === '/api/skills' && method === 'GET') {
      const skills = await this.host.listSkills()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ skills: skills.map(name => ({ id: name, name })) }))
      return
    }

    if (pathname === '/api/assistant' && method === 'GET') {
      const view = await this.assistantView(url.searchParams.get('before') ?? undefined)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(view))
      return
    }

    if (pathname === '/api/assistant/messages' && method === 'POST') {
      if (!requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SAME_ORIGIN_REQUIRED' })); return }
      const body = await this.parseJsonBody(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      const requestId = typeof body.requestId === 'string' ? body.requestId : ''
      const attachments = await this.saveAttachments(this.assistantInbox.conversationId, Array.isArray(body.attachments) ? body.attachments : [])
      const skills = Array.isArray(body.skills) ? body.skills.filter((s): s is string => typeof s === 'string') : undefined
      const mentionedFiles = Array.isArray(body.mentionedFiles) ? body.mentionedFiles.filter((f): f is string => typeof f === 'string') : undefined
      if ((!text && attachments.length === 0) || text.length > 20_000 || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (!text && attachments.length === 0) ? 'MESSAGE_REQUIRED' : 'ASSISTANT_REQUEST_INVALID' })); return
      }
      if (body.delivery === 'immediate' || body.delivery === 'whenIdle') {
        const conversationId = this.assistantInbox.conversationId
        const previous = (await this.host.getConversationMessages(conversationId)).find(message => message.id === `msg-${requestId}`)
        if (previous?.runId) {
          if (previous.text !== text || JSON.stringify(previous.attachments ?? []) !== JSON.stringify(attachments) || JSON.stringify(previous.skills ?? []) !== JSON.stringify(skills ?? []) || JSON.stringify(previous.mentionedFiles ?? []) !== JSON.stringify(mentionedFiles ?? [])) throw new Error('REQUEST_ID_REUSED')
          const receipt = this.assistantInbox.list().find(item => item.messageId === requestId)
          if (!(body.retry === true && receipt && ['failed', 'interrupted'].includes(receipt.state))) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ conversationId, messageId: requestId, runId: receipt?.runId ?? previous.runId, state: receipt?.state ?? (this.activeRuns.has(previous.runId) ? 'replying' : 'completed'), duplicate: true })); return }
        }
        const conversation = await this.host.getConversation(conversationId)
        const active = conversation.summary.activeRunId ? this.activeRuns.get(conversation.summary.activeRunId) : undefined
        if (active && body.delivery === 'immediate') {
          await active.submitHumanInput(text, undefined, { requestId, ...(attachments.length ? { attachments } : {}), ...(skills ? { skills } : {}), ...(mentionedFiles ? { mentionedFiles } : {}) })
          await this.assistantInbox.acceptInput({ requestId, text, ...(attachments.length ? { attachments } : {}), ...(skills ? { skills } : {}), ...(mentionedFiles ? { mentionedFiles } : {}) }, active.id)
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ conversationId, messageId: requestId, runId: active.id, state: this.assistantInbox.list().find(item => item.messageId === requestId)?.state ?? 'replying' })); return
        }
        const existing = this.assistantInbox.list().find(item => item.messageId === requestId)
        if (!active && [...this.activeRuns.values()].some(handle => handle.conversationId === conversationId)) throw new Error('CONVERSATION_BUSY')
        if (!existing && (conversation.summary.activeRunId || this.assistantPendingRuns.size || this.assistantInbox.hasQueued())) throw new Error('CONVERSATION_BUSY')
      }
      const accepted = body.retry === true
        ? await this.assistantInbox.retry(requestId, text, attachments.length ? attachments : undefined, skills, mentionedFiles)
        : await this.assistantInbox.enqueue({
            requestId,
            text,
            ...(attachments.length ? { attachments } : {}),
            ...(skills ? { skills } : {}),
            ...(mentionedFiles ? { mentionedFiles } : {}),
          })
      if (accepted.message.state === 'queued') {
        this.assistantPendingRuns.add(accepted.message.runId)
        this.runConversations.set(accepted.message.runId, this.assistantInbox.conversationId)
        this.runEventBuffers.set(accepted.message.runId, [])
        this.runSseClients.set(accepted.message.runId, new Set())
      }
      res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ conversationId: this.assistantInbox.conversationId, messageId: accepted.message.messageId, runId: accepted.message.runId, state: accepted.message.state, duplicate: accepted.duplicate }))
      if (accepted.message.state === 'queued') queueMicrotask(() => { void this.pumpAssistantInbox() })
      return
    }

    const assistantCancelMatch = pathname.match(/^\/api\/assistant\/runs\/([^/]+)\/cancel$/)
    if (assistantCancelMatch && method === 'POST') {
      const runId = assistantCancelMatch[1]
      const conversationId = runId ? this.runConversations.get(runId) : undefined
      const handle = runId ? this.activeRuns.get(runId) : undefined
      if (!handle || conversationId !== this.assistantInbox.conversationId) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'ASSISTANT_REPLY_NOT_ACTIVE' })); return }
      await handle.cancel('USER_REQUESTED')
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }

    if (pathname === '/api/terminals' && (method === 'GET' || method === 'POST')) {
      if (!localAdmin || method === 'POST' && !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: localAdmin ? 'SAME_ORIGIN_REQUIRED' : 'LOCAL_ADMIN_REQUIRED' })); return }
      if (method === 'GET') {
        const projectId = url.searchParams.get('projectId')
        const items = [...this.terminals.values()].filter(item => item.deviceId === authedDevice?.id && (!projectId || item.projectId === projectId)).map(item => ({ id: item.id, projectId: item.projectId, ...(item.exited ? { exited: item.exited } : {}) }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(items))
        return
      }
      const body = await this.parseJsonBody(req)
      const projectId = typeof body.projectId === 'string' ? body.projectId : ''
      if (!projectId || !authedDevice) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'TERMINAL_REQUEST_INVALID' })); return }
      const owned = [...this.terminals.values()].filter(item => item.deviceId === authedDevice.id).length
      if (this.terminals.size >= 4 || owned >= 3) { res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'TERMINAL_LIMIT_REACHED' })); return }
      const project = await this.projects.get(projectId)
      if (!project?.available) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_UNAVAILABLE' })); return }
      const id = randomUUID()
      const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
      try {
        // A missing native terminal must not prevent the CLI or H5 server from starting.
        const pty = await import('node-pty')
        await ensurePtyHelperExecutable()
        const child = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
          name: 'xterm-256color', cwd: project.cwd, cols: 100, rows: 28,
          env: { ...safeShellEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        })
        const terminal: TerminalSession = { id, projectId, deviceId: authedDevice.id, process: child, clients: new Set(), output: '' }
        this.terminals.set(id, terminal)
        child.onData(data => {
          terminal.output = `${terminal.output}${data}`.slice(-512 * 1024)
          for (const client of terminal.clients) {
            if (client.readyState !== WebSocket.OPEN) continue
            if (client.bufferedAmount > 1024 * 1024) { client.close(1013, 'Terminal output is too far behind'); continue }
            client.send(JSON.stringify({ type: 'output', data }))
          }
        })
        child.onExit(({ exitCode, signal }) => {
          terminal.exited = { code: exitCode, ...(signal ? { signal } : {}) }
          terminal.closedAt = Date.now()
          for (const client of terminal.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'exit', ...terminal.exited }))
          setTimeout(() => { if (terminal.closedAt && Date.now() - terminal.closedAt >= 5 * 60_000) this.terminals.delete(id) }, 5 * 60_000).unref()
        })
      } catch {
        res.writeHead(501, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'TERMINAL_UNAVAILABLE' })); return
      }
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ id, projectId, createdAt: new Date().toISOString() }))
      return
    }

    const terminalMatch = pathname.match(/^\/api\/terminals\/([0-9a-f-]{36})$/i)
    if (terminalMatch?.[1] && method === 'DELETE') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'LOCAL_ADMIN_REQUIRED' })); return }
      const terminal = this.terminals.get(terminalMatch[1])
      if (!terminal || terminal.deviceId !== authedDevice?.id) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'TERMINAL_NOT_FOUND' })); return }
      this.terminals.delete(terminal.id)
      for (const client of terminal.clients) client.close(1000, 'Terminal closed by user')
      try { terminal.process.kill() } catch { /* process already exited */ }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
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

    if (pathname === '/api/config' && method === 'GET') {
      if (!localAdmin) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'LOCAL_ADMIN_REQUIRED' })); return }
      if (!this.configuration) { res.writeHead(501, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONFIGURATION_UNAVAILABLE' })); return }
      const raw = await this.configText()
      const parsed = normalizeModelConfig(this.parseConfig(raw))
      const envNames = new Set<string>()
      for (const profile of Object.values(parsed.providers && typeof parsed.providers === 'object' ? parsed.providers as Record<string, unknown> : {})) {
        if (profile && typeof profile === 'object' && typeof (profile as Record<string, unknown>).apiKeyEnv === 'string') envNames.add((profile as Record<string, unknown>).apiKeyEnv as string)
      }
      const modelId = typeof parsed.assistantModel === 'string' ? parsed.assistantModel : typeof parsed.activeModel === 'string' ? parsed.activeModel : undefined
      const selection = typeof modelId === 'string' ? parseModelSelectionId(modelId) : undefined
      const providerId = selection?.providerId
      const models = providerId && parsed.providers && typeof parsed.providers === 'object' ? (parsed.providers as Record<string, Record<string, unknown>>)[providerId]?.models : undefined
      const model = selection && models && typeof models === 'object' ? (models as Record<string, unknown>)[selection.modelId] : undefined
      const modelRecord = model && typeof model === 'object' && !Array.isArray(model) ? model as Record<string, unknown> : undefined
      const profile = providerId && parsed.providers && typeof parsed.providers === 'object' ? (parsed.providers as Record<string, unknown>)[providerId] : undefined
      const profileRecord = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile as Record<string, unknown> : undefined
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ path: this.configuration.path, version: configVersion(raw), config: maskConfigSecrets(parsed), sources: this.configSources(), environment: Object.fromEntries([...envNames].map(name => [name, Boolean(process.env[name])])), active: { model: this.host.getModel(), provider: this.host.getProvider(), assistant: { id: modelId, model: typeof modelRecord?.modelCode === 'string' ? modelRecord.modelCode : this.host.getModel(), name: typeof modelRecord?.displayName === 'string' ? modelRecord.displayName : modelId, provider: typeof profileRecord?.name === 'string' ? profileRecord.name : typeof profileRecord?.provider === 'string' ? profileRecord.provider : providerId } }, backupAvailable: await access(`${this.configuration.path}.bak`).then(() => true, () => false) }))
      return
    }

    if (pathname === '/api/config/validate' && method === 'POST') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(localAdmin ? 403 : 403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: localAdmin ? 'SAME_ORIGIN_REQUIRED' : 'LOCAL_ADMIN_REQUIRED' })); return }
      const body = await this.parseJsonBody(req)
      if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONFIG_OBJECT_REQUIRED' })); return }
      try {
        const raw = await this.configText()
        const candidate = preserveConfigSecrets(this.parseConfig(raw), body.config as Record<string, unknown>)
        const prepared = await this.validateConfigCandidate(candidate)
        const root = resolve(prepared.options.cwd ?? process.cwd())
        const dataDir = resolve(prepared.options.dataDir ?? process.env.PULSE_DATA_DIR ?? this.dataDir)
        const restartRequired = [...(root === this.host.getWorkingDirectory() ? [] : ['cwd']), ...(dataDir === this.dataDir ? [] : ['dataDir'])]
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ valid: true, restartRequired }))
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ valid: false, error: error instanceof Error ? error.message.slice(0, 240) : 'CONFIG_INVALID' }))
      }
      return
    }

    if (pathname === '/api/config' && method === 'PUT') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: localAdmin ? 'SAME_ORIGIN_REQUIRED' : 'LOCAL_ADMIN_REQUIRED' })); return }
      const body = await this.parseJsonBody(req)
      if (!this.configuration || typeof body.version !== 'string' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONFIG_SAVE_INVALID' })); return }
      try {
        const result = await this.withConfigWriteLock(async () => {
          const raw = await this.configText()
          if (configVersion(raw) !== body.version) throw new Error('CONFIG_VERSION_CONFLICT')
          const candidate = preserveConfigSecrets(this.parseConfig(raw), body.config as Record<string, unknown>)
          const prepared = await this.validateConfigCandidate(candidate)
          if (configVersion(await this.configText()) !== body.version) throw new Error('CONFIG_VERSION_CONFLICT')
          await this.replaceConfig(prepared.text)
          const applied = this.host.applyLiveOptions(prepared.options)
          return { path: this.configuration!.path, version: configVersion(prepared.text), applied: applied.applied, restartRequired: applied.restartRequired, config: maskConfigSecrets(JSON.parse(prepared.text) as Record<string, unknown>) }
        })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, ...result }))
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 240) : 'CONFIG_INVALID'
        res.writeHead(message === 'CONFIG_VERSION_CONFLICT' ? 409 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
      }
      return
    }

    if (pathname === '/api/config/restore' && method === 'POST') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: localAdmin ? 'SAME_ORIGIN_REQUIRED' : 'LOCAL_ADMIN_REQUIRED' })); return }
      const body = await this.parseJsonBody(req)
      if (!this.configuration || typeof body.version !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONFIG_RESTORE_INVALID' })); return }
      try {
        const result = await this.withConfigWriteLock(async () => {
          const raw = await this.configText()
          if (configVersion(raw) !== body.version) throw new Error('CONFIG_VERSION_CONFLICT')
          const candidate = this.parseConfig(await readFile(`${this.configuration!.path}.bak`, 'utf8'))
          const prepared = await this.validateConfigCandidate(candidate)
          if (configVersion(await this.configText()) !== body.version) throw new Error('CONFIG_VERSION_CONFLICT')
          await this.replaceConfig(prepared.text)
          const applied = this.host.applyLiveOptions(prepared.options)
          return { path: this.configuration!.path, version: configVersion(prepared.text), applied: applied.applied, restartRequired: applied.restartRequired, config: maskConfigSecrets(JSON.parse(prepared.text) as Record<string, unknown>) }
        })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, ...result }))
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 240) : 'CONFIG_RESTORE_FAILED'
        res.writeHead(message === 'CONFIG_VERSION_CONFLICT' ? 409 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
      }
      return
    }

    if (pathname.startsWith('/api/host-filesystem/')) {
      if (!canBrowseHostPaths || method === 'POST' && !requireSameOrigin()) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: canBrowseHostPaths ? 'SAME_ORIGIN_REQUIRED' : 'UNAUTHORIZED' })); return
      }
      try {
        let result: unknown
        let status = 200
        if (pathname === '/api/host-filesystem/roots' && method === 'GET') result = await hostPathRoots()
        else if (pathname === '/api/host-filesystem/entries' && method === 'GET') {
          result = await listHostPaths(url.searchParams.get('path'), (url.searchParams.get('mode') ?? 'both') as HostPathMode, url.searchParams.get('hidden') === '1', Number(url.searchParams.get('offset') ?? '0'))
        } else if (pathname === '/api/host-filesystem/directories' && method === 'POST') {
          const body = await this.parseJsonBody(req)
          result = await createHostDirectory(body.parentPath, body.name); status = 201
        } else { res.writeHead(404).end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result))
      } catch (error) {
        const failure = hostFilesystemError(error)
        res.writeHead(failure.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: failure.code }))
      }
      return
    }

    if (pathname === '/api/projects' && method === 'GET') {
      const projects = await this.projects.list()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(projects))
      return
    }
    if (pathname === '/api/projects' && method === 'POST') {
      if (!canRegisterProject || !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: canRegisterProject ? 'SAME_ORIGIN_REQUIRED' : 'UNAUTHORIZED' })); return }
      const body = await this.parseJsonBody(req)
      if (typeof body.name !== 'string' || typeof body.cwd !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_INPUT_REQUIRED' })); return }
      try { const project = await this.projects.add(body.name, body.cwd); res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(project)) }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'PROJECT_CREATE_FAILED' })) }
      return
    }
    if (pathname === '/api/projects/select-directory' && method === 'POST') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: localAdmin ? 'SAME_ORIGIN_REQUIRED' : 'LOCAL_ADMIN_REQUIRED' })); return }
      if (process.platform !== 'darwin') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ selected: false, manualEntry: true })); return }
      try {
        const result = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择 Pulse 项目目录")'], { timeout: 60_000, maxBuffer: 32 * 1024 })
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ selected: true, cwd: result.stdout.trim() }))
      } catch { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ selected: false, cancelled: true })) }
      return
    }
    if (pathname === '/api/projects/order' && method === 'POST') {
      if (!localAdmin || !requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: localAdmin ? 'SAME_ORIGIN_REQUIRED' : 'LOCAL_ADMIN_REQUIRED' })); return }
      const body = await this.parseJsonBody(req)
      if (!Array.isArray(body.ids) || body.ids.some(id => typeof id !== 'string')) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_ORDER_INVALID' })); return }
      try { await this.projects.reorder(body.ids as string[]); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true })) }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'PROJECT_ORDER_INVALID' })) }
      return
    }
    const previewTicketMatch = pathname.match(/^\/api\/projects\/([^/]+)\/preview-ticket$/)
    if (previewTicketMatch?.[1] && method === 'POST') {
      if (!requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SAME_ORIGIN_REQUIRED' })); return }
      const project = await this.projects.get(decodeURIComponent(previewTicketMatch[1]))
      if (!project?.previewUrl) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PREVIEW_NOT_REGISTERED' })); return }
      const id = randomUUID()
      const expiresAt = Date.now() + 10 * 60_000
      this.previewTickets.set(id, { projectId: project.id, origin: project.previewUrl, expiresAt })
      for (const [key, ticket] of this.previewTickets) if (ticket.expiresAt < Date.now()) this.previewTickets.delete(key)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ url: `/preview/${id}/`, expiresAt }))
      return
    }
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (projectMatch?.[1] && method === 'PATCH') {
      if (!requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SAME_ORIGIN_REQUIRED' })); return }
      const body = await this.parseJsonBody(req)
      if (body.previewUrl !== undefined && !localAdmin) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'LOCAL_ADMIN_REQUIRED' })); return }
      try { const project = await this.projects.update(decodeURIComponent(projectMatch[1]), { ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}), ...(typeof body.previewUrl === 'string' || body.previewUrl === null ? { previewUrl: body.previewUrl as string | null } : {}) }); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(project)) }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'PROJECT_UPDATE_FAILED' })) }
      return
    }
    if (projectMatch?.[1] && method === 'DELETE') {
      if (!requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SAME_ORIGIN_REQUIRED' })); return }
      const id = decodeURIComponent(projectMatch[1])
      const conversations = await this.host.listConversations()
      const members: ConversationSummary[] = []
      for (const conversation of conversations) {
        const project = conversation.projectId ? undefined : await this.projects.findByCwd(conversation.cwd)
        if (conversation.projectId === id || project?.id === id) members.push(conversation)
      }
      if (members.some(item => item.activeRunId)) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_HAS_ACTIVE_CONVERSATIONS' })); return }
      try {
        for (const conversation of members) await this.host.updateConversationOrganization(conversation.id, { projectId: undefined, archivedAt: new Date().toISOString() })
        await this.projects.remove(id)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, archived: members.length }))
      } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'PROJECT_REMOVE_FAILED' })) }
      return
    }

    const projectViewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(files|file|search|git\/status|git\/diff|file-index)$/)
    if (projectViewMatch?.[1] && projectViewMatch[2] && method === 'GET') {
      const project = await this.projects.get(decodeURIComponent(projectViewMatch[1]))
      if (!project) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_NOT_FOUND' })); return }
      if (!project.available) { res.writeHead(410, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_DIRECTORY_UNAVAILABLE' })); return }
      const view = projectViewMatch[2]
      try {
        if (view === 'file-index') {
          const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
          let paths: string[] = []
          try {
            const gitRes = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: project.cwd, timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })
            paths = gitRes.stdout.split(/\r?\n/).filter(Boolean)
          } catch {
            const walk = async (dir: string, base: string): Promise<string[]> => {
              const res: string[] = []
              const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
              for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
                const full = join(dir, entry.name)
                const rel = base ? `${base}/${entry.name}` : entry.name
                if (entry.isDirectory()) {
                  res.push(...(await walk(full, rel)))
                } else if (entry.isFile()) {
                  res.push(rel)
                }
              }
              return res
            }
            paths = await walk(project.cwd, '')
          }
          if (query) {
            paths = paths.filter(p => p.toLowerCase().includes(query))
          }
          paths.sort((a, b) => {
            const aBase = a.split('/').pop()?.toLowerCase() ?? ''
            const bBase = b.split('/').pop()?.toLowerCase() ?? ''
            const aStarts = aBase.startsWith(query)
            const bStarts = bBase.startsWith(query)
            if (aStarts && !bStarts) return -1
            if (!aStarts && bStarts) return 1
            return a.length - b.length || a.localeCompare(b)
          })
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ paths: paths.slice(0, 100) }))
          return
        }
        if (view === 'files') {
          const relativePath = url.searchParams.get('path') || '.'
          const directory = await within(project.cwd, relativePath)
          const directoryInfo = await lstat(directory)
          if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'DIRECTORY_REQUIRED' })); return }
          const entries = await readdir(directory, { withFileTypes: true })
          const files = await Promise.all(entries.filter(item => !item.name.startsWith('.') && item.name !== 'node_modules').flatMap(item => {
            if (item.isSymbolicLink()) return []
            const entryPath = join(directory, item.name)
            return [stat(entryPath).then(info => ({ name: item.name, path: relative(project.cwd, entryPath).split(sep).join('/'), type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other', size: info.size, modifiedAt: info.mtime.toISOString() })).catch(() => undefined)]
          }))
          const clean = files.filter((item): item is NonNullable<typeof item> => item !== undefined).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ path: relative(project.cwd, directory).split(sep).join('/') || '.', entries: clean }))
          return
        }
        if (view === 'file') {
          const relativePath = url.searchParams.get('path') || ''
          const filePath = await within(project.cwd, relativePath)
          const info = await lstat(filePath)
          if (info.isSymbolicLink() || !info.isFile()) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'FILE_REQUIRED' })); return }
          if (info.size > 5 * 1024 * 1024) { res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'FILE_TOO_LARGE', size: info.size })); return }
          const buffer = await readFile(filePath)
          if (buffer.includes(0)) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: relative(project.cwd, filePath).split(sep).join('/'), binary: true, size: info.size })) ; return }
          const lines = buffer.toString('utf8').split(/\r?\n/)
          const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
          const limit = Math.min(2_000, Math.max(1, Number(url.searchParams.get('limit') ?? 1_000) || 1_000))
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ path: relative(project.cwd, filePath).split(sep).join('/'), binary: false, size: info.size, offset, totalLines: lines.length, content: lines.slice(offset, offset + limit).join('\n') }))
          return
        }
        if (view === 'search') {
          const queryText = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
          if (!queryText) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SEARCH_QUERY_REQUIRED' })); return }
          const search = await searchWorkspace(project.cwd, queryText, url.searchParams.get('path') || '.')
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(search))
          return
        }
        if (view === 'git/status') {
          const result = await execFileAsync('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], { cwd: project.cwd, timeout: 8_000, maxBuffer: 512 * 1024 })
          const [branchLine = '', ...lines] = result.stdout.split(/\r?\n/).filter(Boolean)
          const entries = lines.map(line => ({ index: line.slice(0, 1), worktree: line.slice(1, 2), path: line.slice(3) }))
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ isGit: true, branch: branchLine.replace(/^##\s*/, ''), entries }))
          return
        }
        if (view === 'git/diff') {
          const requestedPath = url.searchParams.get('path')
          const staged = url.searchParams.get('staged') === '1'
          const args = ['diff', ...(staged ? ['--cached'] : []), '--']
          if (requestedPath) {
            const safePath = await within(project.cwd, requestedPath)
            args.push(relative(project.cwd, safePath))
          }
          const result = await execFileAsync('git', args, { cwd: project.cwd, timeout: 8_000, maxBuffer: 2 * 1024 * 1024 })
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ diff: result.stdout }))
          return
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (view.startsWith('git/') && (code === '128' || (error instanceof Error && error.message.includes('not a git repository')))) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ isGit: false })); return }
        const reason = error instanceof Error ? error.message : 'WORKSPACE_READ_FAILED'
        const status = reason === 'PATH_OUTSIDE_WORKSPACE' ? 403 : code === 'ENOENT' ? 404 : 400
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: status === 403 ? 'PATH_OUTSIDE_WORKSPACE' : status === 404 ? 'FILE_NOT_FOUND' : reason.slice(0, 160) }))
        return
      }
    }

    const bundleExportMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/export$/)
    const bundleImportMatch = pathname.match(/^\/api\/conversation-imports(?:\/([a-f0-9-]+))?$/)
    if (bundleExportMatch && method === 'POST' || bundleImportMatch && ['POST', 'DELETE'].includes(method)) {
      if (!requireSameOrigin()) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'SAME_ORIGIN_REQUIRED' })); return }
      try {
        if (bundleExportMatch) {
          const id = bundleExportMatch[1]!
          if (id === this.assistantInbox.conversationId) throw new BundleError('WORK_SESSION_REQUIRED')
          const conversation = await this.host.getConversation(id)
          if (conversation.summary.activeRunId && this.activeRuns.has(conversation.summary.activeRunId)) throw new BundleError('CONVERSATION_BUSY', 409)
          const bundle = await this.host.exportConversationBundle(id)
          try {
            const bytes = (await stat(bundle.path)).size
            res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes, 'Content-Disposition': `attachment; filename="${bundle.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
            await pipeline(createReadStream(bundle.path), res)
          } finally { await bundle.cleanup() }
          return
        }
        const token = bundleImportMatch![1]
        if (!token) {
          if (method !== 'POST') throw new BundleError('NOT_FOUND', 404)
          const pendingUploads = [...this.bundleUploads.values()].reduce((sum, count) => sum + count, 0)
          if (this.bundleImports.size + pendingUploads >= 8 || [...this.bundleImports.values()].filter(entry => entry.deviceId === authedDevice!.id).length + (this.bundleUploads.get(authedDevice!.id) ?? 0) >= 2) throw new BundleError('BUNDLE_IMPORT_BUSY', 429)
          if (!/^application\/(?:zip|octet-stream)(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new BundleError('BUNDLE_ZIP_REQUIRED', 415)
          const deviceId = authedDevice!.id
          this.bundleUploads.set(deviceId, (this.bundleUploads.get(deviceId) ?? 0) + 1)
          let bundle: StagedBundle
          try { bundle = await stageConversationBundle(req, join(this.dataDir, 'conversation-imports')) }
          finally { const remaining = (this.bundleUploads.get(deviceId) ?? 1) - 1; if (remaining) this.bundleUploads.set(deviceId, remaining); else this.bundleUploads.delete(deviceId) }
          if (this.stopping) { await rm(bundle.directory, { recursive: true, force: true }); throw new BundleError('SERVER_STOPPING', 503) }
          const token = randomUUID(), expiresAt = Date.now() + 10 * 60_000
          const timer = setTimeout(() => { this.bundleImports.delete(token); void rm(bundle.directory, { recursive: true, force: true }) }, 10 * 60_000)
          timer.unref()
          this.bundleImports.set(token, { bundle, deviceId: authedDevice!.id, timer, expiresAt })
          const preview: BundlePreview = { token, conversationId: bundle.manifest.id, title: bundle.manifest.title, runCount: bundle.manifest.runs.length, attachmentCount: bundle.metadata.files.filter(file => /^conversation\/attachments\/[^/]+\.meta\.json$/.test(file.path)).length, ...(bundle.manifest.activeRunId ? { activeRunId: bundle.manifest.activeRunId } : {}), blockedReasons: await this.host.inspectConversationBundle(bundle), redactedFiles: bundle.metadata.redactedFiles.length, expiresAt: new Date(expiresAt).toISOString() }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(preview))
          return
        }
        const staged = this.bundleImports.get(token)
        if (!staged || staged.deviceId !== authedDevice!.id || staged.expiresAt <= Date.now()) throw new BundleError('BUNDLE_IMPORT_EXPIRED', 410)
        if (method === 'DELETE') {
          clearTimeout(staged.timer); this.bundleImports.delete(token)
          await rm(staged.bundle.directory, { recursive: true, force: true })
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true })); return
        }
        const body = await this.parseJsonBody(req)
        const project = typeof body.projectId === 'string' ? await this.projects.get(body.projectId) : undefined
        if (!project?.available) throw new BundleError('PROJECT_NOT_AVAILABLE', 409)
        const current = this.bundleImports.get(token)
        if (!current || current.deviceId !== authedDevice!.id || current.expiresAt <= Date.now()) throw new BundleError('BUNDLE_IMPORT_EXPIRED', 410)
        if (body.preview === true) {
          const blockedReasons = await this.host.inspectConversationBundle(current.bundle, project.cwd)
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ blockedReasons })); return
        }
        clearTimeout(current.timer); this.bundleImports.delete(token)
        try {
          const result = await this.host.importConversationBundle(current.bundle, project)
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result))
        } finally { await rm(current.bundle.directory, { recursive: true, force: true }) }
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (!res.headersSent && (error instanceof BundleError || message === 'CONVERSATION_BUSY')) {
          res.writeHead(error instanceof BundleError ? error.status : 409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
        } else throw error
      }
      return
    }

    // 7. Conversations: GET /api/conversations, POST /api/conversations
    if (pathname === '/api/conversations' && method === 'GET') {
      const all = await this.host.listConversations()
      const list = all.filter(item => item.id !== this.assistantInbox.conversationId && Boolean(item.archivedAt) === (url.searchParams.get('archived') === '1'))
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
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
      const project = projectId ? await this.projects.get(projectId) : undefined
      if (projectId && !project) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_NOT_FOUND' })); return }
      const created = await this.host.createConversation({ title, ...(project ? { cwd: project.cwd, projectId: project.id } : { projectId: null }) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(created.summary))
      return
    }

    const artifactsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/artifacts(?:\/(content))?$/)
    if (artifactsMatch && method === 'GET') {
      const conversationId = artifactsMatch[1]!
      try {
        const value = artifactsMatch[2]
          ? await this.host.readArtifact(conversationId, url.searchParams.get('path') ?? '', url.searchParams.get('runId') ?? '')
          : await this.host.listArtifacts(conversationId, url.searchParams.get('scope') === 'turn' ? 'turn' : undefined)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
      } catch (error) {
        const code = error instanceof Error ? error.message : 'ARTIFACT_UNAVAILABLE'
        res.writeHead(code === 'ARTIFACT_CHANGED' ? 409 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: code === 'ARTIFACT_CHANGED' ? code : 'ARTIFACT_UNAVAILABLE' }))
      }
      return
    }

    const attachmentMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)$/)
    if (attachmentMatch && method === 'GET') {
      const conversationId = attachmentMatch[1]!
      const attachmentId = attachmentMatch[2]!
      if (!isSafePathId(conversationId) || !isSafePathId(attachmentId)) { res.writeHead(400).end(); return }
      const filePath = join(this.dataDir, 'conversations', conversationId, 'attachments', attachmentId)
      const metaPath = join(this.dataDir, 'conversations', conversationId, 'attachments', `${attachmentId}.meta.json`)
      try {
        const metaStr = await readFile(metaPath, 'utf8').catch(() => '{}')
        const download = attachmentDownload(JSON.parse(metaStr) as { mediaType?: unknown; name?: unknown })
        const statResult = await stat(filePath)
        res.writeHead(200, {
          'Content-Type': download.mediaType,
          'Content-Length': statResult.size,
          'Content-Disposition': download.disposition,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        })
        createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'ATTACHMENT_NOT_FOUND' }))
      }
      return
    }

    const pageMatch = pathname.match(/^\/api\/data\/conversations\/([^/]+)\/(messages|body|search)$/)
    if (pageMatch && method === 'GET') {
      const id = decodeURIComponent(pageMatch[1]!)
      await this.host.getConversation(id)
      const result = pageMatch[2] === 'messages' ? await this.host.getMessagePage(id, url.searchParams.get('before') ?? undefined, Number(url.searchParams.get('limit') ?? 50))
        : pageMatch[2] === 'body' ? await this.host.conversationData.call('body', id, url.searchParams.get('id'))
        : await this.host.conversationData.call('search', id, url.searchParams.get('q') ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result)); return
    }

    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (conversationMatch && method === 'GET') {
      try {
        const conversation = await this.host.getConversation(decodeURIComponent(conversationMatch[1]!))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ...conversation.summary, ...(conversation.id === this.assistantInbox.conversationId ? { kind: 'assistant' } : {}) }))
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'CONVERSATION_NOT_FOUND' }))
      }
      return
    }
    if (conversationMatch && method === 'PATCH') {
      const conversationId = conversationMatch[1]
      const body = await this.parseJsonBody(req)
      if (conversationId === this.assistantInbox.conversationId && Object.keys(body).some(key => key !== 'approvalPolicy')) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'ASSISTANT_CONVERSATION_MANAGED' })); return }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : ''
      const hasTitle = typeof body.title === 'string'
      const policy = body.approvalPolicy
      const hasPinned = typeof body.pinned === 'boolean'
      const hasArchive = typeof body.archived === 'boolean'
      const hasProject = Object.hasOwn(body, 'projectId')
      if (!conversationId || hasTitle && !title || hasTitle && title.length > 80 || policy !== undefined && policy !== 'manual' && policy !== 'delegate' || body.pinned !== undefined && !hasPinned || body.archived !== undefined && !hasArchive || hasProject && body.projectId !== null && typeof body.projectId !== 'string' || !hasTitle && policy === undefined && !hasPinned && !hasArchive && !hasProject) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: policy !== undefined ? 'APPROVAL_POLICY_INVALID' : 'CONVERSATION_UPDATE_INVALID' })); return }
      const before = await this.host.getConversation(conversationId)
      const changingWorkspace = hasProject && (body.projectId ?? undefined) !== before.summary.projectId
      if ((hasArchive && body.archived === true || changingWorkspace) && before.summary.activeRunId) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONVERSATION_BUSY' })); return }
      if (hasTitle) await this.host.updateConversationTitle(conversationId, title)
      if (policy === 'manual' || policy === 'delegate') await this.host.updateConversationApprovalPolicy(conversationId, policy)
      if (hasPinned || hasArchive || hasProject) {
        const project = typeof body.projectId === 'string' ? await this.projects.get(body.projectId) : undefined
        if (typeof body.projectId === 'string' && !project) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PROJECT_NOT_FOUND' })); return }
        await this.host.updateConversationOrganization(conversationId, {
          ...(hasProject ? { projectId: project?.id, ...(project ? { cwd: project.cwd } : {}) } : {}),
          ...(hasPinned ? { pinned: body.pinned as boolean } : {}),
          ...(hasArchive ? body.archived ? { archivedAt: new Date().toISOString() } : { clearArchive: true } : {}),
        })
      }
      // Older clients still send a conversation PATCH; the preference is global.
      if (policy === 'manual' || policy === 'delegate') await this.setGlobalApprovalPolicy(policy)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await this.host.getConversation(conversationId).then(item => item.summary)))
      return
    }
    if (conversationMatch && method === 'DELETE') {
      const conversationId = conversationMatch[1]
      if (!conversationId) { res.writeHead(404).end(); return }
      if (conversationId === this.assistantInbox.conversationId) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'ASSISTANT_CONVERSATION_MANAGED' })); return }
      const conversation = await this.host.getConversation(conversationId)
      if (conversation.summary.activeRunId) {
        res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONVERSATION_BUSY' })); return
      }
      await this.host.deleteConversation(conversationId)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }

    const reconcileRunMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/reconcile$/)
    if (reconcileRunMatch && method === 'POST') {
      const [, conversationId, runId] = reconcileRunMatch
      if (!conversationId || !runId) { res.writeHead(404).end(); return }
      try {
        const result = await this.host.reconcileInactiveRun(conversationId, runId)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result))
      } catch (error) {
        if (error instanceof Error && error.message === 'CONVERSATION_BUSY') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'CONVERSATION_BUSY' }))
          return
        }
        throw error
      }
      return
    }

    const resumeRunMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/resume$/)
    if (resumeRunMatch && method === 'POST') {
      const [, conversationId, runId] = resumeRunMatch
      if (!conversationId || !runId) { res.writeHead(404).end(); return }
      const conversation = await this.host.getConversation(conversationId)
      if (conversation.summary.activeRunId !== runId || this.activeRuns.has(runId)) {
        res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'RUN_NOT_INTERRUPTED' }))
        return
      }
      try {
        const handle = await this.resumeConversationRun(conversationId)
        if (handle.id !== runId) {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'RUN_CHANGED' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ runId }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof BundleError) { res.writeHead(error.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.code })); return }
        if (message === 'CONVERSATION_BUSY' || message === 'NO_ACTIVE_RUN') {
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
          return
        }
        if (message === 'RESTORED_AGENT_NOT_FOUND') {
          res.writeHead(410, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'RUN_NOT_RESUMABLE' }))
          return
        }
        throw error
      }
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

    const webMessagesMatch = pathname.match(/^\/api\/web\/conversations\/([^/]+)\/messages$/)
    if (webMessagesMatch && method === 'GET') {
      const conversationId = webMessagesMatch[1]
      if (conversationId) {
        const messages = await this.host.getWebConversationMessages(conversationId)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(messages.filter(message => message.role !== 'system')))
        return
      }
    }

    const webTracesMatch = pathname.match(/^\/api\/web\/conversations\/([^/]+)\/traces$/)
    if (webTracesMatch && method === 'GET') {
      const conversationId = webTracesMatch[1]
      if (!conversationId || !isSafePathId(conversationId)) { res.writeHead(400).end(); return }
      try { await this.host.getConversation(conversationId) } catch { res.writeHead(404).end(); return }
      const traces = await this.loadConversationTraces(conversationId)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ traces }))
      return
    }

    // 9. Send message: POST /api/conversations/:id/messages
    if (messagesMatch && method === 'POST') {
      const convId = messagesMatch[1]
      if (convId) {
        const body = await this.parseJsonBody(req)
        const text = typeof body.text === 'string' ? body.text : ''
        const requestId = typeof body.requestId === 'string' ? body.requestId : undefined
        if (requestId !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'REQUEST_ID_INVALID' })); return }
        if (requestId) {
          const previous = (await this.host.getConversationMessages(convId)).find(message => message.id === `msg-${requestId}`)
          if (previous && (previous.text !== text || JSON.stringify((previous.attachments ?? []).map(item => item.id)) !== JSON.stringify(Array.isArray(body.attachments) ? body.attachments.map(item => item?.id) : []) || JSON.stringify(previous.skills ?? []) !== JSON.stringify(body.skills ?? []) || JSON.stringify(previous.mentionedFiles ?? []) !== JSON.stringify(body.mentionedFiles ?? []))) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'REQUEST_ID_REUSED' })); return }
          if (previous?.runId) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ runId: previous.runId })); return }
        }
        const attachments = await this.saveAttachments(convId, Array.isArray(body.attachments) ? body.attachments : [])
        const skills = Array.isArray(body.skills) ? body.skills.filter((s): s is string => typeof s === 'string') : undefined
        const mentionedFiles = Array.isArray(body.mentionedFiles) ? body.mentionedFiles.filter((f): f is string => typeof f === 'string') : undefined
        if (!text.trim() && attachments.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'MESSAGE_REQUIRED' }))
          return
        }

        if (body.delivery === 'immediate' || body.delivery === 'whenIdle') {
          const conversation = await this.host.getConversation(convId)
          const active = conversation.summary.activeRunId ? this.activeRuns.get(conversation.summary.activeRunId) : undefined
          if (active && body.delivery === 'immediate') {
            await active.submitHumanInput(text, undefined, { ...(requestId ? { requestId } : {}), ...(attachments.length ? { attachments } : {}), ...(skills ? { skills } : {}), ...(mentionedFiles ? { mentionedFiles } : {}) })
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ runId: active.id })); return
          }
          if (conversation.summary.activeRunId || [...this.activeRuns.values()].some(handle => handle.conversationId === convId)) throw new Error('CONVERSATION_BUSY')
        }
        const handle = await this.startConversationRun(convId, text, {
          ...(requestId ? { requestId } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(skills ? { skills } : {}),
          ...(mentionedFiles ? { mentionedFiles } : {}),
        })
        const runId = handle.id

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ runId }))
        return
      }
    }

    const runTraceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/trace$/)
    if (runTraceMatch && method === 'GET') {
      const runId = runTraceMatch[1]
      if (!runId) { res.writeHead(404).end(); return }
      const trace = await this.loadRunTrace(runId)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ runId, events: trace.events, seq: trace.seq }))
      return
    }

    const runStateMatch = pathname.match(/^\/api\/runs\/([^/]+)\/state$/)
    if (runStateMatch && method === 'GET') {
      const runId = runStateMatch[1]
      if (!runId) { res.writeHead(404).end(); return }
      const buffer = this.runEventBuffers.get(runId) ?? []
      const snapshot = await this.snapshotRun(runId, buffer, this.activeRuns.has(runId) || this.assistantPendingRuns.has(runId))
      const conversationId = this.runConversations.get(runId) ?? await this.host.findConversationByRunId(runId)
      snapshot.laneState ??= { runId, available: false, lanes: [] }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(snapshot))
      return
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
        const afterParam = Number(url.searchParams.get('after') ?? 0)
        const after = Number.isFinite(afterParam) && afterParam > 0 ? afterParam : 0
        let cursor = after
        if (!buffer.length || after > 0 && (buffer[0]?.seq ?? 0) > after + 1) {
          const snapshot = await this.snapshotRun(runId, buffer, this.activeRuns.has(runId) || this.assistantPendingRuns.has(runId))
          this.writeSse(res, { type: 'resync', runId, seq: snapshot.seq, data: snapshot }); cursor = snapshot.seq
        }
        const firstUnseen = buffer.findIndex((event) => event.seq > cursor)
        const client: SseClient = { res, sent: firstUnseen < 0 ? buffer.length : firstUnseen }
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
        if (!this.activeRuns.has(runId) && !this.assistantPendingRuns.has(runId)) {
          const conversationId = this.runConversations.get(runId)
          this.writeSse(res, { type: 'run_finished', runId, seq: Math.max(cursor, buffer.at(-1)?.seq ?? 0) + 1, ...(conversationId ? { conversationId } : {}) })
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

    const runBatchReplyMatch = pathname.match(/^\/api\/runs\/([^/]+)\/replies$/)
    if (runBatchReplyMatch && method === 'POST') {
      const runId = runBatchReplyMatch[1]
      const handle = runId ? this.activeRuns.get(runId) : undefined
      const body = await this.parseJsonBody(req)
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
      const groupId = typeof body.groupId === 'string' ? body.groupId : ''
      const requestId = typeof body.requestId === 'string' ? body.requestId : ''
      if (!runId || !/^run-[A-Za-z0-9-]{8,80}$/.test(runId) || !/^conv-[A-Za-z0-9-]{8,80}$/.test(conversationId) || !groupId || !/^[A-Za-z0-9_-]{8,120}$/.test(requestId) || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > 50) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'BATCH_REPLY_INVALID' })); return }
      if (handle && handle.conversationId !== conversationId) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'RUN_NOT_FOUND' })); return }
      const answers = body.answers.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const value = item as Record<string, unknown>
        if (typeof value.effectId !== 'string' || !value.value || typeof value.value !== 'object' || Array.isArray(value.value)) return []
        const normalized = h5ReplyValue(value.value as Record<string, unknown>)
        return normalized ? [{ effectId: value.effectId, value: normalized as unknown as JsonValue }] : []
      })
      if (answers.length !== body.answers.length) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'BATCH_REPLY_INVALID' })); return }
      const canonical = JSON.stringify({ groupId, answers: [...answers].sort((a, b) => a.effectId.localeCompare(b.effectId)) })
      const digest = createHash('sha256').update(canonical).digest('hex')
      const lockKey = `${runId}:${requestId}`
      const priorLock = this.batchReplyLocks.get(lockKey)
      if (priorLock) await priorLock
      let releaseLock!: () => void
      const lock = new Promise<void>((resolveLock) => { releaseLock = resolveLock })
      this.batchReplyLocks.set(lockKey, lock)
      try {
        const receiptPath = this.replyReceiptPath(conversationId, runId)
        const receipts: Record<string, { hash: string; acceptedAt: string }> = await readFile(receiptPath, 'utf8').then((value) => JSON.parse(value) as Record<string, { hash: string; acceptedAt: string }>).catch(() => ({} as Record<string, { hash: string; acceptedAt: string }>))
        const existing = receipts[requestId]
        if (existing) {
          if (existing.hash !== digest) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'REQUEST_ID_REUSED' })); return }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, duplicate: true }))
          return
        }
        if (!handle) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'RUN_NOT_ACTIVE' })); return }
        try { await handle.replyBatch(groupId, answers) }
        catch (error) {
          const code = error instanceof Error ? error.message : 'REPLY_FAILED'
          if (code.startsWith('ASK_RESPONSE_') || ['INTERACTION_GROUP_MISMATCH', 'EFFECT_NOT_OWNED', 'EFFECT_NOT_REPLYABLE'].includes(code)) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: code }))
            return
          }
          throw error
        }
        receipts[requestId] = { hash: digest, acceptedAt: new Date().toISOString() }
        await mkdir(join(this.dataDir, 'conversations', conversationId, 'runs', runId), { recursive: true })
        const temp = `${receiptPath}.${randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify(receipts, null, 2), { mode: 0o600 })
        await rename(temp, receiptPath)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, duplicate: false }))
      } finally {
        releaseLock()
        if (this.batchReplyLocks.get(lockKey) === lock) this.batchReplyLocks.delete(lockKey)
      }
      return
    }

    // 12. Cancel run: POST /api/runs/:id/cancel
    const runCancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
    if (runCancelMatch && method === 'POST') {
      const runId = runCancelMatch[1]
      const handle = runId ? this.activeRuns.get(runId) : undefined
      if (!handle) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'RUN_NOT_ACTIVE' })); return }
      await handle.cancel('USER_REQUESTED')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'NOT_FOUND' }))
  }

  private consumeRun(runId: string, handle: RunHandle): Promise<void> {
    const consuming = this.consumeRunEvents(runId, handle)
    this.runConsumers.add(consuming)
    void consuming.finally(() => this.runConsumers.delete(consuming)).catch(() => undefined)
    return consuming
  }

  private async consumeRunEvents(runId: string, handle: RunHandle): Promise<void> {
    let outcome: Awaited<ReturnType<RunHandle['outcome']>> | undefined
    try {
      for await (const event of handle.events) await this.publish(runId, event)
      outcome = await handle.outcome()
    } catch (error) {
      process.stderr.write(`[pulse] run stream failed: ${String(error).slice(0, 180)}\n`)
    } finally {
      try {
      const receipt = this.assistantInbox.receiptByRun(runId)
      if (receipt) await this.assistantInbox.update(runId, outcome?.status === 'succeeded' ? 'completed' : outcome?.status === 'cancelled' ? 'failed' : 'failed', outcome?.status === 'cancelled' ? '回复已停止' : outcome?.status === 'failed' ? '回复失败' : outcome ? undefined : '回复状态未能确认').catch(() => undefined)
      const conversationId = this.runConversations.get(runId)
      const link = conversationId ? this.assistantInbox.workLink(conversationId) : undefined
      if (conversationId && outcome) {
        let workspaceResult: Awaited<ReturnType<H5WorkspaceManager['finish']>> | undefined
        const conversation = await this.host.getConversation(conversationId).catch(() => undefined)
        if (conversation?.summary.projectId) {
          const taskOutcome = await handle.taskOutcome().catch(() => undefined)
          const accepted = outcome.status === 'succeeded' && taskOutcome?.status === 'accepted'
          workspaceResult = await this.workspaces.finish(conversationId, accepted).catch(error => ({ status: 'pending' as const }))
          if (workspaceResult.status === 'merged' || workspaceResult.status === 'noop') {
            const project = await this.projects.get(conversation.summary.projectId)
            if (project) await this.host.setConversationExecutionWorkspace(conversationId, project.cwd, project.cwd).catch(() => undefined)
          }
        }
        if (link && conversation?.summary.origin === 'assistant') {
          const messages = (await this.host.getMessagePage(conversationId, undefined, 100).catch(() => ({ items: [] }))).items
          const answer = [...messages].reverse().find(message => message.role === 'assistant')?.text ?? outcome.text ?? ''
          const state = workspaceResult?.status === 'conflict' ? 'conflict' : workspaceResult?.status === 'pending' ? 'pending' : outcome.status === 'succeeded' ? 'succeeded' : outcome.status === 'cancelled' ? 'cancelled' : 'failed'
          const artifacts = await this.host.listArtifacts(conversationId).catch(() => [])
          const locations = artifacts.filter(item => item.workspaceState === 'isolated').slice(-10).map(item => `${item.path}（实际位置：${item.absolutePath}）`).join('\n')
          const suffix = (state === 'conflict' ? '\n\n工作区结果已保留，但与项目最新修改有冲突，需要人工处理。' : state === 'pending' ? '\n\n工作结果已保留，验收未通过或状态不完整，尚未合入项目。' : '') + (locations ? `\n\n以下文件保存在本次工作目录，尚未合入项目；打开工作会话可查看或下载：\n${locations}` : '')
          await this.assistantInbox.addWorkNotice({
            id: `work-${runId}`, role: 'assistant', runId, createdAt: new Date().toISOString(),
            text: `${answer || (outcome.status === 'succeeded' ? '工作会话已完成。' : '工作会话已结束，请查看运行记录。')}${suffix}`,
            work: { conversationId, projectId: link.projectId, title: link.title, state },
          }).catch(() => undefined)
        }
      }
      } catch (error) {
        process.stderr.write(`[pulse] run finalization failed: ${error instanceof Error ? error.message.slice(0, 180) : 'unknown'}\n`)
        this.pushEvent(runId, { type: 'error', runId, seq: (this.runEventBuffers.get(runId)?.at(-1)?.seq ?? 0) + 0.5, data: { message: '工作收尾未完成，请检查运行记录。' } })
      } finally {
      this.assistantPendingRuns.delete(runId)
      this.finishStream(runId)
      this.inhibitor.release()
      }
    }
  }

  private async publish(runId: string, event: AssistantEvent): Promise<void> {
    const buffer = this.runEventBuffers.get(runId)
    if (!buffer) return
    let projected = publicH5Event(event)
    const fact = event.type === 'fact' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, JsonValue> : undefined
    if (fact?.type === 'lane.snapshot' && event.conversationId) {
      const data = this.runSnapshots.get(runId)?.laneState ?? { runId, available: false, lanes: [] }
      projected = { runId, conversationId: event.conversationId, seq: event.seq, type: 'lanes', data: enrichLanesFromSnapshot(runId, data, fact) }
    }
    if (projected) this.pushEvent(runId, projected)
    if (event.type === 'waiting') void (async () => {
      const handle = this.activeRuns.get(runId)
      if (handle) {
        const items = await handle.pendingInteractions()
        const currentSeq = (event.seq ?? 0) + 0.25
        this.pushEvent(runId, { runId, conversationId: handle.conversationId, seq: currentSeq, type: 'interactions', data: { interactions: items.map(publicInteraction), ...(this.reviewNotes.has(runId) ? { reviewNote: this.reviewNotes.get(runId)! } : {}) } })
        if (await this.globalApprovalPolicy() === 'delegate') {
          void this.reviewPendingApprovals(runId).then(() => this.pushInteractionSnapshot(runId, currentSeq + 0.25)).catch(() => undefined)
        }
      }
    })().catch(() => undefined)
  }

  private pushEvent(runId: string, event: WebRunEvent): void {
    const buffer = this.runEventBuffers.get(runId)
    if (!buffer) return
    buffer.push(prepareRunEvent(event, (buffer[0] as unknown as WebRunEvent | undefined)?.runStartedAt) as unknown as AssistantEvent)
    const previous = this.runSnapshots.get(runId) ?? { runId, state: 'running' as const, seq: 0, activities: [] }
    const next: WebRunSnapshot = { ...previous, seq: Math.max(previous.seq, event.seq ?? 0) }
    if (event.type === 'status') next.status = event
    if (event.type === 'tool') next.activities = [...next.activities.filter(item => item.data.activityId !== event.data.activityId), event].slice(-30)
    if (event.type === 'waiting') next.waiting = event
    if (event.type === 'interactions') { if (event.data.reviewNote) next.reviewNote = event.data.reviewNote; else delete next.reviewNote; next.interactions = event.data.interactions; if (!next.interactions.length) delete next.waiting }
    if (event.type === 'lanes') next.laneState = event.data
    if (event.type === 'complete') { next.complete = event; next.state = event.data.status; delete next.waiting; next.interactions = [] }
    this.runSnapshots.set(runId, next)
    if (event.type === 'interactions' || event.type === 'waiting' || event.type === 'complete') {
      const timer = this.projectionTimers.get(runId); if (timer) clearTimeout(timer); this.projectionTimers.delete(runId)
      const writing = this.host.conversationData.call('saveState', `run:${runId}`, next)
      this.projectionWrites.set(runId, writing)
      void writing.finally(() => { if (this.projectionWrites.get(runId) === writing) this.projectionWrites.delete(runId) }).catch(() => undefined)
    } else if (!this.projectionTimers.has(runId)) this.projectionTimers.set(runId, setTimeout(() => {
      this.projectionTimers.delete(runId)
      void this.host.conversationData.call('saveState', `run:${runId}`, this.runSnapshots.get(runId)).catch(() => undefined)
    }, 100))
    for (const [client, subscriptions] of this.chatSubscriptions) if (subscriptions.has(runId) && (event.seq ?? 0) > subscriptions.get(runId)!) {
      this.sendChat(client, { type: 'event', event }); subscriptions.set(runId, event.seq ?? 0)
    }
    const clients = this.runSseClients.get(runId)
    if (clients) for (const client of [...clients]) this.flushClient(client, buffer, clients)
    if (buffer.length > 5000) {
      const removed = buffer.length - 4000
      buffer.splice(0, removed)
      if (clients) for (const client of clients) client.sent = Math.max(0, client.sent - removed)
    }
  }

  private async pushInteractionSnapshot(runId: string, seq: number): Promise<void> {
    const handle = this.activeRuns.get(runId)
    if (!handle) return
    const items = await handle.pendingInteractions()
    this.pushEvent(runId, { runId, conversationId: handle.conversationId, seq, type: 'interactions', data: { interactions: items.map(publicInteraction), ...(this.reviewNotes.has(runId) ? { reviewNote: this.reviewNotes.get(runId)! } : {}) } })
  }

  private async globalApprovalPolicy(): Promise<'manual' | 'delegate'> {
    const saved = await this.host.conversationData.call<{ policy?: string } | undefined>('readState', 'approval-policy')
    return saved?.policy === 'delegate' ? 'delegate' : 'manual'
  }

  private async setGlobalApprovalPolicy(policy: 'manual' | 'delegate'): Promise<void> {
    // One shared preference, independent of conversation creation or navigation.
    await this.host.conversationData.call('saveState', 'approval-policy', { policy })
    for (const runId of this.activeRuns.keys()) {
      if (policy === 'manual') {
        this.approvalReviewControllers.get(runId)?.abort()
        this.approvalReviewControllers.delete(runId)
        this.approvalReviewAgain.delete(runId)
        this.reviewNotes.delete(runId)
      }
      const update = async () => {
        if (policy === 'delegate') await this.reviewPendingApprovals(runId)
        await this.pushInteractionSnapshot(runId, (this.runEventBuffers.get(runId)?.at(-1)?.seq ?? 0) + 0.25)
      }
      // Saving the choice must not wait for the local review model to respond.
      void update().catch(() => undefined)
    }
  }

  private async reviewPendingApprovals(runId: string): Promise<void> {
    const handle = this.activeRuns.get(runId)
    if (!handle) return
    if (await this.globalApprovalPolicy() !== 'delegate') return
    if (this.approvalReviewControllers.has(runId)) {
      this.approvalReviewAgain.add(runId)
      return
    }
    const controller = new AbortController()
    this.approvalReviewControllers.set(runId, controller)
    const reviewed = new Set<string>()
    try {
      while (!controller.signal.aborted) {
        if (await this.globalApprovalPolicy() !== 'delegate' || controller.signal.aborted) return
        this.approvalReviewAgain.delete(runId)
        const groups = await handle.pendingInteractions()
        const next = groups.filter((group) => group.kind === 'approval').flatMap((group) => group.items).find((item) => !reviewed.has(item.effectId))
        if (!next) {
          if (this.approvalReviewAgain.has(runId)) continue
          break
        }
        reviewed.add(next.effectId)
        const result = await handle.reviewApproval(next.effectId, controller.signal)
        if (controller.signal.aborted) return
        if (result.status === 'manual') {
          const reasons: Record<string, string> = { reviewer_not_configured: '尚未配置本机审核模型', reviewer_must_be_local: '审核模型需要使用本机服务', review_timeout: '本机审核模型响应超时', review_failed: '本机审核模型调用失败', review_output_truncated: '审核回复不完整', review_not_explicitly_approved: '审核模型未明确批准本次操作', risk_requires_user: '本次操作涉及风险或尚未支持的工具', path_outside_workspace: '目标路径超出当前工作区', invalid_shell_syntax: '命令格式需要人工确认' }
          reasons.reviewer_unavailable = '本机审核服务未启动或无法连接'
          this.reviewNotes.set(runId, `需要你决定：${reasons[result.reason] ?? '代审无法确认本次操作'}。`)
        }
        else this.reviewNotes.delete(runId)
      }
    } finally {
      if (this.approvalReviewControllers.get(runId) === controller) this.approvalReviewControllers.delete(runId)
      const requestedAgain = this.approvalReviewAgain.delete(runId)
      if (requestedAgain && !controller.signal.aborted && this.activeRuns.has(runId)) queueMicrotask(() => void this.reviewPendingApprovals(runId))
    }
  }

  private replyReceiptPath(conversationId: string, runId: string): string {
    return join(this.dataDir, 'conversations', conversationId, 'runs', runId, 'interaction-receipts.json')
  }

  private async snapshotRun(runId: string, events: AssistantEvent[], active: boolean): Promise<WebRunSnapshot> {
    await this.projectionWrites.get(runId)?.catch(() => undefined)
    const projected = this.runSnapshots.get(runId) ?? await this.host.conversationData.call<WebRunSnapshot | undefined>('readState', `run:${runId}`)
    if (projected) return { ...projected, ...(this.reviewNotes.has(runId) ? { reviewNote: this.reviewNotes.get(runId)! } : {}), ...(active ? { state: 'running' as const } : projected.state === 'running' ? { state: 'interrupted' as const } : {}) }
    let status: WebRunSnapshot['status']
    let complete: WebRunSnapshot['complete']
    let waiting: WebRunSnapshot['waiting']
    let interactions: WebPendingInteraction[] | undefined
    let laneState: WebRunSnapshot['laneState']
    const activities = new Map<string, Extract<WebRunEvent, { type: 'tool' }>>()
    let seq = 0
    for (const raw of events) {
      const event = raw as unknown as WebRunEvent
      seq = Math.max(seq, event.seq ?? 0)
      if (event.type === 'status') status = event
      else if (event.type === 'tool') activities.set(event.data.activityId, event)
      else if (event.type === 'waiting') waiting = event
      else if (event.type === 'interactions') { interactions = event.data.interactions; if (event.data.reviewNote) this.reviewNotes.set(runId, event.data.reviewNote); else this.reviewNotes.delete(runId) }
      else if (event.type === 'lanes') laneState = event.data
      else if (event.type === 'complete') { complete = event; waiting = undefined; interactions = [] }
    }
    const state = active ? 'running' : complete?.data.status ?? 'interrupted'
    return { runId, state, seq, ...(status ? { status } : {}), activities: [...activities.values()].slice(-30), ...(waiting ? { waiting } : {}), ...(interactions ? { interactions } : {}), ...(laneState ? { laneState } : {}), ...(this.reviewNotes.has(runId) ? { reviewNote: this.reviewNotes.get(runId)! } : {}), ...(complete ? { complete } : {}) }
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

  private runTracePath(conversationId: string, runId: string): string {
    return join(this.dataDir, 'conversations', conversationId, 'runs', runId, 'web-trace.json')
  }

  /** Keep the browser-safe execution trace so a finished run can be reopened after a refresh. */
  private async persistRunTrace(runId: string): Promise<void> {
    const conversationId = this.runConversations.get(runId)
    const buffer = this.runEventBuffers.get(runId)
    if (!conversationId || !buffer) return
    const events = compactTraceEvents(buffer as unknown as WebRunEvent[])
    if (events.length === 0) return
    await mkdir(join(this.dataDir, 'conversations', conversationId, 'runs', runId), { recursive: true })
    await writeFile(this.runTracePath(conversationId, runId), JSON.stringify({ version: 1, events }), { encoding: 'utf8', mode: 0o600 })
  }

  private async loadRunTrace(runId: string): Promise<{ events: WebRunEvent[]; seq: number }> {
    const buffer = this.runEventBuffers.get(runId)
    if (buffer) {
      const raw = buffer as unknown as WebRunEvent[]
      return { events: compactTraceEvents(raw), seq: traceWatermark(raw) }
    }
    const conversationId = await this.host.findConversationByRunId(runId).catch(() => undefined)
    if (!conversationId) return { events: [], seq: 0 }
    try {
      const parsed = JSON.parse(await readFile(this.runTracePath(conversationId, runId), 'utf8')) as { events?: WebRunEvent[] }
      const events = Array.isArray(parsed.events) ? compactTraceEvents(parsed.events) : []
      return { events, seq: traceWatermark(events) }
    } catch { return { events: [], seq: 0 } }
  }

  /** One response for the visible history, instead of a request per assistant message. */
  private async loadConversationTraces(conversationId: string): Promise<Array<{ runId: string; events: WebRunEvent[]; seq: number }>> {
    const messages = (await this.host.getMessagePage(conversationId, undefined, 100).catch(() => ({ items: [] }))).items
    const runIds: string[] = []
    for (const message of [...messages].reverse()) {
      if (!message.runId || runIds.includes(message.runId) || !isSafePathId(message.runId)) continue
      runIds.push(message.runId)
      if (runIds.length >= 40) break
    }
    const traces: Array<{ runId: string; events: WebRunEvent[]; seq: number }> = []
    for (const runId of runIds.reverse()) {
      const buffer = this.runEventBuffers.get(runId)
      if (buffer && this.runConversations.get(runId) === conversationId) {
        const raw = buffer as unknown as WebRunEvent[]
        const events = compactTraceEvents(raw)
        if (events.length > 0) traces.push({ runId, events, seq: traceWatermark(raw) })
        continue
      }
      try {
        const parsed = JSON.parse(await readFile(this.runTracePath(conversationId, runId), 'utf8')) as { events?: WebRunEvent[] }
        if (!Array.isArray(parsed.events)) continue
        const events = compactTraceEvents(parsed.events)
        if (events.length === 0) continue
        traces.push({ runId, events, seq: traceWatermark(events) })
      } catch { /* This run has no persisted trace. */ }
    }
    return traces
  }

  private finishStream(runId: string): void {
    const lastSeq = this.runEventBuffers.get(runId)?.at(-1)?.seq ?? 0
    for (const [client, subscriptions] of this.chatSubscriptions) if (subscriptions.has(runId)) this.sendChat(client, { type: 'event', event: { type: 'run_finished', runId, seq: lastSeq + 1 } })
    this.approvalReviewControllers.get(runId)?.abort()
    this.approvalReviewControllers.delete(runId)
    this.approvalReviewAgain.delete(runId)
    this.reviewNotes.delete(runId)
    const clients = this.runSseClients.get(runId)
    if (clients) {
      for (const client of clients) {
        if (client.res.writableEnded || client.res.destroyed) continue
        const conversationId = this.runConversations.get(runId)
        this.writeSse(client.res, { type: 'run_finished', runId, seq: (this.runEventBuffers.get(runId)?.at(-1)?.seq ?? 0) + 1, ...(conversationId ? { conversationId } : {}) })
        try { client.res.end() } catch { /* already closed */ }
      }
    }
    void this.persistRunTrace(runId).catch(error => {
      const message = error instanceof Error ? error.message : 'unknown'
      console.error(`Failed to persist run trace ${runId}: ${message}`)
    })
    this.activeRuns.delete(runId)
    this.runSseClients.delete(runId)
    const existing = this.bufferTimers.get(runId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.runEventBuffers.delete(runId)
      this.runConversations.delete(runId)
      this.runSnapshots.delete(runId)
      this.bufferTimers.delete(runId)
    }, 60_000)
    timer.unref()
    this.bufferTimers.set(runId, timer)
  }

  private writeSse(res: ServerResponse, event: unknown): boolean {
    try {
      const record = event && typeof event === 'object' ? event as Record<string, unknown> : undefined
      const id = typeof record?.runId === 'string' && typeof record.seq === 'number' ? `${record.runId}:${record.seq}` : undefined
      res.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
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
  if (Array.isArray(body.values) && body.values.every((item) => typeof item === 'string')) {
    return { values: body.values }
  }
  return undefined
}

function publicInteraction(interaction: { groupId: string; kind: 'ask' | 'approval'; items: Array<{ effectId: string; input: Record<string, JsonValue> }> }): WebPendingInteraction {
  return {
    groupId: interaction.groupId,
    kind: interaction.kind,
    items: interaction.items.map(({ effectId, input }) => {
      const safe: Record<string, unknown> = {}
      if (interaction.kind === 'ask') {
        for (const key of ['kind', 'type', 'prompt', 'context', 'placeholder', 'defaultValue', 'min', 'max'] as const) if (input[key] !== undefined) safe[key] = input[key]
        if (Array.isArray(input.options)) safe.options = input.options.filter(item => typeof item === 'string' || Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, JsonValue>).value === 'string'))
      } else {
        safe.kind = 'approval'
        safe.prompt = 'Pulse 需要你确认以下操作。'
        if (Array.isArray(input.tools)) {
          safe.operationCount = input.tools.length
          safe.tools = input.tools.flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return []
            const call = item as Record<string, JsonValue>
            const args = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, JsonValue> : call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, JsonValue> : {}
            const details: Record<string, unknown> = {}
            for (const key of ['path', 'source', 'destination', 'command', 'cwd'] as const) if (typeof args[key] === 'string') details[key] = String(args[key]).slice(0, 2_000)
            if (Array.isArray(args.args)) details.args = args.args.filter((value) => typeof value === 'string').slice(0, 20).map((value) => String(value).slice(0, 300))
            return [{ toolName: typeof call.toolName === 'string' ? call.toolName : typeof call.name === 'string' ? call.name : 'tool', details }]
          })
        }
      }
      return { effectId, input: safe }
    }),
  }
}

/**
 * A work run may execute in an isolated worker process, where the parent Host has no live
 * lane state. The snapshot fact travels with the event stream, so use it for goals and as a
 * fallback source of lanes.
 */
function enrichLanesFromSnapshot(runId: string, lanes: WebRunLanes, fact: Record<string, JsonValue>): WebRunLanes {
  const snapshot = Array.isArray(fact.lanes) ? fact.lanes.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
  const byId = new Map(snapshot.map(item => [String(item.id), item]))
  const known = new Map(lanes.lanes.map(lane => [lane.id, lane]))
  const merged: WebLane[] = lanes.lanes.map(lane => {
    const goal = byId.get(lane.id)?.goal
    return typeof goal === 'string' && goal ? { ...lane, goal: goal.slice(0, 240) } : lane
  })
  snapshot.forEach((item, index) => {
    const id = String(item.id)
    if (known.has(id) || typeof item.status !== 'string') return
    merged.push({ id, ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : {}), label: typeof item.parentId === 'string' ? `并行任务 ${index + 1}` : '主任务', ...(typeof item.goal === 'string' ? { goal: item.goal.slice(0, 240) } : {}), status: item.status as WebLane['status'] })
  })
  return { runId, available: merged.length > 0, lanes: merged }
}

function publicH5Event(event: AssistantEvent): WebRunEvent | undefined {
  const base = { ...(event.conversationId ? { conversationId: event.conversationId } : {}), runId: event.runId, seq: event.seq }
  if (event.type === 'observation' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && event.data.kind === 'input_response') return { ...base, type: 'input_response', data: { messageId: String(event.data.messageId), text: String(event.data.text) } }
  if (event.type === 'text' && typeof event.data === 'string') return { ...base, type: 'text', activityId: `${event.runId}:answer`, data: event.data }
  if (event.type === 'notice' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const kind = (event.data as Record<string, JsonValue>).kind
    if (kind === 'front_ack' || kind === 'task_progress') {
      const label = kind === 'task_progress' && typeof (event.data as Record<string, JsonValue>).text === 'string' ? String((event.data as Record<string, JsonValue>).text).slice(0, 140) : undefined
      return { ...base, type: 'status', data: { kind: 'working', ...(label ? { label } : {}) } }
    }
    if (kind === 'context_compacted') return { ...base, type: 'status', data: { kind: 'context', label: '正在整理上下文' } }
    return undefined
  }
  if (event.type === 'observation' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const tool = event.data as Record<string, JsonValue>
    if (tool.kind === 'model' && typeof tool.modelId === 'string') {
      return { ...base, type: 'trace', data: { kind: 'model', ...(typeof tool.effectId === 'string' ? { effectId: tool.effectId } : {}), ...(typeof tool.laneId === 'string' ? { laneId: tool.laneId } : {}), ...(typeof tool.attemptId === 'string' ? { attemptId: tool.attemptId } : {}), task: typeof tool.task === 'string' ? tool.task : 'reason', modelId: tool.modelId, ...(typeof tool.providerId === 'string' ? { providerId: tool.providerId } : {}), attemptNo: typeof tool.attemptNo === 'number' ? tool.attemptNo : 1, fallback: tool.fallback === true } }
    }
    if ((tool.kind === 'reasoning' || tool.kind === 'note') && typeof tool.text === 'string') {
      return { ...base, type: 'trace', data: { kind: tool.kind, ...(typeof tool.effectId === 'string' ? { effectId: tool.effectId } : {}), ...(typeof tool.laneId === 'string' ? { laneId: tool.laneId } : {}), ...(typeof tool.attemptId === 'string' ? { attemptId: tool.attemptId } : {}), ...(typeof tool.attemptNo === 'number' ? { attemptNo: tool.attemptNo } : {}), task: typeof tool.task === 'string' ? tool.task : 'reason', ...(typeof tool.modelId === 'string' ? { modelId: tool.modelId } : {}), text: tool.text } }
    }
    const started = tool.kind === 'tool_start'
    const status = started ? 'running' : tool.status
    if (typeof tool.tool !== 'string' || (status !== 'running' && status !== 'succeeded' && status !== 'failed' && status !== 'cancelled')) return undefined
    if (typeof tool.effectId !== 'string') return undefined
    const attemptId = typeof tool.attemptId === 'string' ? tool.attemptId : 'initial'
    const record = (value: JsonValue | undefined): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    const args = record(tool.args)
    const preview = record(tool.preview)
    const error = record(tool.result)
    return { ...base, type: 'tool', data: { activityId: `${event.runId}:${tool.effectId}:${attemptId}`, effectId: tool.effectId, ...(attemptId === 'initial' ? {} : { attemptId }), ...(typeof tool.laneId === 'string' ? { laneId: tool.laneId } : {}), tool: tool.tool, status, ...(args ? { args } : {}), ...(preview ? { preview } : {}), ...(error ? { error } : {}) } }
  }
  if (event.type === 'waiting' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const data = event.data as Record<string, JsonValue>
    if (typeof data.effectId !== 'string' || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) return undefined
    const input = data.input as Record<string, JsonValue>
    const safe = publicInteraction({ groupId: `effect:${data.effectId}`, kind: input.kind === 'ask' ? 'ask' : 'approval', items: [{ effectId: String(data.effectId), input }] }).items[0]?.input ?? {}
    return { ...base, type: 'waiting', data: { effectId: data.effectId, input: safe } }
  }
  if (event.type === 'complete' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const data = event.data as Record<string, JsonValue>
    const status = data.status === 'succeeded' || data.status === 'cancelled' ? data.status : 'failed'
    const error = data.error && typeof data.error === 'object' && !Array.isArray(data.error) ? data.error as Record<string, JsonValue> : undefined
    return { ...base, type: 'complete', data: { status, ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}) } }
  }
  if (event.type === 'error') return { ...base, type: 'error', data: { message: '运行遇到错误，请查看本机任务记录。' } }
  if (event.type === 'gap' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const data = event.data as Record<string, JsonValue>
    if (typeof data.fromSeq === 'number' && typeof data.toSeq === 'number') return { ...base, type: 'gap', data: { fromSeq: data.fromSeq, toSeq: data.toSeq } }
  }
  // Raw model chunks, planner facts, lane snapshots, and verifier details never enter the browser event stream.
  return undefined
}
