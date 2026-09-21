import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { assertPublicNetworkUrl, conversationDirectory, publicUrl, safeShellEnv, searchFiles, within } from './security.js'
import {
  FileRuntimePersistenceBackend,
  ModelRouter,
  InMemoryModelRegistry,
  PulseRuntime,
  defineReActLane,
  type JsonValue,
  type ModelCapabilities,
  type Outcome,
  type PulseSession,
  type SessionEvent,
} from '@hunterzhu/pulse-runtime'
import {
  createModelEffectExecutor,
  createProviderAdapter,
  createToolEffectExecutor,
  createToolEffectSubmissionPreparer,
  MockAdapter,
  runShell,
  FilesystemTool,
  type ProviderAdapter,
  type ProviderPresetConfig,
} from '@hunterzhu/pulse-adapters'
import { defineTool, ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import { legacyPulseDataPath, pulseDataPath, pulseLogPath } from './paths.js'

export { legacyPulseDataPath, pulseDataPath, pulseHomePath, pulseLogPath } from './paths.js'

export type ApprovalMode = 'read-only' | 'ask' | 'auto'
export interface LocalHostOptions {
  cwd?: string
  dataDir?: string
  logDir?: string
  provider?: ProviderPresetConfig
  mockResponse?: string
  mockToolCalls?: Array<{ name: string; input?: JsonValue; toolCallId?: string }>
  mockAfterToolResponse?: string
  approvalMode?: ApprovalMode
  allowNetwork?: boolean
  networkHosts?: string[]
  maxRuntimeMs?: number
}
export interface CreateConversationInput { cwd?: string; title?: string }
export interface ArtifactSummary { path: string; hash: string; bytes: number; mediaType?: string; label?: string; runId: string }
export interface ConversationSummary { id: string; title: string; cwd: string; createdAt: string; updatedAt: string; activeRunId?: string; artifacts?: ArtifactSummary[] }
export interface UserMessageInput { text: string; format?: 'text' | 'jsonl' }
export interface AssistantEvent {
  schemaVersion: 1
  type: 'text' | 'fact' | 'observation' | 'waiting' | 'complete' | 'error' | 'gap'
  conversationId: string
  runId: string
  seq: number
  data?: JsonValue
}
export interface RunHandle {
  readonly id: string
  readonly conversationId: string
  readonly events: AsyncIterable<AssistantEvent>
  outcome(): Promise<Outcome & { text?: string }>
  cancel(reason?: string): Promise<void>
  reply(effectId: string, value: JsonValue): Promise<void>
}
export interface ConversationHandle { readonly id: string; readonly summary: ConversationSummary }

interface Manifest extends ConversationSummary { schemaVersion: 1; runs: string[] }
interface StoredMessage { id: string; role: 'user' | 'assistant' | 'system'; text: string; runId?: string; createdAt: string }

const textLimit = 48_000
const json = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => json(item))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]))
  return String(value)
}
async function fetchText(raw: string, signal: AbortSignal, allowHosts?: string[]): Promise<{ url: string; title: string; text: string; truncated: boolean; fetchedAt: string }> {
  const url = await assertPublicNetworkUrl(raw, allowHosts); const response = await fetch(url, { signal, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw new Error('REDIRECT_REQUIRES_EXPLICIT_FETCH')
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml')) throw new Error('UNSUPPORTED_WEB_CONTENT_TYPE')
  const source = await response.text(); const text = source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? url.hostname; const limit = 32_000
  return { url: url.toString(), title, text: text.slice(0, limit), truncated: text.length > limit, fetchedAt: new Date().toISOString() }
}

function registerBuiltIns(registry: ToolRegistry, root: string, approvalMode: ApprovalMode, allowNetwork = false, isApprovedToolCall: (toolCallId: string) => boolean = () => false, networkHosts?: string[]): void {
  const fsTool = new FilesystemTool(root)
  registry.register(defineTool({
    name: 'fs.list', description: 'List files in the workspace.', tags: ['files', 'read'], input: z.object({ path: z.string().default('.') }), output: z.object({ path: z.string(), entries: z.array(z.string()) }), sideEffectPolicy: 'read', permissions: { workspaceRoots: [root] }, execute: async ({ path }) => { const safePath = path ?? '.'; return { path: safePath, entries: await fsTool.list(safePath) } }, summarize: (output) => ({ path: output.path ?? '.', entries: output.entries.slice(0, 100) }),
  }))
  registry.register(defineTool({
    name: 'fs.read', description: 'Read a UTF-8 text file from the workspace.', tags: ['files', 'read'], input: z.object({ path: z.string(), maxBytes: z.number().int().positive().max(200_000).optional() }), output: z.object({ path: z.string(), content: z.string(), truncated: z.boolean() }), sideEffectPolicy: 'read', permissions: { workspaceRoots: [root] }, execute: async ({ path, maxBytes }) => { const limit = maxBytes ?? 64_000; const read = await fsTool.readLimited(path, limit); return { path, content: read.content, truncated: read.truncated } }, summarize: (output) => ({ path: output.path, content: output.content.slice(0, 1_000), truncated: output.truncated }),
  }))
  registry.register(defineTool({
    name: 'fs.search', description: 'Search text files in the workspace.', tags: ['files', 'search'], input: z.object({ query: z.string().min(1), path: z.string().default('.') }), output: z.object({ matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })) }), sideEffectPolicy: 'read', permissions: { workspaceRoots: [root] }, execute: async ({ query, path }) => ({ matches: await searchFiles(root, query, path) }), summarize: (output) => ({ matches: output.matches.slice(0, 20) }),
  }))
  registry.register(defineTool({
    name: 'fs.write', description: 'Write a UTF-8 text file after authorization.', tags: ['files', 'write'], input: z.object({ path: z.string(), content: z.string().max(500_000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }), output: z.object({ path: z.string(), bytes: z.number(), hash: z.string() }), sideEffectPolicy: 'write', retrySafety: 'unsafe', permissions: { workspaceRoots: [root] }, execute: async ({ path, content, expectedHash }, context) => { if (approvalMode === 'read-only') throw new Error('WRITE_DISABLED_READ_ONLY'); if (approvalMode === 'ask' && !isApprovedToolCall(context.toolCallId)) throw new Error('APPROVAL_REQUIRED:fs.write'); if (expectedHash) return { path, ...(await fsTool.writeIfUnchanged(path, content, expectedHash)) }; await fsTool.write(path, content); const bytes = Buffer.byteLength(content); return { path, bytes, hash: await fsTool.hash(path) } }, summarize: (output) => output,
  }))
  registry.register(defineTool({
    name: 'fs.apply_patch', description: 'Replace an exact text fragment in a UTF-8 file after authorization.', tags: ['files', 'write', 'patch'], input: z.object({ path: z.string(), find: z.string().min(1), replace: z.string(), all: z.boolean().default(false), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }), output: z.object({ path: z.string(), replacements: z.number(), bytes: z.number(), hash: z.string() }), sideEffectPolicy: 'write', retrySafety: 'unsafe', permissions: { workspaceRoots: [root] }, execute: async ({ path, find, replace, all, expectedHash }, context) => { if (approvalMode === 'read-only') throw new Error('WRITE_DISABLED_READ_ONLY'); if (approvalMode === 'ask' && !isApprovedToolCall(context.toolCallId)) throw new Error('APPROVAL_REQUIRED:fs.apply_patch'); const source = await fsTool.readLimited(path, 500_000); if (source.truncated) throw new Error('FILE_TOO_LARGE'); const count = source.content.split(find).length - 1; if (count === 0) throw new Error('PATCH_CONTEXT_NOT_FOUND'); if (!all && count !== 1) throw new Error('PATCH_CONTEXT_AMBIGUOUS'); const content = all ? source.content.split(find).join(replace) : source.content.replace(find, replace); if (expectedHash) await fsTool.writeIfUnchanged(path, content, expectedHash); else await fsTool.write(path, content); return { path, replacements: all ? count : 1, bytes: Buffer.byteLength(content), hash: await fsTool.hash(path) } }, summarize: (output) => output,
  }))
  registry.register(defineTool({
    name: 'fs.move', description: 'Move a file without overwriting an existing destination.', tags: ['files', 'write', 'organize'], input: z.object({ source: z.string(), destination: z.string(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }), output: z.object({ source: z.string(), destination: z.string(), bytes: z.number(), hash: z.string() }), sideEffectPolicy: 'write', retrySafety: 'unsafe', permissions: { workspaceRoots: [root] }, execute: async ({ source, destination, expectedHash }, context) => { if (approvalMode === 'read-only') throw new Error('MOVE_DISABLED_READ_ONLY'); if (approvalMode === 'ask' && !isApprovedToolCall(context.toolCallId)) throw new Error('APPROVAL_REQUIRED:fs.move'); const moved = await fsTool.move(source, destination, expectedHash, context.signal); return { source, destination, ...moved } }, summarize: (output) => output,
  }))
  registry.register(defineTool({
    name: 'artifact.record', description: 'Record a bounded text file as a user-visible artifact.', tags: ['artifact', 'files', 'read'], input: z.object({ path: z.string(), mediaType: z.string().default('text/plain'), label: z.string().max(200).optional() }), output: z.object({ path: z.string(), mediaType: z.string(), label: z.string(), bytes: z.number(), hash: z.string() }), sideEffectPolicy: 'read', permissions: { workspaceRoots: [root] }, execute: async ({ path, mediaType, label }) => { const read = await fsTool.readLimited(path, 200_000); if (read.truncated) throw new Error('FILE_TOO_LARGE'); return { path, mediaType: mediaType ?? 'text/plain', label: label ?? path, bytes: Buffer.byteLength(read.content), hash: await fsTool.hash(path) } }, summarize: (output) => output,
  }))
  registry.register(defineTool({
    name: 'shell.exec', description: 'Run an authorized local command with argv arguments.', tags: ['shell', 'system'], input: z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().default('.'), timeoutMs: z.number().int().positive().max(300_000).optional() }), output: z.object({ code: z.number().nullable(), stdout: z.string(), stderr: z.string(), truncated: z.boolean(), timedOut: z.boolean(), aborted: z.boolean() }), sideEffectPolicy: 'external', retrySafety: 'unsafe', permissions: { workspaceRoots: [root] }, execute: async ({ command, args, cwd, timeoutMs }, context) => { if (approvalMode === 'read-only') throw new Error('SHELL_DISABLED_READ_ONLY'); if (approvalMode === 'ask' && !isApprovedToolCall(context.toolCallId)) throw new Error('APPROVAL_REQUIRED:shell.exec'); const options = { cwd: await within(root, cwd ?? '.'), signal: context.signal, env: safeShellEnv(), maxOutputBytes: 64 * 1024, ...(timeoutMs === undefined ? {} : { timeoutMs }) }; return runShell(command, args, options) }, summarize: (output) => ({ code: output.code, stdout: output.stdout.slice(0, 2_000), stderr: output.stderr.slice(0, 2_000), truncated: output.truncated }),
  }))
  if (allowNetwork) {
    registry.register(defineTool({
      name: 'web.fetch', description: 'Fetch a public HTTP(S) page and return bounded text.', tags: ['web', 'research'], input: z.object({ url: z.string().url() }), output: z.object({ url: z.string(), title: z.string(), text: z.string(), truncated: z.boolean(), fetchedAt: z.string() }), sideEffectPolicy: 'external', retrySafety: 'read_only', permissions: { networkHosts: networkHosts ?? ['*'] }, execute: async ({ url }, context) => fetchText(url, context.signal, networkHosts), summarize: (output) => ({ url: output.url, title: output.title, text: output.text.slice(0, 2_000), truncated: output.truncated, fetchedAt: output.fetchedAt }),
    }))
    registry.register(defineTool({
      name: 'web.search', description: 'Search public web pages using the configured DuckDuckGo HTML endpoint.', tags: ['web', 'research'], input: z.object({ query: z.string().min(1).max(500), limit: z.number().int().positive().max(10).default(5) }), output: z.object({ query: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })), fetchedAt: z.string() }), sideEffectPolicy: 'external', retrySafety: 'read_only', permissions: { networkHosts: ['html.duckduckgo.com'] }, execute: async ({ query, limit }, context) => { const endpoint = await assertPublicNetworkUrl(process.env.PULSE_SEARCH_URL ?? 'https://html.duckduckgo.com/html/'); endpoint.searchParams.set('q', query); const response = await fetch(endpoint, { signal: context.signal }); if (!response.ok) throw new Error(`HTTP_${response.status}`); const page = await response.text(); const results: Array<{ title: string; url: string; snippet: string }> = []; const pattern = /result__a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?result__snippet[^>]*>([\s\S]*?)<\//g; for (const match of page.matchAll(pattern)) { if (results.length >= (limit ?? 5)) break; const url = publicUrl(match[1] ?? '', networkHosts).toString(); results.push({ title: (match[2] ?? '').replace(/<[^>]+>/g, '').trim(), url, snippet: (match[3] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }) } return { query, results, fetchedAt: new Date().toISOString() } }, summarize: (output) => ({ query: output.query, results: output.results, fetchedAt: output.fetchedAt }),
    }))
  }
}

function buildProgram(toolNames: string[]) {
  return (approvalMode: ApprovalMode = 'ask') => defineReActLane({ id: 'pulse.assistant', version: '1', system: 'You are Pulse, a careful general task assistant. Use available tools when they help. Explain what you did and cite workspace paths. Never claim an action succeeded unless its tool result confirms it.', toolSet: 'pulse.default', task: 'reason', instruction: ({ goal }) => goal, toolAllow: toolNames, maxTurns: 12, ...(approvalMode === 'ask' ? { toolApproval: { prompt: () => 'Reply with approved=true to continue or approved=false to deny.' } } : {}) })
}

function providerFromOptions(options: LocalHostOptions): { adapter: ProviderAdapter; model: { id: string; providerId: string; tasks: string[]; priority: number; capabilities: ModelCapabilities; adapter: ProviderAdapter } } {
  const config = options.provider ?? { provider: 'mock', defaultModel: 'mock' }
  const adapter = createProviderAdapter(config)
  if (config.provider === 'mock' && adapter instanceof MockAdapter) {
    const toolCalls = options.mockToolCalls ?? []
    if (toolCalls.length) adapter.enqueue({ text: '', toolCalls: toolCalls.map((call, index) => ({ toolCallId: call.toolCallId ?? `mock-call-${index + 1}`, name: call.name, input: call.input ?? {} })), finishReason: 'tool_calls' })
    adapter.enqueue({ text: options.mockAfterToolResponse ?? options.mockResponse ?? process.env.PULSE_MOCK_RESPONSE ?? 'Mock provider is ready. Configure a real provider for model-generated answers.', toolCalls: [], finishReason: 'stop' })
  }
  const local = config.provider === 'mock' || config.provider === 'ollama'
  return { adapter, model: { id: config.defaultModel ?? `${config.provider}-default`, providerId: adapter.id, tasks: ['reason', 'plan', 'merge'], priority: 10, capabilities: { toolCalling: true, structuredOutput: true, reasoning: 'medium', maxContextTokens: 32_000, maxOutputTokens: config.maxOutputTokens ?? 4_096, local }, adapter } }
}

export class LocalHost {
  private readonly root: string
  private readonly dataDir: string
  private readonly logDir: string
  private readonly usesDefaultDataDir: boolean
  private readonly shouldMigrateLegacyData: boolean
  private readonly options: LocalHostOptions
  private readonly approvedToolCalls = new Map<string, Set<string>>()
  private readonly active = new Map<string, { runtime: PulseRuntime; session: PulseSession; conversationId: string; runId: string }>()
  private readonly conversationLocks = new Map<string, Awaited<ReturnType<typeof open>>>()
  constructor(options: LocalHostOptions = {}) {
    this.root = resolve(options.cwd ?? process.cwd())
    this.usesDefaultDataDir = options.dataDir === undefined && process.env.PULSE_DATA_DIR === undefined
    this.shouldMigrateLegacyData = this.usesDefaultDataDir && process.env.PULSE_HOME === undefined
    this.dataDir = resolve(options.dataDir ?? process.env.PULSE_DATA_DIR ?? pulseDataPath())
    this.logDir = resolve(options.logDir ?? process.env.PULSE_LOG_DIR ?? pulseLogPath())
    this.options = options
  }
  private async migrateLegacyData(): Promise<void> {
    if (!this.shouldMigrateLegacyData) return
    const legacy = resolve(legacyPulseDataPath())
    if (legacy === this.dataDir) return
    try { await stat(this.dataDir); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await stat(legacy) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    await mkdir(dirname(this.dataDir), { recursive: true })
    await rename(legacy, this.dataDir)
  }
  async init(): Promise<void> { await this.migrateLegacyData(); await mkdir(this.dataDir, { recursive: true }); if (this.usesDefaultDataDir || this.options.logDir !== undefined || process.env.PULSE_LOG_DIR !== undefined) await mkdir(this.logDir, { recursive: true }); await stat(this.root) }
  private conversationDir(id: string): string { return conversationDirectory(this.dataDir, id) }
  private manifestPath(id: string): string { return join(this.conversationDir(id), 'manifest.json') }
  private messagesPath(id: string): string { return join(this.conversationDir(id), 'messages.jsonl') }
  private runDir(conversationId: string, runId: string): string { return join(this.conversationDir(conversationId), 'runs', runId) }
  private lockPath(conversationId: string): string { return join(this.conversationDir(conversationId), 'conversation.lock') }
  private async acquireConversationLock(conversationId: string, runId: string): Promise<void> {
    const path = this.lockPath(conversationId); await mkdir(this.conversationDir(conversationId), { recursive: true })
    for (;;) {
      try { const handle = await open(path, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, runId, acquiredAt: new Date().toISOString() })); this.conversationLocks.set(conversationId, handle); return }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const body = await readFile(path, 'utf8').catch(() => undefined)
        let owner: { pid?: number } | undefined
        try { owner = body ? JSON.parse(body) as { pid?: number } : undefined } catch { owner = undefined }
        if (typeof owner?.pid === 'number') {
          try { process.kill(owner.pid, 0); throw new Error('CONVERSATION_BUSY') } catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError }
          const current = await readFile(path, 'utf8').catch(() => undefined)
          if (current === body) { await rm(path, { force: true }); continue }
        }
        throw new Error('CONVERSATION_BUSY')
      }
    }
  }
  private async releaseConversationLock(conversationId: string): Promise<void> { const handle = this.conversationLocks.get(conversationId); if (!handle) return; this.conversationLocks.delete(conversationId); await handle.close().catch(() => undefined); await rm(this.lockPath(conversationId), { force: true }).catch(() => undefined) }
  private async readManifest(id: string): Promise<Manifest> { return JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as Manifest }
  async createConversation(input: CreateConversationInput = {}): Promise<ConversationHandle> { const id = `conv-${randomUUID()}`; const now = new Date().toISOString(); const cwd = resolve(input.cwd ?? this.root); const manifest: Manifest = { schemaVersion: 1, id, title: input.title ?? 'New conversation', cwd, createdAt: now, updatedAt: now, runs: [], artifacts: [] }; await mkdir(this.conversationDir(id), { recursive: true }); await writeFile(this.manifestPath(id), JSON.stringify(manifest, null, 2)); return { id, summary: manifest } }
  async listConversations(): Promise<ConversationSummary[]> { await this.init(); const entries = await readdir(join(this.dataDir, 'conversations'), { withFileTypes: true }).catch(() => []); const summaries: ConversationSummary[] = []; for (const entry of entries) { if (!entry.isDirectory()) continue; try { const manifest = await this.readManifest(entry.name); summaries.push(manifest) } catch { /* ignore incomplete directories */ } } return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  async getConversation(id: string): Promise<ConversationHandle> { const manifest = await this.readManifest(id); return { id, summary: manifest } }
  async listArtifacts(id: string): Promise<ArtifactSummary[]> { return [...((await this.readManifest(id)).artifacts ?? [])] }
  private async appendMessage(id: string, message: StoredMessage): Promise<void> { await writeFile(this.messagesPath(id), `${JSON.stringify(message)}\n`, { flag: 'a' }) }
  private runtimeFor(conversationId: string, runId: string, cwd: string): { runtime: PulseRuntime; registry: ToolRegistry } {
    const registry = new ToolRegistry({ workspaceRoots: [cwd], allowNetwork: this.options.allowNetwork === true, ...(this.options.networkHosts === undefined ? {} : { networkHosts: this.options.networkHosts }) })
    registerBuiltIns(registry, cwd, this.options.approvalMode ?? 'ask', this.options.allowNetwork === true, (toolCallId) => this.approvedToolCalls.get(runId)?.has(toolCallId) === true, this.options.networkHosts)
    const provider = providerFromOptions(this.options)
    const models = new InMemoryModelRegistry(); models.register(provider.model)
    const router = new ModelRouter(models)
    router.register({ task: 'reason', candidates: [provider.model.id] }); router.register({ task: 'plan', candidates: [provider.model.id] }); router.register({ task: 'merge', candidates: [provider.model.id] })
    const backend = new FileRuntimePersistenceBackend(join(this.runDir(conversationId, runId), 'runtime.json'))
    const toolVersions = Object.fromEntries(registry.list().map((tool) => [tool.name, tool.version]))
    const runtime = new PulseRuntime({ sessionId: runId, maxRuntimeMs: this.options.maxRuntimeMs ?? 15 * 60_000, programs: [], models, modelRouter: router, toolVersions, builtinHumanEffects: true, effectExecutor: async (effect, signal, observe) => { if (effect.kind === 'llm') return createModelEffectExecutor({ router, providers: new Map([[provider.adapter.id, provider.adapter]]) })(effect, signal, observe); if (effect.kind === 'tool') return createToolEffectExecutor(registry)(effect, signal, observe); throw new Error(`UNSUPPORTED_EFFECT_KIND:${effect.kind}`) }, effectSubmissionPreparer: createToolEffectSubmissionPreparer(registry), persistenceBackend: backend })
    return { runtime, registry }
  }
  private async restoreRuntimeFor(conversationId: string, runId: string, cwd: string): Promise<{ runtime: PulseRuntime; registry: ToolRegistry }> {
    const registry = new ToolRegistry({ workspaceRoots: [cwd], allowNetwork: this.options.allowNetwork === true, ...(this.options.networkHosts === undefined ? {} : { networkHosts: this.options.networkHosts }) })
    registerBuiltIns(registry, cwd, this.options.approvalMode ?? 'ask', this.options.allowNetwork === true, (toolCallId) => this.approvedToolCalls.get(runId)?.has(toolCallId) === true, this.options.networkHosts)
    const provider = providerFromOptions(this.options)
    const models = new InMemoryModelRegistry(); models.register(provider.model)
    const router = new ModelRouter(models)
    router.register({ task: 'reason', candidates: [provider.model.id] }); router.register({ task: 'plan', candidates: [provider.model.id] }); router.register({ task: 'merge', candidates: [provider.model.id] })
    const backend = new FileRuntimePersistenceBackend(join(this.runDir(conversationId, runId), 'runtime.json'))
    const program = buildProgram(registry.list().map((tool) => tool.name))(this.options.approvalMode ?? 'ask')
    const toolVersions = Object.fromEntries(registry.list().map((tool) => [tool.name, tool.version]))
    const runtime = await PulseRuntime.restore(backend, { sessionId: runId, maxRuntimeMs: this.options.maxRuntimeMs ?? 15 * 60_000, programs: [program], models, modelRouter: router, toolVersions, builtinHumanEffects: true, effectExecutor: async (effect, signal, observe) => { if (effect.kind === 'llm') return createModelEffectExecutor({ router, providers: new Map([[provider.adapter.id, provider.adapter]]) })(effect, signal, observe); if (effect.kind === 'tool') return createToolEffectExecutor(registry)(effect, signal, observe); throw new Error(`UNSUPPORTED_EFFECT_KIND:${effect.kind}`) }, effectSubmissionPreparer: createToolEffectSubmissionPreparer(registry), persistenceBackend: backend })
    return { runtime, registry }
  }
  private makeRunHandle(conversationId: string, runId: string, runtime: PulseRuntime, session: PulseSession): RunHandle {
    let finalized: Promise<Outcome & { text?: string }> | undefined
    const finish = (): Promise<Outcome & { text?: string }> => finalized ??= (async () => { const outcome = await session.outcome(); const text = this.resultText(runtime, outcome.resultRef); await this.appendMessage(conversationId, { id: `msg-${randomUUID()}`, role: 'assistant', text: text ?? '', runId, createdAt: new Date().toISOString() }); const current = await this.readManifest(conversationId); const artifacts = [...runtime.state.results.values()].flatMap((result) => { const value = result.value; if (!value || typeof value !== 'object' || Array.isArray(value)) return []; const record = value as Record<string, JsonValue>; if (typeof record.path !== 'string' || typeof record.hash !== 'string' || typeof record.bytes !== 'number') return []; return [{ path: record.path, hash: record.hash, bytes: record.bytes, ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}), ...(typeof record.label === 'string' ? { label: record.label } : {}), runId }] as ArtifactSummary[] }); current.artifacts = [...(current.artifacts ?? []).filter((item) => item.runId !== runId), ...artifacts]; if (current.activeRunId === runId) delete current.activeRunId; current.updatedAt = new Date().toISOString(); await writeFile(this.manifestPath(conversationId), JSON.stringify(current, null, 2)); this.active.delete(runId); this.approvedToolCalls.delete(runId); await runtime.flushPersistence(); await writeFile(join(this.runDir(conversationId, runId), 'outcome.json'), JSON.stringify({ schemaVersion: 1, ...outcome, ...(text === undefined ? {} : { text }), completedAt: new Date().toISOString() }, null, 2)); return { ...outcome, ...(text === undefined ? {} : { text }) } })().finally(async () => { await this.releaseConversationLock(conversationId) })
    const events = this.projectEvents(conversationId, runId, session, finish)
    return { id: runId, conversationId, events, outcome: finish, cancel: async (reason = 'USER_REQUESTED') => { await session.cancel(reason) }, reply: async (effectId, value) => { const effect = runtime.state.effects.get(effectId); const approved = value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, JsonValue>).approved === true; if (approved && effect?.kind === 'human' && effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input)) { const calls = (effect.input as Record<string, JsonValue>).tools; if (Array.isArray(calls)) { const approvedIds = this.approvedToolCalls.get(runId) ?? new Set<string>(); this.approvedToolCalls.set(runId, approvedIds); for (const call of calls) if (call && typeof call === 'object' && !Array.isArray(call) && typeof (call as Record<string, JsonValue>).toolCallId === 'string') approvedIds.add((call as Record<string, JsonValue>).toolCallId as string) } } await session.reply(effectId, value) } }
  }
  async sendMessage(conversationId: string, input: UserMessageInput): Promise<RunHandle> {
    if (!input.text.trim()) throw new Error('MESSAGE_REQUIRED')
    const runId = `run-${randomUUID()}`; await this.acquireConversationLock(conversationId, runId)
    try {
      const manifest = await this.readManifest(conversationId); if (manifest.activeRunId) throw new Error('CONVERSATION_BUSY')
    const previous = await readFile(this.messagesPath(conversationId), 'utf8').catch(() => '')
    const context = previous.split('\n').filter(Boolean).slice(-8).map((line) => { try { const message = JSON.parse(line) as StoredMessage; return `${message.role}: ${message.text.slice(0, 4_000)}` } catch { return '' } }).filter(Boolean).join('\n')
    const goal = context ? `Conversation context:\n${context}\n\nuser: ${input.text}` : input.text
    const now = new Date().toISOString(); await this.appendMessage(conversationId, { id: `msg-${randomUUID()}`, role: 'user', text: input.text, runId, createdAt: now }); await mkdir(this.runDir(conversationId, runId), { recursive: true }); await writeFile(join(this.runDir(conversationId, runId), 'input.json'), JSON.stringify({ schemaVersion: 1, conversationId, runId, goal: input.text, cwd: manifest.cwd, provider: this.options.provider?.provider ?? 'mock', approvalMode: this.options.approvalMode ?? 'ask', createdAt: now }, null, 2))
    const { runtime, registry } = this.runtimeFor(conversationId, runId, manifest.cwd); const program = buildProgram(registry.list().map((tool) => tool.name))(this.options.approvalMode ?? 'ask'); runtime.register(program); const { agentId } = runtime.createAgent({ goal, program }); const session = runtime.start(agentId); this.active.set(runId, { runtime, session, conversationId, runId }); manifest.activeRunId = runId; manifest.runs.push(runId); manifest.updatedAt = now; await writeFile(this.manifestPath(conversationId), JSON.stringify(manifest, null, 2))
    return this.makeRunHandle(conversationId, runId, runtime, session)
    } catch (error) { await this.releaseConversationLock(conversationId); throw error }
  }
  async resumeRun(conversationId: string): Promise<RunHandle> {
    const manifest = await this.readManifest(conversationId)
    const runId = manifest.activeRunId
    if (!runId) throw new Error('NO_ACTIVE_RUN')
    const existing = this.active.get(runId)
    if (existing) return this.makeRunHandle(conversationId, runId, existing.runtime, existing.session)
    await this.acquireConversationLock(conversationId, runId)
    try {
      const { runtime } = await this.restoreRuntimeFor(conversationId, runId, manifest.cwd)
      const agent = [...runtime.state.agents.values()][0]
      if (!agent) throw new Error('RESTORED_AGENT_NOT_FOUND')
      const session = runtime.start(agent.id)
      this.active.set(runId, { runtime, session, conversationId, runId })
      return this.makeRunHandle(conversationId, runId, runtime, session)
    } catch (error) { await this.releaseConversationLock(conversationId); throw error }
  }
  private resultText(runtime: PulseRuntime, ref: string | undefined): string | undefined { if (!ref) return undefined; const first = runtime.state.results.get(ref)?.value; if (typeof first === 'string') return first; if (!first || typeof first !== 'object' || Array.isArray(first)) return JSON.stringify(first); const firstRecord = first as Record<string, JsonValue>; const textRef = firstRecord.textRef; const value = typeof textRef === 'string' ? runtime.state.results.get(textRef)?.value : first; if (typeof value === 'string') return value; if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, JsonValue>).text === 'string') return (value as Record<string, JsonValue>).text as string; return value === undefined ? undefined : JSON.stringify(value, null, 2) }
  private async *projectEvents(conversationId: string, runId: string, session: PulseSession, finish: () => Promise<Outcome & { text?: string }>): AsyncIterable<AssistantEvent> { let seq = 0; for await (const event of session.stream()) { seq++; if (event.kind === 'observation') { const observation = event.observation as Record<string, JsonValue>; if (observation.type === 'chunk') yield { schemaVersion: 1, type: 'text', conversationId, runId, seq, data: observation.data ?? '' }; else yield { schemaVersion: 1, type: 'observation', conversationId, runId, seq, data: event.observation ?? null }; continue } if (event.kind === 'gap') { yield { schemaVersion: 1, type: 'gap', conversationId, runId, seq, data: { fromSeq: event.fromSeq ?? 0, toSeq: event.toSeq ?? 0 } }; continue } if (event.event?.type === 'human.requested') { const liveEffect = event.event.effectId === undefined ? undefined : this.active.get(runId)?.runtime.state.effects.get(event.event.effectId); if (liveEffect?.state !== 'running' || liveEffect.outcome !== undefined) continue; yield { schemaVersion: 1, type: 'waiting', conversationId, runId, seq, data: { effectId: event.event.effectId ?? null, input: event.event.data ?? null } }; continue } yield { schemaVersion: 1, type: 'fact', conversationId, runId, seq, data: event.event?.data ?? event.event?.type ?? null } } try { const outcome = await finish(); yield { schemaVersion: 1, type: 'complete', conversationId, runId, seq: seq + 1, data: { status: outcome.status } } } catch (error) { yield { schemaVersion: 1, type: 'error', conversationId, runId, seq: seq + 1, data: String(error) } } }
  async close(): Promise<void> { for (const active of this.active.values()) await active.runtime.shutdown(); this.active.clear(); this.approvedToolCalls.clear(); for (const conversationId of [...this.conversationLocks.keys()]) await this.releaseConversationLock(conversationId) }
  async doctor(options: { live?: boolean } = {}): Promise<{ ok: boolean; cwd: string; dataDir: string; node: string; tools: string[]; provider: string; errors: string[]; live?: { ok: boolean; message: string } }> {
    const errors: string[] = []
    try { await this.init() } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
    const registry = new ToolRegistry({ allowNetwork: this.options.allowNetwork === true }); registerBuiltIns(registry, this.root, this.options.approvalMode ?? 'ask', this.options.allowNetwork === true)
    let live: { ok: boolean; message: string } | undefined
    if (options.live) {
      const provider = providerFromOptions(this.options)
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        await provider.adapter.executeAttempt({ model: provider.model.id, maxOutputTokens: 8, signal: controller.signal, request: { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'pulse.doctor', instruction: 'health check', privacy: 'cloud_allowed', privacyRefs: [] }, blocks: [{ kind: 'instruction', content: 'Reply with OK.' }], prefixHash: 'doctor', projectionHash: 'doctor', builderVersion: 'doctor', policyVersion: 'doctor', toolSetVersion: 'doctor', privacy: 'cloud_allowed', privacyRefs: [] } })
        live = { ok: true, message: 'provider request succeeded' }
      } catch (error) {
        live = { ok: false, message: error instanceof Error ? error.message : String(error) }
      } finally { clearTimeout(timer) }
    }
    return { ok: errors.length === 0 && (live?.ok ?? true), cwd: this.root, dataDir: this.dataDir, node: process.version, tools: registry.list().map((tool) => tool.name), provider: this.options.provider?.provider ?? 'mock', errors, ...(live === undefined ? {} : { live }) }
  }
}

export function createLocalHost(options: LocalHostOptions = {}): LocalHost { return new LocalHost(options) }
