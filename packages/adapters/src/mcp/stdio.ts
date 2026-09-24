import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { matchesJsonSchema, type JsonValue, type ToolDefinition } from '@hunterzhu/pulse-tool-sdk'

const DEFAULT_PROTOCOL_VERSION = '2025-11-25'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024

export interface McpStdioClientOptions {
  command: string
  args?: string[]
  cwd?: string
  /** Environment passed to the MCP server. Omit to inherit the current process environment. */
  env?: NodeJS.ProcessEnv
  clientInfo?: { name: string; version: string }
  protocolVersion?: string
  timeoutMs?: number
  shutdownTimeoutMs?: number
  maxLineBytes?: number
  /** Maximum number of tools/list pages accepted from one server. */
  maxToolPages?: number
  /** Prefix applied to exported Pulse tool names to avoid collisions between servers. */
  namespace?: string
}

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; [key: string]: unknown }
export interface McpToolCallResult {
  content?: unknown[]
  structuredContent?: unknown
  isError?: boolean
  [key: string]: unknown
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP_PROTOCOL_ERROR:${label} must be an object`)
  return value as Record<string, unknown>
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }

function defaultMcpEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safeKeys = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'])
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    safeKeys.has(key.toUpperCase()) && value !== undefined && !/(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|BEARER|CREDENTIAL|COOKIE)/i.test(key) && key !== 'NODE_OPTIONS',
  ))
}

function toJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('MCP_TOOL_RESULT_NOT_JSON')
    seen.add(value)
    try { return value.map((item) => toJson(item, seen)) } finally { seen.delete(value) }
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('MCP_TOOL_RESULT_NOT_JSON')
    if (seen.has(value)) throw new Error('MCP_TOOL_RESULT_NOT_JSON')
    seen.add(value)
    try { return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJson(item, seen)])) } finally { seen.delete(value) }
  }
  throw new Error('MCP_TOOL_RESULT_NOT_JSON')
}

/**
 * Minimal MCP stdio client for the initialize lifecycle and tools capability.
 * The subprocess uses newline-delimited JSON-RPC on stdout; stderr is never parsed as protocol.
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private readonly requestIds = new WeakMap<Promise<unknown>, number>()
  private readonly remoteTools = new Map<string, McpTool>()
  private nextId = 1
  private buffer = ''
  private closed = false
  private started = false
  private readonly decoder = new StringDecoder('utf8')

  constructor(private readonly options: McpStdioClientOptions) {
    if (!options.command.trim()) throw new Error('MCP_COMMAND_REQUIRED')
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('MCP_TIMEOUT_MUST_BE_POSITIVE')
    if (options.maxLineBytes !== undefined && (!Number.isInteger(options.maxLineBytes) || options.maxLineBytes <= 0)) throw new Error('MCP_MAX_LINE_BYTES_MUST_BE_POSITIVE')
    if (options.maxToolPages !== undefined && (!Number.isInteger(options.maxToolPages) || options.maxToolPages < 1 || options.maxToolPages > 256)) throw new Error('MCP_MAX_TOOL_PAGES_MUST_BE_BETWEEN_1_AND_256')
  }

  /** Starts the child, negotiates the protocol, then discovers the remote tools. */
  async connect(): Promise<ToolDefinition<Record<string, JsonValue>, JsonValue>[]> {
    if (this.started) throw new Error('MCP_CLIENT_ALREADY_STARTED')
    this.started = true
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      // MCP servers are installed and enabled explicitly, but should not
      // silently inherit provider credentials from the Pulse process.
      env: { ...defaultMcpEnvironment(process.env), ...this.options.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    // Drain stderr so a verbose server cannot block on a full pipe; keep diagnostics out of protocol handling.
    this.child.stderr.on('data', () => undefined)
    this.child.stdout.on('end', () => {
      const tail = this.decoder.end()
      if (tail) this.buffer += tail
      if (this.buffer.trim()) this.fail(new Error('MCP_PROTOCOL_ERROR:unterminated stdout frame'))
    })
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code, signal) => this.fail(new Error(`MCP_SERVER_EXITED:${code ?? signal ?? 'unknown'}`)))

    try {
      const initializeResult = asRecord(await this.request('initialize', {
        protocolVersion: this.options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.options.clientInfo ?? { name: 'pulse', version: '0.1.0' },
      }), 'initialize result')
      if (typeof initializeResult.protocolVersion !== 'string') throw new Error('MCP_PROTOCOL_ERROR:initialize response has no protocolVersion')
      this.notify('notifications/initialized')
      await this.refreshTools()
      return this.toToolDefinitions()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** Refreshes and returns the server's complete paginated tools/list result. */
  async refreshTools(): Promise<McpTool[]> {
    this.ensureConnected()
    const found = new Map<string, McpTool>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let pageCount = 0
    const maxPages = this.options.maxToolPages ?? 32
    do {
      if (++pageCount > maxPages) throw new Error(`MCP_PROTOCOL_ERROR:tools/list exceeded ${maxPages} pages`)
      const result = asRecord(await this.request('tools/list', cursor === undefined ? {} : { cursor }), 'tools/list result')
      if (!Array.isArray(result.tools)) throw new Error('MCP_PROTOCOL_ERROR:tools/list result has no tools array')
      for (const rawTool of result.tools) {
        const tool = asRecord(rawTool, 'tool')
        if (typeof tool.name !== 'string' || !tool.name) throw new Error('MCP_PROTOCOL_ERROR:tool has no name')
        if (found.has(tool.name)) throw new Error(`MCP_PROTOCOL_ERROR:duplicate tool ${tool.name}`)
        const inputSchema = tool.inputSchema === undefined ? { type: 'object' } : asRecord(tool.inputSchema, `tool ${tool.name} inputSchema`)
        found.set(tool.name, { ...tool, name: tool.name, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), inputSchema })
      }
      const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined
      if (nextCursor !== undefined && (nextCursor === cursor || cursors.has(nextCursor))) throw new Error('MCP_PROTOCOL_ERROR:tools/list cursor repeated')
      if (cursor !== undefined) cursors.add(cursor)
      cursor = nextCursor
    } while (cursor !== undefined)
    this.remoteTools.clear()
    for (const [name, tool] of found) this.remoteTools.set(name, tool)
    return [...this.remoteTools.values()]
  }

  /** Calls one discovered remote tool and returns the JSON-compatible MCP result envelope. */
  async callTool(name: string, arguments_: Record<string, JsonValue>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonValue> {
    this.ensureConnected()
    if (!this.remoteTools.has(name)) throw new Error(`MCP_UNKNOWN_TOOL:${name}`)
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('MCP_TOOL_CALL_ABORTED')
    const request = this.request('tools/call', { name, arguments: arguments_ }, options.timeoutMs)
    let abortHandler: (() => void) | undefined
    const aborted = options.signal && new Promise<never>((_, reject) => {
      abortHandler = () => {
        this.cancelRequest(request, 'MCP_TOOL_CALL_ABORTED')
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('MCP_TOOL_CALL_ABORTED'))
      }
      options.signal?.addEventListener('abort', abortHandler, { once: true })
      if (options.signal?.aborted) abortHandler()
    })
    try {
      const result = await (aborted ? Promise.race([request, aborted]) : request)
      const record = asRecord(result, 'tools/call result')
      if (record.isError === true) throw new Error(`MCP_TOOL_ERROR:${JSON.stringify(record.content ?? record.structuredContent ?? record)}`)
      return toJson(record)
    } finally {
      if (abortHandler) options.signal?.removeEventListener('abort', abortHandler)
    }
  }

  /** Closes stdin, waits briefly for exit, then terminates a server that stays alive. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rejectPending(new Error('MCP_CLIENT_CLOSED'))
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.stdin.end()
    const timeoutMs = this.options.shutdownTimeoutMs ?? 500
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  /** Exposes the discovered tools as Pulse ToolDefinitions, preserving each remote input schema. */
  toToolDefinitions(): ToolDefinition<Record<string, JsonValue>, JsonValue>[] {
    const namespace = this.options.namespace ?? 'mcp'
    return [...this.remoteTools.values()].map((tool) => {
      const pulseName = `${namespace}.${tool.name}`
      return {
        manifest: {
          name: pulseName,
          version: 'mcp-remote',
          description: tool.description ?? `MCP tool ${tool.name}`,
          inputSchema: tool.inputSchema,
          outputSchema: {},
          concurrencyClass: 'tool',
          locks: [],
          supportsAbortSignal: true,
          sideEffectPolicy: 'external',
          retrySafety: 'unsafe',
          defaultTimeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          tags: ['mcp'],
        },
        validateInput: (input: unknown): Record<string, JsonValue> => {
          if (!matchesJsonSchema(input, tool.inputSchema)) throw new Error(`MCP_INVALID_TOOL_INPUT:${tool.name}`)
          return input as Record<string, JsonValue>
        },
        execute: async (input, context): Promise<JsonValue> => this.callTool(tool.name, input, { signal: context.signal }),
      }
    })
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return
    this.buffer += this.decoder.write(chunk)
    const maxBytes = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > maxBytes) { this.fail(new Error('MCP_FRAME_TOO_LARGE')); return }
      if (!line.trim()) continue
      this.receive(line)
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > maxBytes) this.fail(new Error('MCP_FRAME_TOO_LARGE'))
  }

  private receive(line: string): void {
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { this.fail(new Error('MCP_PROTOCOL_ERROR:invalid JSON frame')); return }
    let message: Record<string, unknown>
    try { message = asRecord(parsed, 'message') } catch (error) { this.fail(asError(error)); return }
    if (message.jsonrpc !== '2.0') { this.fail(new Error('MCP_PROTOCOL_ERROR:jsonrpc must be 2.0')); return }
    if (message.method === 'ping' && message.id !== undefined) {
      this.write({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.id === undefined) return // Server notifications are advisory for this tools-only adapter.
    if (typeof message.id !== 'number') { this.fail(new Error('MCP_PROTOCOL_ERROR:response id must be numeric')); return }
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      const error = asRecord(message.error, 'JSON-RPC error')
      pending.reject(new Error(`MCP_JSONRPC_ERROR:${String(error.code)}:${String(error.message)}`))
    } else if (!('result' in message)) pending.reject(new Error('MCP_PROTOCOL_ERROR:response has no result'))
    else pending.resolve(message.result)
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('MCP_TIMEOUT_MUST_BE_POSITIVE'))
    if (this.closed || !this.child || !this.child.stdin.writable) return Promise.reject(new Error('MCP_CLIENT_NOT_CONNECTED'))
    const id = this.nextId++
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify('notifications/cancelled', { requestId: id, reason: `Timed out after ${timeoutMs}ms` })
        reject(new Error(`MCP_REQUEST_TIMEOUT:${method}:${timeoutMs}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write(message, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
    this.requestIds.set(promise, id)
    return promise
  }

  private cancelRequest(request: Promise<unknown>, code: string): void {
    const id = this.requestIds.get(request)
    const item = id === undefined ? undefined : this.pending.get(id)
    if (id === undefined || !item) return
    clearTimeout(item.timer)
    this.pending.delete(id)
    this.notify('notifications/cancelled', { requestId: id, reason: code })
    item.reject(new Error(code))
    void request.catch(() => undefined)
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable || this.closed) return
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  private write(message: unknown, callback?: (error?: Error) => void): void {
    const child = this.child
    if (!child || !child.stdin.writable) { callback?.(new Error('MCP_CLIENT_NOT_CONNECTED')); return }
    let encoded: string
    try { encoded = `${JSON.stringify(message)}\n` } catch (error) { callback?.(asError(error)); return }
    child.stdin.write(encoded, 'utf8', (error) => callback?.(error ?? undefined))
  }

  private ensureConnected(): void {
    if (!this.started || this.closed || !this.child || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('MCP_CLIENT_NOT_CONNECTED')
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.rejectPending(error)
    this.closed = true
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, this.options.shutdownTimeoutMs ?? 500)
      forceTimer.unref()
    }
  }
}

/** Starts one MCP server and returns a client plus Pulse-compatible tool definitions. */
export async function createMcpStdioAdapter(options: McpStdioClientOptions): Promise<{ client: McpStdioClient; tools: ToolDefinition<Record<string, JsonValue>, JsonValue>[] }> {
  const client = new McpStdioClient(options)
  const tools = await client.connect()
  return { client, tools }
}

/** Creates an opaque namespace suitable for using the server name in Pulse tool names. */
export function mcpToolNamespace(serverName: string): string {
  const normalized = serverName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `mcp.${normalized || randomUUID().slice(0, 8)}`
}
