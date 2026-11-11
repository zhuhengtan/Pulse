import { z } from 'zod'

export const deviceIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/)
export const deviceStateSchema = z.object({
  power: z.boolean().optional(), brightness: z.number().finite().min(0).max(100).optional(),
  temperatureC: z.number().finite().min(-100).max(150).optional(),
  targetTemperatureC: z.number().finite().min(5).max(40).optional(),
  mode: z.string().min(1).max(40).optional(), fanMode: z.string().min(1).max(40).optional(),
}).strict()
export type DeviceState = z.infer<typeof deviceStateSchema>
export const deviceCapabilitySchema = z.object({
  kind: z.enum(['power', 'brightness', 'temperature_sensor', 'thermostat']),
  readable: z.boolean(), writable: z.boolean(), confirmable: z.boolean(),
  min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().positive().optional(),
  unit: z.enum(['percent', 'celsius']).optional(), modes: z.array(z.string().min(1).max(40)).max(40).optional(), fanModes: z.array(z.string().min(1).max(40)).max(40).optional(),
}).strict().refine(c => c.min === undefined || c.max === undefined || c.min <= c.max, 'INVALID_CAPABILITY_RANGE')
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>
export const availabilitySchema = z.enum(['online', 'offline', 'unavailable'])
export const deviceRecordSchema = z.object({
  deviceId: deviceIdSchema, adapter: deviceIdSchema, homeId: deviceIdSchema, roomId: deviceIdSchema,
  name: z.string().min(1).max(160), aliases: z.array(z.string().min(1).max(160)).max(30),
  capabilities: z.array(deviceCapabilitySchema).min(1).max(8), availability: availabilitySchema,
  observedAt: z.number().finite().nonnegative(), stateVersion: z.number().int().safe().nonnegative(), state: deviceStateSchema,
}).strict()
export type DeviceRecord = z.infer<typeof deviceRecordSchema>
export const deviceObservationSchema = z.object({
  deviceId: deviceIdSchema, availability: availabilitySchema, observedAt: z.number().finite().nonnegative(),
  stateVersion: z.number().int().safe().nonnegative(), state: deviceStateSchema, source: z.string().min(1).max(200),
}).strict()
export type DeviceObservation = z.infer<typeof deviceObservationSchema>
export interface DeviceAdapter {
  readonly id: string
  /** Trusted adapter declaration: snapshots cannot confirm physical execution. */
  readonly confirmationEvidence?: 'gateway-state'
  discover(signal?: AbortSignal): Promise<DeviceRecord[]>
  read(device: DeviceRecord, signal?: AbortSignal): Promise<DeviceObservation>
  set(device: DeviceRecord, desiredState: DeviceState, context: { commandId: string; deadline: number; signal?: AbortSignal }): Promise<{ status: 'sent' | 'rejected'; reason?: string }>
  subscribe?(listener: (observation: DeviceObservation) => void): () => void
  close?(): Promise<void>
}
export const commandRequestSchema = z.object({
  requestId: z.string().min(1).max(200), deviceId: deviceIdSchema,
  desiredState: deviceStateSchema,
  expectedVersion: z.number().int().safe().nonnegative().optional(), deadline: z.number().finite().nonnegative(),
  authorizationRef: z.string().min(1).max(200),
}).strict()
export type DeviceCommandRequest = z.infer<typeof commandRequestSchema>
export const commandStatusSchema = z.enum(['accepted', 'sent', 'observed', 'failed', 'unknown', 'cancelled', 'expired'])
export const deviceGrantSchema = z.object({ authorizationRef: z.string(), principal: z.string(), deviceId: z.string(), actions: z.array(z.enum(['power', 'brightness', 'temperatureC', 'targetTemperatureC', 'mode', 'fanMode'])), expiresAt: z.number().finite(), requireConfirmation: z.boolean().optional(), limits: z.object({ brightness: z.object({ min: z.number().finite(), max: z.number().finite() }).optional(), targetTemperatureC: z.object({ min: z.number().finite(), max: z.number().finite() }).optional() }).optional() }).strict()
const correlationId = z.string().min(1).max(200)
export const deviceCommandSourceSchema = z.object({
  entryPoint: z.enum(['broker-api', 'capability-pack', 'host-runtime', 'host-executor']),
  correlation: z.object({ toolCallId: correlationId.optional(), effectId: correlationId.optional(), attemptId: correlationId.optional(), agentId: correlationId.optional(), laneId: correlationId.optional() }).strict().optional(),
}).strict()
export type DeviceCommandSource = z.infer<typeof deviceCommandSourceSchema>
export const deviceCommandAuditSchema = z.object({
  version: z.literal(1),
  origin: deviceCommandSourceSchema.extend({ brokerId: z.string().uuid(), hostInstanceId: z.string().uuid().optional(), epoch: z.number().int().nonnegative().optional() }).strict(),
  acceptance: z.object({ at: z.number().finite(), authorizationChecked: z.literal(false), grant: deviceGrantSchema.nullable() }).strict(),
  dispatch: z.object({ at: z.number().finite(), grant: deviceGrantSchema, device: z.object({ deviceId: deviceIdSchema, adapter: deviceIdSchema, homeId: deviceIdSchema }).strict(), confirmation: z.object({ required: z.boolean(), verifiedByHost: z.boolean() }).strict() }).strict().optional(),
}).strict()
export type DeviceCommandAudit = z.infer<typeof deviceCommandAuditSchema>
export const devicePermissionEventSchema = z.object({ eventId: z.string().uuid(), at: z.number().finite(), action: z.enum(['grant', 'revoke']), source: z.literal('host-registry'), grant: deviceGrantSchema }).strict()
export type DevicePermissionEvent = z.infer<typeof devicePermissionEventSchema>
export const manualDeviceDispositionSchema = z.object({
  version: z.literal(1), eventId: z.string().uuid(), at: z.number().finite(), source: z.literal('trusted-local-admin'),
  action: z.literal('release-isolation'), acknowledgementVersion: z.literal(1), commandFingerprint: z.string(),
  device: z.object({ deviceId: deviceIdSchema, adapter: deviceIdSchema, homeId: deviceIdSchema }).strict(),
}).strict()
export const deviceCommandSchema = z.object({
  commandId: z.string().uuid(), request: commandRequestSchema, principal: z.string().min(1).max(200), fingerprint: z.string(),
  status: commandStatusSchema, createdAt: z.number().finite(), updatedAt: z.number().finite(), sentAt: z.number().finite().optional(),
  manualDisposition: manualDeviceDispositionSchema.optional(),
  reason: z.string().max(200).optional(), evidence: deviceObservationSchema.optional(), audit: deviceCommandAuditSchema.optional(),
  timeline: z.array(z.object({ status: commandStatusSchema, at: z.number().finite(), reason: z.string().max(200).optional() })),
}).strict()
export type DeviceCommand = z.infer<typeof deviceCommandSchema>
export interface DeviceGrant {
  authorizationRef: string; principal: string; deviceId: string; actions: (keyof DeviceState)[]
  expiresAt: number; requireConfirmation?: boolean
  limits?: Partial<Record<'brightness' | 'targetTemperatureC', { min: number; max: number }>>
}
export const writableStateKeys = ['power', 'brightness', 'targetTemperatureC', 'mode', 'fanMode'] as const
export function assertDesiredState(device: DeviceRecord, desired: DeviceState): void {
  deviceStateSchema.parse(desired)
  if (Object.keys(desired).length === 0) throw new Error('DEVICE_EMPTY_TARGET')
  const required: Record<string, DeviceCapability['kind']> = { power: 'power', brightness: 'brightness', targetTemperatureC: 'thermostat', mode: 'thermostat', fanMode: 'thermostat' }
  for (const [key, value] of Object.entries(desired)) {
    const cap = device.capabilities.find(c => c.kind === required[key] && c.writable)
    if (!cap) throw new Error('DEVICE_ACTION_UNSUPPORTED')
    if (typeof value === 'number' && ((cap.min !== undefined && value < cap.min) || (cap.max !== undefined && value > cap.max))) throw new Error('DEVICE_VALUE_OUT_OF_RANGE')
    if (typeof value === 'number' && cap.step !== undefined && Math.abs((value - (cap.min ?? 0)) / cap.step - Math.round((value - (cap.min ?? 0)) / cap.step)) > 1e-6) throw new Error('DEVICE_VALUE_STEP')
    if (key === 'mode' && !cap.modes?.includes(String(value))) throw new Error('DEVICE_MODE_UNSUPPORTED')
    if (key === 'fanMode' && !cap.fanModes?.includes(String(value))) throw new Error('DEVICE_FAN_MODE_UNSUPPORTED')
  }
}
export function stateMatches(actual: DeviceState, desired: DeviceState): boolean {
  return Object.entries(desired).every(([key, value]) => actual[key as keyof DeviceState] === value)
}
