import { createHash } from 'node:crypto'
import { normalize } from 'node:path'
import { validateJsonSchema } from '../models/router.js'
import type { JsonValue, ResourceLockSpec, SideEffectPolicy } from '../core/types.js'

function normalizeWorkspaceRoot(root: string): string { if (root === '*') return root; const value = normalize(root); return value.length > 1 ? value.replace(/\/$/, '') : value }
function normalizeNetworkHost(host: string): string { return host.toLocaleLowerCase().replace(/\.$/, '') }

export interface RuntimeToolPermissions { workspaceRoots?: string[]; networkHosts?: string[] }
export interface RuntimeToolManifest {
  name: string
  version: string
  description: string
  tags?: string[]
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  concurrencyClass: 'llm' | 'tool' | 'agent' | 'none'
  locks: ResourceLockSpec[]
  resources?: ResourceLockSpec[]
  supportsAbortSignal: boolean
  sideEffectPolicy: SideEffectPolicy
  retrySafety: 'read_only' | 'idempotent' | 'unsafe'
  defaultTimeoutMs: number
  maxResultSummaryBytes?: number
  permissions?: RuntimeToolPermissions
}

export interface RuntimeToolContext {
  toolCallId: string
  effectId: string
  attemptId: string
  idempotencyKey?: string
  agentId: string
  laneId: string
  signal: AbortSignal
  emit(event: { type: 'progress' | 'warning' | 'diagnostic'; data: JsonValue }): void
}

export interface RuntimeReconcileContext { toolCallId: string; effectId: string; attemptId: string; agentId: string; laneId: string; signal: AbortSignal }
export interface RuntimeReconcileResult { status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: unknown; error?: { code: string; message: string; retryable?: boolean; details?: JsonValue } }
export interface RuntimeToolDefinition {
  manifest: RuntimeToolManifest
  resourceAdmissionMode?: 'explicit' | 'default'
  validateInput?(input: unknown): unknown
  execute(input: unknown, context: RuntimeToolContext): Promise<unknown> | unknown
  executionRef?(input: unknown, context: RuntimeToolContext): JsonValue
  resolveResources?(input: unknown): ResourceLockSpec[]
  reconcile?(executionRef: JsonValue, context: RuntimeReconcileContext): Promise<RuntimeReconcileResult>
  normalize?(output: unknown): JsonValue
  summarize?(output: unknown): JsonValue
}

export interface RuntimeToolDiscoveryQuery { text?: string; tags?: string[]; sideEffectPolicy?: RuntimeToolManifest['sideEffectPolicy']; concurrencyClass?: RuntimeToolManifest['concurrencyClass']; limit?: number }
export interface RuntimeToolDiscoveryResult { manifest: RuntimeToolManifest; score: number }
export interface RuntimeToolSetSnapshot { id: string; version: string; tools: RuntimeToolManifest[] }
export interface RuntimeToolRegistryPolicy { allow?: string[]; deny?: string[]; workspaceRoots?: string[]; networkHosts?: string[]; allowNetwork?: boolean }
export interface RuntimeToolAdmission { locks: ResourceLockSpec[]; sideEffectPolicy: RuntimeToolManifest['sideEffectPolicy']; defaultTimeoutMs: number; retrySafety: RuntimeToolManifest['retrySafety']; version: string }

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
function isResourceLocks(value: unknown): value is ResourceLockSpec[] {
  if (!Array.isArray(value)) return false
  return value.every((lock) => {
    if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return false
    const record = lock as Record<string, unknown>
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
  return typeof manifest.description === 'string' && isJsonSchema(manifest.inputSchema) && isJsonSchema(manifest.outputSchema) && ['llm', 'tool', 'agent', 'none'].includes(String(manifest.concurrencyClass)) && ['none', 'read', 'write', 'external'].includes(String(manifest.sideEffectPolicy)) && ['read_only', 'idempotent', 'unsafe'].includes(String(manifest.retrySafety)) && isResourceLocks(manifest.locks) && (manifest.resources === undefined || isResourceLocks(manifest.resources)) && (manifest.tags === undefined || (Array.isArray(manifest.tags) && manifest.tags.every((tag) => typeof tag === 'string' && tag.length > 0))) && (manifest.maxResultSummaryBytes === undefined || (Number.isInteger(manifest.maxResultSummaryBytes) && (manifest.maxResultSummaryBytes as number) >= 0)) && isPermissions(manifest.permissions)
}
function summaryWithinBudget(value: unknown, maxBytes: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes } catch { return false }
}
function validateDiscoveryQuery(query: unknown): asserts query is RuntimeToolDiscoveryQuery {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw Object.assign(new Error('Invalid tool discovery query.'), { code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false })
  const value = query as Record<string, unknown>
  if (value.text !== undefined && typeof value.text !== 'string') throw Object.assign(new Error('Invalid tool discovery query text.'), { code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false })
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string'))) throw Object.assign(new Error('Invalid tool discovery query tags.'), { code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false })
  if (value.sideEffectPolicy !== undefined && !['none', 'read', 'write', 'external'].includes(String(value.sideEffectPolicy))) throw Object.assign(new Error('Invalid tool discovery side-effect policy.'), { code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false })
  if (value.concurrencyClass !== undefined && !['llm', 'tool', 'agent', 'none'].includes(String(value.concurrencyClass))) throw Object.assign(new Error('Invalid tool discovery concurrency class.'), { code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false })
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 0)) throw Object.assign(new Error('Invalid tool discovery limit.'), { code: 'INVALID_TOOL_DISCOVERY_QUERY', retryable: false })
}

/**
 * Core tool catalog used by PulseRuntime. Tool SDK definitions are structurally
 * compatible, so an application may register them directly and still choose a
 * separate executor or adapter.
 */
export class RuntimeToolRegistry {
  private readonly definitions = new Map<string, RuntimeToolDefinition>()
  private readonly policy: { allow?: ReadonlySet<string>; deny: ReadonlySet<string>; workspaceRoots?: ReadonlySet<string>; networkHosts?: ReadonlySet<string>; allowNetwork: boolean }

  constructor(policy: RuntimeToolRegistryPolicy = {}) {
    this.policy = { ...(policy.allow === undefined ? {} : { allow: new Set(policy.allow) }), deny: new Set(policy.deny ?? []), ...(policy.workspaceRoots === undefined ? {} : { workspaceRoots: new Set(policy.workspaceRoots.map(normalizeWorkspaceRoot)) }), ...(policy.networkHosts === undefined ? {} : { networkHosts: new Set(policy.networkHosts.map(normalizeNetworkHost)) }), allowNetwork: policy.allowNetwork ?? true }
  }

  register(definition: RuntimeToolDefinition | unknown): void {
    const candidate = definition as RuntimeToolDefinition
    const manifest = candidate?.manifest as unknown as Record<string, unknown> | undefined
    const name = typeof manifest?.name === 'string' ? manifest.name : ''
    if (!manifest || typeof manifest.name !== 'string' || !name || this.definitions.has(name)) throw new Error(`TOOL_ALREADY_REGISTERED:${name}`)
    if (typeof manifest.version !== 'string' || !manifest.version || typeof manifest.defaultTimeoutMs !== 'number' || !Number.isFinite(manifest.defaultTimeoutMs) || manifest.defaultTimeoutMs < 0 || !isManifestContract(manifest)) throw new Error(`INVALID_TOOL_MANIFEST:${name}`)
    if (manifest.supportsAbortSignal !== true) throw new Error(`TOOL_ABORT_SIGNAL_REQUIRED:${manifest.name}`)
    if (typeof candidate.execute !== 'function') throw new Error(`INVALID_TOOL_DEFINITION:${manifest.name}`)
    this.definitions.set(manifest.name, candidate)
  }

  get(name: string): RuntimeToolDefinition | undefined { return this.isAllowed(name) ? this.definitions.get(name) : undefined }
  isAllowed(name: string): boolean {
    const definition = this.definitions.get(name)
    return this.policy.deny.has(name) === false && (this.policy.allow === undefined || this.policy.allow.has(name)) && (definition === undefined || this.permissionsAllowed(definition.manifest))
  }
  permissionReasons(name: string): string[] {
    const definition = this.definitions.get(name)
    if (!definition) return ['UNKNOWN_TOOL']
    const reasons: string[] = []
    const permissions = definition.manifest.permissions
    if (!permissions) return reasons
    if (!this.policy.allowNetwork && (permissions.networkHosts?.length ?? 0) > 0) reasons.push('NETWORK_DISABLED')
    if (this.policy.networkHosts !== undefined) for (const rawHost of permissions.networkHosts ?? []) { const host = normalizeNetworkHost(rawHost); if (!this.policy.networkHosts.has('*') && !this.policy.networkHosts.has(host)) reasons.push(`NETWORK_HOST_NOT_ALLOWED:${rawHost}`) }
    if (this.policy.workspaceRoots !== undefined) for (const rawRoot of permissions.workspaceRoots ?? []) { const root = normalizeWorkspaceRoot(rawRoot); if (![...this.policy.workspaceRoots].some((allowed) => allowed === '*' || root === allowed || root.startsWith(`${allowed}/`))) reasons.push(`WORKSPACE_ROOT_NOT_ALLOWED:${rawRoot}`) }
    return reasons
  }
  list(): RuntimeToolManifest[] { return [...this.definitions.values()].filter((definition) => this.isAllowed(definition.manifest.name)).map((definition) => structuredClone(definition.manifest)) }

  validateInput(name: string, input: unknown): unknown {
    const definition = this.require(name)
    try {
      const parsed = definition.validateInput ? definition.validateInput(input) : input
      if (!definition.validateInput && !validateJsonSchema(parsed, definition.manifest.inputSchema)) throw new Error('schema mismatch')
      return parsed
    } catch { throw Object.assign(new Error(`Input does not match the manifest for tool ${name}.`), { code: 'INVALID_TOOL_INPUT', retryable: false }) }
  }

  discover(query: RuntimeToolDiscoveryQuery = {}): RuntimeToolDiscoveryResult[] {
    validateDiscoveryQuery(query)
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

  compileToolSet(id: string, query: RuntimeToolDiscoveryQuery = {}, version?: string): RuntimeToolSetSnapshot {
    if (!id) throw new Error('INVALID_TOOL_SET_ID')
    const tools = this.discover(query).map((result) => result.manifest)
    const derivedVersion = createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16)
    return { id, version: version ?? derivedVersion, tools: structuredClone(tools) }
  }

  async execute(name: string, input: unknown, context: RuntimeToolContext | AbortSignal): Promise<unknown> {
    const definition = this.require(name)
    const parsed = this.validateInput(name, input)
    const toolContext: RuntimeToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    const output = await definition.execute(parsed, toolContext)
    if (!validateJsonSchema(output, definition.manifest.outputSchema)) throw Object.assign(new Error(`Output does not match the manifest for tool ${name}.`), { code: 'TOOL_OUTPUT_SCHEMA_VIOLATION', retryable: false })
    return output
  }

  async executeDetailed(name: string, input: unknown, context: RuntimeToolContext | AbortSignal): Promise<{ output: unknown; normalized?: JsonValue; summary?: JsonValue; manifest: RuntimeToolManifest }> {
    const definition = this.require(name)
    const parsed = this.validateInput(name, input)
    const toolContext: RuntimeToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    const output = await definition.execute(parsed, toolContext)
    if (!validateJsonSchema(output, definition.manifest.outputSchema)) throw Object.assign(new Error(`Output does not match the manifest for tool ${name}.`), { code: 'TOOL_OUTPUT_SCHEMA_VIOLATION', retryable: false })
    const summary = definition.summarize?.(output)
    const summaryAllowed = summary === undefined || summaryWithinBudget(summary, definition.manifest.maxResultSummaryBytes ?? 4096)
    const normalized = definition.normalize?.(output)
    return { output, ...(normalized === undefined ? {} : { normalized }), ...(summaryAllowed && summary !== undefined ? { summary } : {}), manifest: structuredClone(definition.manifest) }
  }

  async reconcileDetailed(name: string, executionRef: JsonValue, context: RuntimeReconcileContext): Promise<RuntimeReconcileResult> {
    const definition = this.require(name)
    if (!definition.reconcile) throw new Error(`TOOL_NOT_RECOVERABLE:${name}`)
    const result = await definition.reconcile(executionRef, context)
    if (!result || typeof result !== 'object' || !['succeeded', 'failed', 'cancelled', 'unknown'].includes(result.status)) throw Object.assign(new Error(`Reconcile returned an invalid result for tool ${name}.`), { code: 'TOOL_RECONCILE_RESULT_INVALID', retryable: false })
    if (result.status === 'succeeded' && !validateJsonSchema(result.output, definition.manifest.outputSchema)) throw Object.assign(new Error(`Reconcile output does not match the manifest for tool ${name}.`), { code: 'TOOL_RECONCILE_OUTPUT_SCHEMA_VIOLATION', retryable: false })
    if (result.error !== undefined && (typeof result.error !== 'object' || result.error === null || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')) throw Object.assign(new Error(`Reconcile returned an invalid error for tool ${name}.`), { code: 'TOOL_RECONCILE_ERROR_INVALID', retryable: false })
    return result
  }

  executionRef(name: string, input: unknown, context: RuntimeToolContext): JsonValue | undefined {
    const definition = this.require(name)
    return definition.executionRef?.(this.validateInput(name, input), context)
  }

  resolveResources(name: string, input: unknown): ResourceLockSpec[] {
    const definition = this.require(name)
    if (definition.resolveResources) return definition.resolveResources(this.validateInput(name, input))
    if (definition.manifest.resources !== undefined) return definition.manifest.resources
    if (definition.manifest.locks.length > 0 || definition.resourceAdmissionMode === 'explicit') return definition.manifest.locks
    if (definition.manifest.sideEffectPolicy === 'write') return [{ resource: 'workspace', mode: 'exclusive' }]
    if (definition.manifest.sideEffectPolicy === 'read') return [{ resource: 'workspace', mode: 'shared' }]
    if (definition.manifest.sideEffectPolicy === 'external') return [{ resource: `external:${name}`, mode: 'exclusive' }]
    return []
  }

  admission(name: string, input: unknown): RuntimeToolAdmission {
    const definition = this.require(name)
    const parsed = this.validateInput(name, input)
    return { locks: structuredClone(this.resolveResources(name, parsed)), sideEffectPolicy: definition.manifest.sideEffectPolicy, defaultTimeoutMs: definition.manifest.defaultTimeoutMs, retrySafety: definition.manifest.retrySafety, version: definition.manifest.version }
  }

  private require(name: string): RuntimeToolDefinition {
    if (!this.isAllowed(name)) throw new Error(`TOOL_NOT_ALLOWED:${name}`)
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    return definition
  }

  private permissionsAllowed(manifest: RuntimeToolManifest): boolean { return this.permissionReasons(manifest.name).length === 0 }
}
