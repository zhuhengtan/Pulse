import { z, type ZodTypeAny } from 'zod'

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
export interface ReconcileResult<TOutput> { status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; output?: TOutput; error?: { code: string; message: string; details?: JsonValue } }
export interface ToolManifest {
  name: string
  version: string
  description: string
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
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  manifest: ToolManifest
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput
  resolveResources?(input: TInput): ResourceClaim[]
  reconcile?(executionRef: JsonValue, context: ReconcileContext): Promise<ReconcileResult<TOutput>>
  normalize?(output: TOutput): JsonValue
  summarize?(output: TOutput): JsonValue
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<any, any>>()
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (!definition.manifest.name || this.definitions.has(definition.manifest.name)) throw new Error(`TOOL_ALREADY_REGISTERED:${definition.manifest.name}`)
    if (!definition.manifest.version || !Number.isFinite(definition.manifest.defaultTimeoutMs) || definition.manifest.defaultTimeoutMs < 0) throw new Error(`INVALID_TOOL_MANIFEST:${definition.manifest.name}`)
    if (!definition.manifest.supportsAbortSignal) throw new Error(`TOOL_ABORT_SIGNAL_REQUIRED:${definition.manifest.name}`)
    this.definitions.set(definition.manifest.name, definition)
  }
  get(name: string): ToolDefinition<any, any> | undefined { return this.definitions.get(name) }
  list(): ToolManifest[] { return [...this.definitions.values()].map((definition) => structuredClone(definition.manifest)) }
  async execute(name: string, input: unknown, context: ToolContext | AbortSignal): Promise<unknown> {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    const toolContext: ToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    return definition.execute(input, toolContext)
  }
  async executeDetailed(name: string, input: unknown, context: ToolContext | AbortSignal): Promise<{ output: unknown; summary?: JsonValue; manifest: ToolManifest }> {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    const toolContext: ToolContext = 'aborted' in context ? { toolCallId: '', effectId: '', attemptId: '', agentId: '', laneId: '', signal: context, emit: () => {} } : context
    const output = await definition.execute(input, toolContext)
    const summary = definition.summarize?.(output)
    if (summary !== undefined && JSON.stringify(summary).length > (definition.manifest.maxResultSummaryBytes ?? 4096)) throw new Error('TOOL_SUMMARY_TOO_LARGE')
    return { output, ...(summary === undefined ? {} : { summary }), manifest: structuredClone(definition.manifest) }
  }
  resolveResources(name: string, input: unknown): ResourceClaim[] { const definition = this.definitions.get(name); if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`); return definition.resolveResources?.(input) ?? definition.manifest.resources ?? definition.manifest.locks }
}

function schemaToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const typeName = schema._def.typeName as string
  if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = (schema as z.ZodObject<any>)._def.shape()
    return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, schemaToJsonSchema(value as ZodTypeAny)])), required: Object.entries(shape).filter(([, value]) => !(value as ZodTypeAny).isOptional()).map(([key]) => key) }
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodArray) return { type: 'array', items: schemaToJsonSchema(schema._def.type) }
  if (typeName === z.ZodFirstPartyTypeKind.ZodString) return { type: 'string' }
  if (typeName === z.ZodFirstPartyTypeKind.ZodNumber) return { type: 'number' }
  if (typeName === z.ZodFirstPartyTypeKind.ZodBoolean) return { type: 'boolean' }
  if (typeName === z.ZodFirstPartyTypeKind.ZodOptional) return schemaToJsonSchema(schema._def.innerType)
  if (typeName === z.ZodFirstPartyTypeKind.ZodEnum) return { type: 'string', enum: schema._def.values }
  return {}
}

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> { return schemaToJsonSchema(schema) }

export function defineTool<TInput, TOutput>(config: {
  name: string
  version?: string
  description: string
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
}): ToolDefinition<TInput, TOutput> {
  const manifest: ToolManifest = { name: config.name, version: config.version ?? '1', description: config.description, inputSchema: zodToJsonSchema(config.input), outputSchema: zodToJsonSchema(config.output), concurrencyClass: config.concurrencyClass ?? 'tool', locks: config.locks ?? [], ...(config.resources === undefined ? {} : { resources: config.resources }), supportsAbortSignal: config.supportsAbortSignal ?? true, sideEffectPolicy: config.sideEffectPolicy ?? 'none', retrySafety: config.retrySafety ?? (config.sideEffectPolicy === 'write' ? 'unsafe' : 'read_only'), defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000, ...(config.maxResultSummaryBytes === undefined ? {} : { maxResultSummaryBytes: config.maxResultSummaryBytes }) }
  return { manifest, execute: async (input, context) => config.output.parse(await config.execute(config.input.parse(input), context)), ...(config.resolveResources === undefined ? {} : { resolveResources: (input: TInput) => config.resolveResources!(input) }), ...(config.reconcile === undefined ? {} : { reconcile: config.reconcile }), ...(config.normalize === undefined ? {} : { normalize: config.normalize }), ...(config.summarize === undefined ? {} : { summarize: (output: TOutput) => config.summarize!(output) }) }
}
