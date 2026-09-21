import { z, type ZodTypeAny } from 'zod'
import { createHash } from 'node:crypto'
import { normalize } from 'node:path'
import { matchesJsonSchema } from './schema.js'

export { matchesJsonSchema } from './schema.js'

function normalizeWorkspaceRoot(root: string): string { if (root === '*') return root; const value = normalize(root); return value.length > 1 ? value.replace(/\/$/, '') : value }
function normalizeNetworkHost(host: string): string { return host.toLocaleLowerCase().replace(/\.$/, '') }

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
export interface ToolPermissions { workspaceRoots?: string[]; networkHosts?: string[] }
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
  sideEffectPolicy: 'none' | 'read' | 'write' | 'external'
  retrySafety: 'read_only' | 'idempotent' | 'unsafe'
  defaultTimeoutMs: number
  maxResultSummaryBytes?: number
  permissions?: ToolPermissions
}
export interface ToolDiscoveryQuery { text?: string; tags?: string[]; sideEffectPolicy?: ToolManifest['sideEffectPolicy']; concurrencyClass?: ConcurrencyClass; limit?: number }
export interface ToolDiscoveryResult { manifest: ToolManifest; score: number }
export interface ToolSetSnapshot { id: string; version: string; tools: ToolManifest[] }
export interface ToolRegistryPolicy { allow?: string[]; deny?: string[]; workspaceRoots?: string[]; networkHosts?: string[]; allowNetwork?: boolean }
export interface ToolAdmission { locks: ResourceClaim[]; sideEffectPolicy: ToolManifest['sideEffectPolicy']; defaultTimeoutMs: number; retrySafety: ToolManifest['retrySafety']; version: string }

function isJsonSchema(value: unknown): boolean {
  const seen = new Set<object>()
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const schema = candidate as Record<string, unknown>
    if (seen.has(schema)) return false
    seen.add(schema)
    try {
      if (schema.type !== undefined && (typeof schema.type !== 'string' || !['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'].includes(schema.type))) return false
      for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined && (!Array.isArray(schema[key]) || schema[key].length === 0 || !schema[key].every(visit))) return false
      if (schema.not !== undefined && !visit(schema.not)) return false
      if (schema.items !== undefined && !visit(schema.items)) return false
      if (schema.properties !== undefined && (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || !Object.values(schema.properties as Record<string, unknown>).every(visit))) return false
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !visit(schema.additionalProperties)) return false
      if (schema.required !== undefined && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length || schema.required.some((key) => typeof key !== 'string'))) return false
      if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false
      if (schema.pattern !== undefined) { if (typeof schema.pattern !== 'string') return false; try { new RegExp(schema.pattern) } catch { return false } }
      for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) return false
      for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || (schema[key] as number) < 0)) return false
      if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') return false
      return true
    } finally { seen.delete(schema) }
  }
  return visit(value)
}
function isResourceClaims(value: unknown): value is ResourceClaim[] {
  if (!Array.isArray(value)) return false
  return value.every((claim) => {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) return false
    const record = claim as Record<string, unknown>
    return typeof record.resource === 'string' && record.resource.length > 0 && (record.mode === 'shared' || record.mode === 'exclusive')
  })
}
function isPermissions(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const permissions = value as Record<string, unknown>
  return (permissions.workspaceRoots === undefined || (Array.isArray(permissions.workspaceRoots) && permissions.workspaceRoots.every((root) => typeof root === 'string' && root.length > 0))) && (permissions.networkHosts === undefined || (Array.isArray(permissions.networkHosts) && permissions.networkHosts.every((host) => typeof host === 'string' && host.length > 0)))
}
function isManifestContract(manifest: Record<string, unknown>): boolean {
  return typeof manifest.description === 'string' && isJsonSchema(manifest.inputSchema) && isJsonSchema(manifest.outputSchema) && ['llm', 'tool', 'agent', 'none'].includes(String(manifest.concurrencyClass)) && ['none', 'read', 'write', 'external'].includes(String(manifest.sideEffectPolicy)) && ['read_only', 'idempotent', 'unsafe'].includes(String(manifest.retrySafety)) && isResourceClaims(manifest.locks) && (manifest.resources === undefined || isResourceClaims(manifest.resources)) && (manifest.tags === undefined || (Array.isArray(manifest.tags) && manifest.tags.every((tag) => typeof tag === 'string' && tag.length > 0))) && (manifest.maxResultSummaryBytes === undefined || (Number.isInteger(manifest.maxResultSummaryBytes) && (manifest.maxResultSummaryBytes as number) >= 0)) && isPermissions(manifest.permissions)
}
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
  private readonly policy: { allow?: ReadonlySet<string>; deny: ReadonlySet<string>; workspaceRoots?: ReadonlySet<string>; networkHosts?: ReadonlySet<string>; allowNetwork: boolean }
  constructor(policy: ToolRegistryPolicy = {}) {
    this.policy = { ...(policy.allow === undefined ? {} : { allow: new Set(policy.allow) }), deny: new Set(policy.deny ?? []), ...(policy.workspaceRoots === undefined ? {} : { workspaceRoots: new Set(policy.workspaceRoots.map(normalizeWorkspaceRoot)) }), ...(policy.networkHosts === undefined ? {} : { networkHosts: new Set(policy.networkHosts.map(normalizeNetworkHost)) }), allowNetwork: policy.allowNetwork ?? true }
  }
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    const manifest = definition?.manifest as unknown as Record<string, unknown> | undefined
    const name = typeof manifest?.name === 'string' ? manifest.name : ''
    if (!manifest?.name || this.definitions.has(name)) throw new Error(`TOOL_ALREADY_REGISTERED:${name}`)
    if (typeof manifest.version !== 'string' || !manifest.version || typeof manifest.defaultTimeoutMs !== 'number' || !Number.isFinite(manifest.defaultTimeoutMs) || manifest.defaultTimeoutMs < 0 || !isManifestContract(manifest)) throw new Error(`INVALID_TOOL_MANIFEST:${name}`)
    if (!definition.manifest.supportsAbortSignal) throw new Error(`TOOL_ABORT_SIGNAL_REQUIRED:${definition.manifest.name}`)
    this.definitions.set(definition.manifest.name, definition)
  }
  get(name: string): ToolDefinition<any, any> | undefined { return this.isAllowed(name) ? this.definitions.get(name) : undefined }
  validateInput(name: string, input: unknown): unknown {
    const definition = this.require(name)
    try {
      const parsed = definition.validateInput ? definition.validateInput(input) : input
      if (!definition.validateInput && !matchesJsonSchema(parsed, definition.manifest.inputSchema)) throw new Error('schema mismatch')
      return parsed
    }
    catch { throw new ToolError('INVALID_TOOL_INPUT', `Input does not match the manifest for tool ${name}.`, { retryable: false }) }
  }
  isAllowed(name: string): boolean {
    const definition = this.definitions.get(name)
    return this.policy.deny.has(name) === false && (this.policy.allow === undefined || this.policy.allow.has(name)) && (definition === undefined || this.permissionsAllowed(definition.manifest))
  }
  permissionReasons(name: string): string[] {
    const definition = this.definitions.get(name)
    if (!definition) return ['UNKNOWN_TOOL']
    const permissions = definition.manifest.permissions
    if (!permissions) return []
    const reasons: string[] = []
    if (!this.policy.allowNetwork && (permissions.networkHosts?.length ?? 0) > 0) reasons.push('NETWORK_DISABLED')
    if (this.policy.networkHosts !== undefined) for (const rawHost of permissions.networkHosts ?? []) { const host = normalizeNetworkHost(rawHost); if (!this.policy.networkHosts.has('*') && !this.policy.networkHosts.has(host)) reasons.push(`NETWORK_HOST_NOT_ALLOWED:${rawHost}`) }
    if (this.policy.workspaceRoots !== undefined) for (const rawRoot of permissions.workspaceRoots ?? []) { const root = normalizeWorkspaceRoot(rawRoot); if (![...this.policy.workspaceRoots].some((allowed) => allowed === '*' || root === allowed || root.startsWith(`${allowed}/`))) reasons.push(`WORKSPACE_ROOT_NOT_ALLOWED:${rawRoot}`) }
    return reasons
  }
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
    const parsedInput = this.validateInput(name, input)
    const toolContext: ToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    const output = await definition.execute(parsedInput, toolContext)
    if (!matchesJsonSchema(output, definition.manifest.outputSchema)) throw new ToolError('TOOL_OUTPUT_SCHEMA_VIOLATION', `Output does not match the manifest for tool ${name}.`, { retryable: false })
    return output
  }
  async executeDetailed(name: string, input: unknown, context: ToolContext | AbortSignal): Promise<{ output: unknown; normalized?: JsonValue; summary?: JsonValue; manifest: ToolManifest }> {
    const definition = this.require(name)
    const parsedInput = this.validateInput(name, input)
    const toolContext: ToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    const output = await definition.execute(parsedInput, toolContext)
    if (!matchesJsonSchema(output, definition.manifest.outputSchema)) throw new ToolError('TOOL_OUTPUT_SCHEMA_VIOLATION', `Output does not match the manifest for tool ${name}.`, { retryable: false })
    const summary = definition.summarize?.(output)
    const summaryAllowed = summary === undefined || Buffer.byteLength(JSON.stringify(summary), 'utf8') <= (definition.manifest.maxResultSummaryBytes ?? 4096)
    const normalized = definition.normalize?.(output)
    return { output, ...(normalized === undefined ? {} : { normalized }), ...(summaryAllowed && summary !== undefined ? { summary } : {}), manifest: structuredClone(definition.manifest) }
  }
  async reconcileDetailed(name: string, executionRef: JsonValue, context: ReconcileContext): Promise<ReconcileResult<unknown>> {
    const definition = this.require(name)
    if (!definition.reconcile) throw new Error(`TOOL_NOT_RECOVERABLE:${name}`)
    const result = await definition.reconcile(executionRef, context)
    if (!result || typeof result !== 'object' || !['succeeded', 'failed', 'cancelled', 'unknown'].includes(result.status)) throw new ToolError('TOOL_RECONCILE_RESULT_INVALID', `Reconcile returned an invalid result for tool ${name}.`, { retryable: false })
    if (result.status === 'succeeded' && !matchesJsonSchema(result.output, definition.manifest.outputSchema)) throw new ToolError('TOOL_RECONCILE_OUTPUT_SCHEMA_VIOLATION', `Reconcile output does not match the manifest for tool ${name}.`, { retryable: false })
    if (result.error !== undefined && (typeof result.error !== 'object' || result.error === null || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')) throw new ToolError('TOOL_RECONCILE_ERROR_INVALID', `Reconcile returned an invalid error for tool ${name}.`, { retryable: false })
    return result
  }
  executionRef(name: string, input: unknown, context: ToolContext): JsonValue | undefined {
    const definition = this.require(name)
    if (!definition.executionRef) return undefined
    return definition.executionRef(this.validateInput(name, input), context)
  }
  resolveResources(name: string, input: unknown): ResourceClaim[] {
    const definition = this.require(name)
    if (definition.resolveResources) return definition.resolveResources(input)
    if (definition.manifest.resources !== undefined) return definition.manifest.resources
    if (definition.manifest.locks.length > 0 || definition.resourceAdmissionMode === 'explicit') return definition.manifest.locks
    if (definition.manifest.sideEffectPolicy === 'write') return [{ resource: 'workspace', mode: 'exclusive' }]
    if (definition.manifest.sideEffectPolicy === 'read') return [{ resource: 'workspace', mode: 'shared' }]
    if (definition.manifest.sideEffectPolicy === 'external') return [{ resource: `external:${name}`, mode: 'exclusive' }]
    return []
  }
  admission(name: string, input: unknown): ToolAdmission { const definition = this.require(name); const parsedInput = this.validateInput(name, input); return { locks: structuredClone(this.resolveResources(name, parsedInput)), sideEffectPolicy: definition.manifest.sideEffectPolicy, defaultTimeoutMs: definition.manifest.defaultTimeoutMs, retrySafety: definition.manifest.retrySafety, version: definition.manifest.version } }
  private require(name: string): ToolDefinition<any, any> {
    if (!this.isAllowed(name)) throw new Error(`TOOL_NOT_ALLOWED:${name}`)
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    return definition
  }
  private permissionsAllowed(manifest: ToolManifest): boolean { return this.permissionReasons(manifest.name).length === 0 }
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
  permissions?: ToolPermissions
  resolveResources?: (input: TInput) => ResourceClaim[]
  reconcile?: (executionRef: JsonValue, context: ReconcileContext) => Promise<ReconcileResult<TOutput>>
  normalize?: (output: TOutput) => JsonValue
  summarize?: (output: TOutput) => JsonValue
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput
  executionRef?: (input: TInput, context: ToolContext) => JsonValue
}): ToolDefinition<TInput, TOutput> {
  const manifest: ToolManifest = { name: config.name, version: config.version ?? '1', description: config.description, ...(config.tags === undefined ? {} : { tags: [...new Set(config.tags)] }), inputSchema: zodToJsonSchema(config.input), outputSchema: zodToJsonSchema(config.output), concurrencyClass: config.concurrencyClass ?? 'tool', locks: config.locks ?? [], ...(config.resources === undefined ? {} : { resources: config.resources }), supportsAbortSignal: config.supportsAbortSignal ?? true, sideEffectPolicy: config.sideEffectPolicy ?? 'none', retrySafety: config.retrySafety ?? (config.sideEffectPolicy === 'write' || config.sideEffectPolicy === 'external' ? 'unsafe' : 'read_only'), defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000, ...(config.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: config.maxResultSummaryBytes }), ...(config.permissions === undefined ? {} : { permissions: structuredClone(config.permissions) }) }
  return { manifest, resourceAdmissionMode: config.resolveResources !== undefined || config.resources !== undefined || config.locks !== undefined ? 'explicit' : 'default', validateInput: (input: unknown) => config.input.parse(input), execute: async (input, context) => config.output.parse(await config.execute(config.input.parse(input), context)), ...(config.executionRef === undefined ? {} : { executionRef: (input: TInput, context: ToolContext) => config.executionRef!(config.input.parse(input), context) }), ...(config.resolveResources === undefined ? {} : { resolveResources: (input: TInput) => config.resolveResources!(config.input.parse(input)) }), ...(config.reconcile === undefined ? {} : { reconcile: async (executionRef: JsonValue, context: ReconcileContext) => { const result = await config.reconcile!(executionRef, context); return result.status === 'succeeded' && result.output !== undefined ? { ...result, output: config.output.parse(result.output) } : result } }), ...(config.normalize === undefined ? {} : { normalize: config.normalize }), ...(config.summarize === undefined ? {} : { summarize: (output: TOutput) => config.summarize!(output) }) }
}
