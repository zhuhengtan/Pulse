import { z, type ZodTypeAny } from 'zod'

export const TOOL_SDK_VERSION = '0.1.0'
export type ConcurrencyClass = 'llm' | 'tool' | 'agent' | 'none'
export interface ToolManifest {
  name: string
  version: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  concurrencyClass: ConcurrencyClass
  locks: Array<{ resource: string; mode: 'shared' | 'exclusive' }>
  supportsAbortSignal: boolean
  sideEffectPolicy: 'none' | 'read' | 'write'
  retrySafety: 'read_only' | 'idempotent' | 'unsafe'
  defaultTimeoutMs: number
}
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  manifest: ToolManifest
  execute(input: TInput, signal: AbortSignal): Promise<TOutput> | TOutput
  summarize?(output: TOutput): JsonValue
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<any, any>>()
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (!definition.manifest.name || this.definitions.has(definition.manifest.name)) throw new Error(`TOOL_ALREADY_REGISTERED:${definition.manifest.name}`)
    this.definitions.set(definition.manifest.name, definition)
  }
  get(name: string): ToolDefinition<any, any> | undefined { return this.definitions.get(name) }
  list(): ToolManifest[] { return [...this.definitions.values()].map((definition) => structuredClone(definition.manifest)) }
  async execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    return definition.execute(input, signal)
  }
  async executeDetailed(name: string, input: unknown, signal: AbortSignal): Promise<{ output: unknown; summary?: JsonValue; manifest: ToolManifest }> {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    const output = await definition.execute(input, signal)
    const summary = definition.summarize?.(output)
    return { output, ...(summary === undefined ? {} : { summary }), manifest: structuredClone(definition.manifest) }
  }
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
  locks?: Array<{ resource: string; mode: 'shared' | 'exclusive' }>
  supportsAbortSignal?: boolean
  sideEffectPolicy?: ToolManifest['sideEffectPolicy']
  retrySafety?: ToolManifest['retrySafety']
  defaultTimeoutMs?: number
  summarize?: (output: TOutput) => JsonValue
  execute(input: TInput, signal: AbortSignal): Promise<TOutput> | TOutput
}): ToolDefinition<TInput, TOutput> {
  const manifest: ToolManifest = { name: config.name, version: config.version ?? '1', description: config.description, inputSchema: zodToJsonSchema(config.input), outputSchema: zodToJsonSchema(config.output), concurrencyClass: config.concurrencyClass ?? 'tool', locks: config.locks ?? [], supportsAbortSignal: config.supportsAbortSignal ?? true, sideEffectPolicy: config.sideEffectPolicy ?? 'none', retrySafety: config.retrySafety ?? (config.sideEffectPolicy === 'write' ? 'unsafe' : 'read_only'), defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000 }
  return { manifest, execute: async (input, signal) => config.output.parse(await config.execute(config.input.parse(input), signal)), ...(config.summarize === undefined ? {} : { summarize: (output: TOutput) => config.summarize!(output) }) }
}
