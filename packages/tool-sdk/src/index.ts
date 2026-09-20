import { z, type ZodTypeAny } from 'zod'
import { createHash } from 'node:crypto'

export const TOOL_SDK_VERSION = '0.1.0'
export type ConcurrencyClass = 'llm' | 'tool' | 'agent' | 'none'
export interface ResourceClaim { resource: string; mode: 'shared' | 'exclusive' }
export interface ToolContext {
  toolCallId: string
  effectId: string
  attemptId: string
  idempotencyKey?: string
  agentId: string
  laneId: string
  signal: AbortSignal
  emit(event: { type: 'progress' | 'warning' | 'diagnostic'; data: JsonValue }): void
}
export interface ReconcileContext { toolCallId: string; effectId: string; attemptId: string; agentId: string; laneId: string; signal: AbortSignal }
export interface ReconcileResult<TOutput> { status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: TOutput; error?: { code: string; message: string; retryable?: boolean; details?: JsonValue } }
export interface ToolManifest {
  name: string
  version: string
  description: string
  tags?: string[]
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  concurrencyClass: ConcurrencyClass
  locks: ResourceClaim[]
  resources?: ResourceClaim[]
  supportsAbortSignal: boolean
  sideEffectPolicy: 'none' | 'read' | 'write'
  retrySafety: 'read_only' | 'idempotent' | 'unsafe'
  defaultTimeoutMs: number
  maxResultSummaryBytes?: number
}
export interface ToolDiscoveryQuery { text?: string; tags?: string[]; sideEffectPolicy?: ToolManifest['sideEffectPolicy']; concurrencyClass?: ConcurrencyClass; limit?: number }
export interface ToolDiscoveryResult { manifest: ToolManifest; score: number }
export interface ToolSetSnapshot { id: string; version: string; tools: ToolManifest[] }
export interface ToolRegistryPolicy { allow?: string[]; deny?: string[] }
export interface ToolAdmission { locks: ResourceClaim[]; sideEffectPolicy: ToolManifest['sideEffectPolicy']; defaultTimeoutMs: number; retrySafety: ToolManifest['retrySafety']; version: string }
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  manifest: ToolManifest
  resourceAdmissionMode?: 'explicit' | 'default'
  validateInput?(input: unknown): TInput
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput
  executionRef?(input: TInput, context: ToolContext): JsonValue
  resolveResources?(input: TInput): ResourceClaim[]
  reconcile?(executionRef: JsonValue, context: ReconcileContext): Promise<ReconcileResult<TOutput>>
  normalize?(output: TOutput): JsonValue
  summarize?(output: TOutput): JsonValue
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export class ToolError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details: JsonValue | undefined

  constructor(code: string, message: string, options: { retryable?: boolean; details?: JsonValue } = {}) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.retryable = options.retryable ?? true
    this.details = options.details
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<any, any>>()
  private readonly policy: { allow?: ReadonlySet<string>; deny: ReadonlySet<string> }
  constructor(policy: ToolRegistryPolicy = {}) {
    this.policy = { ...(policy.allow === undefined ? {} : { allow: new Set(policy.allow) }), deny: new Set(policy.deny ?? []) }
  }
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (!definition.manifest.name || this.definitions.has(definition.manifest.name)) throw new Error(`TOOL_ALREADY_REGISTERED:${definition.manifest.name}`)
    if (!definition.manifest.version || !Number.isFinite(definition.manifest.defaultTimeoutMs) || definition.manifest.defaultTimeoutMs < 0) throw new Error(`INVALID_TOOL_MANIFEST:${definition.manifest.name}`)
    if (!definition.manifest.supportsAbortSignal) throw new Error(`TOOL_ABORT_SIGNAL_REQUIRED:${definition.manifest.name}`)
    this.definitions.set(definition.manifest.name, definition)
  }
  get(name: string): ToolDefinition<any, any> | undefined { return this.isAllowed(name) ? this.definitions.get(name) : undefined }
  validateInput(name: string, input: unknown): unknown {
    const definition = this.require(name)
    try { return definition.validateInput ? definition.validateInput(input) : input }
    catch { throw new ToolError('INVALID_TOOL_INPUT', `Input does not match the manifest for tool ${name}.`, { retryable: false }) }
  }
  isAllowed(name: string): boolean { return this.policy.deny.has(name) === false && (this.policy.allow === undefined || this.policy.allow.has(name)) }
  list(): ToolManifest[] { return [...this.definitions.values()].filter((definition) => this.isAllowed(definition.manifest.name)).map((definition) => structuredClone(definition.manifest)) }
  discover(query: ToolDiscoveryQuery = {}): ToolDiscoveryResult[] {
    const terms = (query.text ?? '').toLocaleLowerCase().split(/[^a-z0-9_:-]+/).filter(Boolean)
    const requestedTags = new Set((query.tags ?? []).map((tag) => tag.toLocaleLowerCase()))
    const results = this.list().flatMap((manifest) => {
      if (query.sideEffectPolicy !== undefined && manifest.sideEffectPolicy !== query.sideEffectPolicy) return []
      if (query.concurrencyClass !== undefined && manifest.concurrencyClass !== query.concurrencyClass) return []
      const tags = (manifest.tags ?? []).map((tag) => tag.toLocaleLowerCase())
      if ([...requestedTags].some((tag) => !tags.includes(tag))) return []
      const haystack = [manifest.name, manifest.description, ...tags].join(' ').toLocaleLowerCase()
      const score = terms.length === 0 ? 1 + requestedTags.size * 2 : terms.reduce((total, term) => total + (manifest.name.toLocaleLowerCase() === term ? 10 : manifest.name.toLocaleLowerCase().includes(term) ? 5 : haystack.includes(term) ? 1 : 0), requestedTags.size * 2)
      return score > 0 ? [{ manifest, score }] : []
    })
    results.sort((left, right) => right.score - left.score || left.manifest.name.localeCompare(right.manifest.name) || left.manifest.version.localeCompare(right.manifest.version))
    return query.limit === undefined ? results : results.slice(0, Math.max(0, query.limit))
  }
  compileToolSet(id: string, query: ToolDiscoveryQuery = {}, version?: string): ToolSetSnapshot {
    if (!id) throw new Error('INVALID_TOOL_SET_ID')
    const tools = this.discover(query).map((result) => result.manifest)
    const derivedVersion = createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16)
    return { id, version: version ?? derivedVersion, tools: structuredClone(tools) }
  }
  async execute(name: string, input: unknown, context: ToolContext | AbortSignal): Promise<unknown> {
    const definition = this.require(name)
    const toolContext: ToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    return definition.execute(input, toolContext)
  }
  async executeDetailed(name: string, input: unknown, context: ToolContext | AbortSignal): Promise<{ output: unknown; normalized?: JsonValue; summary?: JsonValue; manifest: ToolManifest }> {
    const definition = this.require(name)
    const toolContext: ToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    const output = await definition.execute(input, toolContext)
    const summary = definition.summarize?.(output)
    if (summary !== undefined && Buffer.byteLength(JSON.stringify(summary), 'utf8') > (definition.manifest.maxResultSummaryBytes ?? 4096)) throw new Error('TOOL_SUMMARY_TOO_LARGE')
    const normalized = definition.normalize?.(output)
    return { output, ...(normalized === undefined ? {} : { normalized }), ...(summary === undefined ? {} : { summary }), manifest: structuredClone(definition.manifest) }
  }
  async reconcileDetailed(name: string, executionRef: JsonValue, context: ReconcileContext): Promise<ReconcileResult<unknown>> {
    const definition = this.require(name)
    if (!definition.reconcile) throw new Error(`TOOL_NOT_RECOVERABLE:${name}`)
    return definition.reconcile(executionRef, context)
  }
  executionRef(name: string, input: unknown, context: ToolContext): JsonValue | undefined {
    const definition = this.require(name)
    if (!definition.executionRef) return undefined
    return definition.executionRef(input, context)
  }
  resolveResources(name: string, input: unknown): ResourceClaim[] {
    const definition = this.require(name)
    if (definition.resolveResources) return definition.resolveResources(input)
    if (definition.manifest.resources !== undefined) return definition.manifest.resources
    if (definition.manifest.locks.length > 0 || definition.resourceAdmissionMode === 'explicit') return definition.manifest.locks
    if (definition.manifest.sideEffectPolicy === 'write') return [{ resource: 'workspace', mode: 'exclusive' }]
    if (definition.manifest.sideEffectPolicy === 'read') return [{ resource: 'workspace', mode: 'shared' }]
    return []
  }
  admission(name: string, input: unknown): ToolAdmission { const definition = this.require(name); const parsedInput = this.validateInput(name, input); return { locks: structuredClone(this.resolveResources(name, parsedInput)), sideEffectPolicy: definition.manifest.sideEffectPolicy, defaultTimeoutMs: definition.manifest.defaultTimeoutMs, retrySafety: definition.manifest.retrySafety, version: definition.manifest.version } }
  private require(name: string): ToolDefinition<any, any> {
    if (!this.isAllowed(name)) throw new Error(`TOOL_NOT_ALLOWED:${name}`)
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    return definition
  }
}

function schemaToJsonSchema(schema: ZodTypeAny, seen = new Set<ZodTypeAny>()): Record<string, unknown> {
  if (seen.has(schema)) throw new Error('UNSUPPORTED_SCHEMA_TYPE:recursive')
  const nextSeen = new Set(seen).add(schema)
  const definition = schema._def as Record<string, any>
  const typeName = definition.typeName as string
  if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = typeof definition.shape === 'function' ? definition.shape() : definition.shape
    if (!shape || typeof shape !== 'object') throw new Error('INVALID_SCHEMA_DEFINITION:object')
    const entries = Object.entries(shape as Record<string, ZodTypeAny>)
    const required = entries.filter(([, value]) => !(value as ZodTypeAny).isOptional()).map(([key]) => key)
    return {
      type: 'object',
      properties: Object.fromEntries(entries.map(([key, value]) => [key, schemaToJsonSchema(value, nextSeen)])),
      ...(required.length ? { required } : {}),
      ...(definition.unknownKeys === 'strict' ? { additionalProperties: false } : {}),
    }
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodArray) return { type: 'array', items: schemaToJsonSchema(definition.type, nextSeen), ...(arrayChecks(definition.checks) ?? {}) }
  if (typeName === z.ZodFirstPartyTypeKind.ZodString) return { type: 'string', ...(stringChecks(definition.checks) ?? {}) }
  if (typeName === z.ZodFirstPartyTypeKind.ZodNumber) return { type: definition.isInt ? 'integer' : 'number', ...(numberChecks(definition.checks) ?? {}) }
  if (typeName === z.ZodFirstPartyTypeKind.ZodBoolean) return { type: 'boolean' }
  if (typeName === z.ZodFirstPartyTypeKind.ZodNull) return { type: 'null' }
  if (typeName === z.ZodFirstPartyTypeKind.ZodOptional || typeName === z.ZodFirstPartyTypeKind.ZodDefault) return schemaToJsonSchema(definition.innerType, nextSeen)
  if (typeName === z.ZodFirstPartyTypeKind.ZodNullable) return { anyOf: [schemaToJsonSchema(definition.innerType, nextSeen), { type: 'null' }] }
  if (typeName === z.ZodFirstPartyTypeKind.ZodEnum) return { type: 'string', enum: [...definition.values] }
  if (typeName === z.ZodFirstPartyTypeKind.ZodNativeEnum) return { enum: Object.values(definition.values).filter((value) => typeof value === 'string' || typeof value === 'number') }
  if (typeName === z.ZodFirstPartyTypeKind.ZodLiteral) return { const: definition.value }
  if (typeName === z.ZodFirstPartyTypeKind.ZodUnion || typeName === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
    const options = typeName === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion ? [...definition.options.values()] : definition.options
    if (!Array.isArray(options) || options.length === 0) throw new Error('INVALID_SCHEMA_DEFINITION:union')
    return { anyOf: options.map((option: ZodTypeAny) => schemaToJsonSchema(option, nextSeen)) }
  }
  throw new Error(`UNSUPPORTED_SCHEMA_TYPE:${typeName ?? 'unknown'}`)
}

function stringChecks(checks: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(checks)) return undefined
  const result: Record<string, unknown> = {}
  for (const check of checks as Array<Record<string, unknown>>) {
    if (check.kind === 'min') result.minLength = check.value
    else if (check.kind === 'max') result.maxLength = check.value
    else if (check.kind === 'length') { result.minLength = check.value; result.maxLength = check.value }
    else if (check.kind === 'regex' && check.regex instanceof RegExp) result.pattern = check.regex.source
  }
  return Object.keys(result).length ? result : undefined
}

function numberChecks(checks: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(checks)) return undefined
  const result: Record<string, unknown> = {}
  for (const check of checks as Array<Record<string, unknown>>) {
    if (check.kind === 'min') result[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value
    else if (check.kind === 'max') result[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value
    else if (check.kind === 'int') result.type = 'integer'
  }
  return Object.keys(result).length ? result : undefined
}

function arrayChecks(checks: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(checks)) return undefined
  const result: Record<string, unknown> = {}
  for (const check of checks as Array<Record<string, unknown>>) {
    if (check.kind === 'min') result.minItems = check.value
    else if (check.kind === 'max') result.maxItems = check.value
    else if (check.kind === 'length') { result.minItems = check.value; result.maxItems = check.value }
  }
  return Object.keys(result).length ? result : undefined
}

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> { return schemaToJsonSchema(schema) }

export function defineTool<TInput, TOutput>(config: {
  name: string
  version?: string
  description: string
  tags?: string[]
  input: z.ZodType<TInput>
  output: z.ZodType<TOutput>
  concurrencyClass?: ConcurrencyClass
  locks?: ResourceClaim[]
  resources?: ResourceClaim[]
  supportsAbortSignal?: boolean
  sideEffectPolicy?: ToolManifest['sideEffectPolicy']
  retrySafety?: ToolManifest['retrySafety']
  defaultTimeoutMs?: number
  maxResultSummaryBytes?: number
  resolveResources?: (input: TInput) => ResourceClaim[]
  reconcile?: (executionRef: JsonValue, context: ReconcileContext) => Promise<ReconcileResult<TOutput>>
  normalize?: (output: TOutput) => JsonValue
  summarize?: (output: TOutput) => JsonValue
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput
  executionRef?: (input: TInput, context: ToolContext) => JsonValue
}): ToolDefinition<TInput, TOutput> {
  const manifest: ToolManifest = { name: config.name, version: config.version ?? '1', description: config.description, ...(config.tags === undefined ? {} : { tags: [...new Set(config.tags)] }), inputSchema: zodToJsonSchema(config.input), outputSchema: zodToJsonSchema(config.output), concurrencyClass: config.concurrencyClass ?? 'tool', locks: config.locks ?? [], ...(config.resources === undefined ? {} : { resources: config.resources }), supportsAbortSignal: config.supportsAbortSignal ?? true, sideEffectPolicy: config.sideEffectPolicy ?? 'none', retrySafety: config.retrySafety ?? (config.sideEffectPolicy === 'write' ? 'unsafe' : 'read_only'), defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000, ...(config.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: config.maxResultSummaryBytes }) }
  return { manifest, resourceAdmissionMode: config.resolveResources !== undefined || config.resources !== undefined || config.locks !== undefined ? 'explicit' : 'default', validateInput: (input: unknown) => config.input.parse(input), execute: async (input, context) => config.output.parse(await config.execute(config.input.parse(input), context)), ...(config.executionRef === undefined ? {} : { executionRef: (input: TInput, context: ToolContext) => config.executionRef!(config.input.parse(input), context) }), ...(config.resolveResources === undefined ? {} : { resolveResources: (input: TInput) => config.resolveResources!(config.input.parse(input)) }), ...(config.reconcile === undefined ? {} : { reconcile: async (executionRef: JsonValue, context: ReconcileContext) => { const result = await config.reconcile!(executionRef, context); return result.status === 'succeeded' && result.output !== undefined ? { ...result, output: config.output.parse(result.output) } : result } }), ...(config.normalize === undefined ? {} : { normalize: config.normalize }), ...(config.summarize === undefined ? {} : { summarize: (output: TOutput) => config.summarize!(output) }) }
}
