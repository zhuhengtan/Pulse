import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolContext, ToolDefinition, ToolManifest } from '@hunterzhu/pulse-tool-sdk'
import type { CapabilityPackActivation } from '../capabilities.js'
import { commandRequestSchema, deviceIdSchema, deviceStateSchema } from './types.js'

export const DEVICE_IPC_MAX_REQUEST_BYTES = 65_536
export const DEVICE_IPC_MAX_RESULT_BYTES = 262_144
export const deviceToolNames = ['device.list', 'device.inspect', 'device.read', 'device.set', 'device.scene.run', 'device.command.status', 'device.wait'] as const
export type DeviceToolName = typeof deviceToolNames[number]
export type DeviceUseRemoteExecutor = (name: DeviceToolName, input: unknown, context: ToolContext) => Promise<unknown>
export interface DeviceUseWorkerBridgeOptions { tools: ToolManifest[]; instructions: string[]; execute: DeviceUseRemoteExecutor }
export interface DeviceUseWorkerConfiguration { sessionId: string; tools: ToolManifest[]; instructions: string[] }
const nameSchema = z.enum(deviceToolNames)
const id = z.string().min(1).max(200)
const contextSchema = z.object({ toolCallId: id, effectId: id, attemptId: id, agentId: id, laneId: id, idempotencyKey: id.optional() }).strict()
const schemas: Record<DeviceToolName, z.ZodTypeAny> = {
  'device.list': z.object({}).strict(), 'device.inspect': z.object({ deviceId: deviceIdSchema }).strict(), 'device.read': z.object({ deviceId: deviceIdSchema }).strict(),
  'device.set': commandRequestSchema,
  'device.scene.run': z.object({ sceneId: z.string().min(1).max(64), requestId: z.string().min(1).max(160), deadline: z.number().finite() }).strict(),
  'device.command.status': z.object({ commandId: z.string().uuid(), reconcile: z.boolean().default(false) }).strict(),
  'device.wait': z.object({ deviceId: deviceIdSchema, desiredState: deviceStateSchema, deadline: z.number().finite() }).strict(),
}
const requestSchema = z.object({ schemaVersion: z.literal(1), type: z.literal('deviceUseRequest'), sessionId: z.string().uuid(), runId: id, requestId: z.string().uuid(), name: nameSchema, input: z.unknown(), context: contextSchema }).strict()
const cancelSchema = z.object({ schemaVersion: z.literal(1), type: z.literal('deviceUseCancel'), sessionId: z.string().uuid(), runId: id, requestId: z.string().uuid() }).strict()
const resultSchema = z.object({ schemaVersion: z.literal(1), type: z.literal('deviceUseResult'), sessionId: z.string().uuid(), runId: id, requestId: z.string().uuid(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(100).optional() }).strict()
export type DeviceUseIpcMessage = z.infer<typeof requestSchema> | z.infer<typeof cancelSchema> | z.infer<typeof resultSchema>
const isDeviceMessage = (raw: unknown) => !!raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string' && (raw as { type: string }).type.startsWith('deviceUse')
function bounded(value: unknown, limit: number): boolean { try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit } catch { return false } }
function failureCode(error: unknown): string { const code = error instanceof Error ? error.message : ''; return /^DEVICE_[A-Z_]{1,80}$/.test(code) ? code : 'DEVICE_IPC_EXECUTION_FAILED' }

/** Parent-only endpoint: tied to one child and one Run; no caller-selected principal. */
export class DeviceUseIpcParent {
  readonly sessionId = randomUUID()
  private runId: string | undefined
  private closed = false
  private readonly pending = new Map<string, AbortController>()
  private readonly seen = new Set<string>()
  constructor(private readonly execute: DeviceUseRemoteExecutor, private readonly send: (message: DeviceUseIpcMessage) => Promise<void>, private readonly protocolError: (error: Error) => void = () => {}, private readonly timeoutMs = 125_000) {}
  bindRun(runId: string): void { if (this.runId && this.runId !== runId) throw new Error('DEVICE_IPC_SCOPE'); this.runId = id.parse(runId) }
  receive(raw: unknown): boolean {
    if (!isDeviceMessage(raw)) return false
    if (this.closed) return true // Late aborts/results after Run shutdown cannot reopen the channel.
    if (!bounded(raw, DEVICE_IPC_MAX_REQUEST_BYTES)) { this.protocolError(new Error('DEVICE_IPC_REQUEST_TOO_LARGE')); return true }
    const parsed = requestSchema.safeParse(raw), cancelled = cancelSchema.safeParse(raw)
    if (!parsed.success && !cancelled.success) { this.protocolError(new Error('DEVICE_IPC_PROTOCOL')); return true }
    const message = parsed.success ? parsed.data : cancelled.data!
    if (this.closed || !this.runId || message.sessionId !== this.sessionId || message.runId !== this.runId) { this.protocolError(new Error('DEVICE_IPC_SCOPE')); return true }
    if (message.type === 'deviceUseCancel') { this.pending.get(message.requestId)?.abort(); return true }
    if (this.seen.has(message.requestId)) { void this.reply(message.requestId, false, undefined, 'DEVICE_IPC_DUPLICATE'); return true }
    if (this.pending.size >= 32 || this.seen.size >= 4096) { void this.reply(message.requestId, false, undefined, 'DEVICE_IPC_LIMIT'); return true }
    this.seen.add(message.requestId)
    const input = schemas[message.name].safeParse(message.input)
    if (!input.success) { void this.reply(message.requestId, false, undefined, 'DEVICE_IPC_INPUT_INVALID'); return true }
    const controller = new AbortController(); this.pending.set(message.requestId, controller)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const { idempotencyKey, ...ids } = message.context
    const context: ToolContext = { ...ids, ...(idempotencyKey ? { idempotencyKey } : {}), signal: controller.signal, emit: () => {} }
    // A single attempt only. Timeout/disconnect never triggers replay.
    void Promise.race([
      Promise.resolve().then(() => this.execute(message.name, input.data, context)),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('DEVICE_IPC_OUTCOME_UNKNOWN')), { once: true })),
    ]).then(value => {
      if (!bounded(value, DEVICE_IPC_MAX_RESULT_BYTES)) return this.reply(message.requestId, false, undefined, 'DEVICE_IPC_RESULT_TOO_LARGE')
      return this.reply(message.requestId, true, value)
    }, error => this.reply(message.requestId, false, undefined, failureCode(error))).catch(() => {}).finally(() => { clearTimeout(timer); this.pending.delete(message.requestId) })
    return true
  }
  private async reply(requestId: string, ok: boolean, value?: unknown, error?: string): Promise<void> {
    if (this.closed || !this.runId) return
    await this.send({ schemaVersion: 1, type: 'deviceUseResult', sessionId: this.sessionId, runId: this.runId, requestId, ok, ...(value === undefined ? {} : { value }), ...(error ? { error } : {}) }).catch(() => {})
  }
  close(): void { this.closed = true; for (const controller of this.pending.values()) controller.abort(); this.pending.clear() }
}

/** Worker endpoint never opens a ledger, owns credentials or creates an adapter. */
export class DeviceUseIpcClient {
  private runId: string | undefined
  private closed = false
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; stop: () => void }>()
  private bindingResolve!: () => void
  private readonly binding = new Promise<void>(resolve => { this.bindingResolve = resolve })
  constructor(readonly sessionId: string, private readonly send: (message: DeviceUseIpcMessage) => Promise<void>, private readonly timeoutMs = 125_000) { z.string().uuid().parse(sessionId) }
  bindRun(runId: string): void { if (this.runId && this.runId !== runId) throw new Error('DEVICE_IPC_SCOPE'); this.runId = id.parse(runId); this.bindingResolve() }
  async execute(name: DeviceToolName, input: unknown, context: ToolContext): Promise<unknown> {
    nameSchema.parse(name); schemas[name].parse(input)
    if (this.closed) throw new Error('DEVICE_IPC_CLOSED')
    context.signal.throwIfAborted()
    if (!this.runId) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('DEVICE_IPC_ABORTED'))
        context.signal.addEventListener('abort', abort, { once: true })
        void this.binding.then(resolve).finally(() => context.signal.removeEventListener('abort', abort))
      })
    }
    if (this.closed || !this.runId) throw new Error('DEVICE_IPC_CLOSED')
    if (this.pending.size >= 32) throw new Error('DEVICE_IPC_LIMIT')
    const requestId = randomUUID()
    const request = requestSchema.parse({ schemaVersion: 1, type: 'deviceUseRequest', sessionId: this.sessionId, runId: this.runId, requestId, name, input, context: { toolCallId: context.toolCallId, effectId: context.effectId, attemptId: context.attemptId, agentId: context.agentId, laneId: context.laneId, ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}) } })
    if (!bounded(request, DEVICE_IPC_MAX_REQUEST_BYTES)) throw new Error('DEVICE_IPC_REQUEST_TOO_LARGE')
    return new Promise((resolve, reject) => {
      const cancel = (code: string) => { if (!this.pending.delete(requestId)) return; stop(); void this.send({ schemaVersion: 1, type: 'deviceUseCancel', sessionId: this.sessionId, runId: this.runId!, requestId }).catch(() => {}); reject(new Error(code)) }
      const onAbort = () => cancel('DEVICE_IPC_OUTCOME_UNKNOWN')
      const timer = setTimeout(() => cancel('DEVICE_IPC_OUTCOME_UNKNOWN'), this.timeoutMs)
      const stop = () => { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort) }
      this.pending.set(requestId, { resolve, reject, stop })
      context.signal.addEventListener('abort', onAbort, { once: true })
      if (context.signal.aborted) { onAbort(); return }
      void this.send(request).catch(() => cancel('DEVICE_IPC_OUTCOME_UNKNOWN'))
    })
  }
  receive(raw: unknown): boolean {
    if (!isDeviceMessage(raw)) return false
    if (!bounded(raw, DEVICE_IPC_MAX_RESULT_BYTES)) { this.close('DEVICE_IPC_RESULT_TOO_LARGE'); return true }
    const parsed = resultSchema.safeParse(raw)
    if (!parsed.success) { this.close('DEVICE_IPC_PROTOCOL'); return true }
    const message = parsed.data
    if (message.sessionId !== this.sessionId || message.runId !== this.runId) { this.close('DEVICE_IPC_SCOPE'); return true }
    const pending = this.pending.get(message.requestId); if (!pending) return true
    this.pending.delete(message.requestId); pending.stop()
    message.ok ? pending.resolve(message.value) : pending.reject(new Error(message.error ?? 'DEVICE_IPC_EXECUTION_FAILED'))
    return true
  }
  close(code = 'DEVICE_IPC_OUTCOME_UNKNOWN'): void { this.closed = true; this.bindingResolve(); for (const pending of this.pending.values()) { pending.stop(); pending.reject(new Error(code)) } this.pending.clear() }
}

export function createRemoteDeviceActivation(configuration: Pick<DeviceUseWorkerConfiguration, 'tools' | 'instructions'>, executor: DeviceUseRemoteExecutor): CapabilityPackActivation {
  if (!bounded(configuration, DEVICE_IPC_MAX_REQUEST_BYTES) || !Array.isArray(configuration.tools) || !Array.isArray(configuration.instructions) || configuration.instructions.some(i => typeof i !== 'string') || new Set(configuration.tools.map(t => t.name)).size !== configuration.tools.length) throw new Error('DEVICE_IPC_CONFIGURATION')
  const tools: ToolDefinition[] = configuration.tools.map(manifest => {
    const name = nameSchema.parse(manifest.name), external = name === 'device.set' || name === 'device.scene.run'
    if (manifest.sideEffectPolicy !== (external ? 'external' : 'read') || manifest.retrySafety !== (external ? 'unsafe' : 'read_only')) throw new Error('DEVICE_IPC_TOOL_POLICY')
    return { manifest, validateInput: input => schemas[name].parse(input), execute: (input, context) => executor(name, schemas[name].parse(input), context) }
  })
  return { tools, instructions: configuration.instructions }
}
