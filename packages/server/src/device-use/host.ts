import { hasManualIsolationRelease, projectCommandHistory, revokeDeviceGrants } from './audit.js'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import type { CapabilityPackActivation } from '../capabilities.js'
import { DeviceBroker, withQuiescentDevice } from './broker.js'
import { DeviceRegistry } from './registry.js'
import { DeviceStore } from './store.js'
import { SimulatedDeviceAdapter } from './simulator.js'
import { HomeAssistantAdapter } from './home-assistant.js'
import { createDeviceCapabilityPack } from './pack.js'
import { deviceIdSchema, type DeviceAdapter, type DeviceCommand, type DevicePermissionEvent, type DeviceCommandSource, type DeviceGrant } from './types.js'

const climateTemperatureUnitSchema = z.enum(['celsius', 'fahrenheit'])
// This non-secret preference is scoped to the exact gateway origin and local home ID.
// It is never inherited by an API handoff which omits the unit.
const configSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), mode: z.enum(['simulator', 'home-assistant']),
  homeAssistantTemperature: z.object({ homeId: deviceIdSchema, baseUrl: z.string().url().max(2048), climateTemperatureUnit: climateTemperatureUnitSchema }).strict().optional(),
}).strict()
const haSchema = z.object({
  homeId: deviceIdSchema, baseUrl: z.string().url().max(2048), token: z.string().trim().min(1).max(16384),
  allowInsecureLocalHttp: z.boolean().default(false), climateTemperatureUnit: climateTemperatureUnitSchema.optional(),
  entities: z.array(z.object({ entityId: z.string().max(200), roomId: deviceIdSchema.optional(), writable: z.boolean().default(false) }).strict()).min(1).max(100),
}).strict()
const grantSchema = z.object({
  deviceId: deviceIdSchema, actions: z.array(z.enum(['power', 'brightness'])).min(1).max(2),
  expiresInMinutes: z.number().int().min(1).max(1440), brightnessMax: z.number().int().min(0).max(100).default(100),
}).strict()
export const DEVICE_HOST_PRINCIPAL = 'local-owner'
const liveHosts = new Map<string, HostDeviceService>()

/** Trusted process-lifetime service. No credentials or enrollment mutations are model tools.
 * HA credentials are held in memory only, supplied by an explicit local settings action. */
export class HostDeviceService {
  private readonly manualChallenges = new Map<string, { binding: string; commandId: string; mode: 'simulator' | 'home-assistant'; digest: string; epoch: number; expiresAt: number; deviceId: string; eventId?: string }>()
  private readonly hostInstanceId = randomUUID()
  private config = configSchema.parse({ version: 1, enabled: false, mode: 'simulator' })
  private loaded: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private broker: DeviceBroker | undefined
  private adapter: DeviceAdapter | undefined
  private generation = 0
  private closed = false
  private recovering: Promise<DeviceBroker> | undefined
  private readonly directory: string
  constructor(dataDir: string) { this.directory = join(dataDir, 'device-use') }
  get epoch(): number { return this.generation }
  getEpoch(): number { return this.generation }
  private async load(): Promise<void> {
    await (this.loaded ??= (async () => {
      try {
        const directory = await lstat(this.directory)
        if (directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error('DEVICE_HOST_UNSAFE_PATH')
        if ((await lstat(join(this.directory, 'settings.json'))).isSymbolicLink()) throw new Error('DEVICE_HOST_UNSAFE_PATH')
        this.config = configSchema.parse(JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8')))
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DEVICE_HOST_SETTINGS_INVALID') }
    })())
    if (this.closed) throw new Error('DEVICE_HOST_CLOSED')
  }
  private async save(): Promise<void> {
    if (process.platform === 'win32') throw new Error('DEVICE_HOST_PRIVATE_STORAGE_UNSUPPORTED')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('DEVICE_HOST_UNSAFE_PATH')
    const path = join(this.directory, `${randomUUID()}.tmp`)
    try {
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(this.config)); await file.sync() } finally { await file.close() }
      await rename(path, join(this.directory, 'settings.json'))
    } finally { await unlink(path).catch(() => {}) }
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(work); this.tail = result; return result
  }
  private claimHost(): void {
    const owner = liveHosts.get(this.directory)
    if (owner && owner !== this) throw new Error('DEVICE_HOST_ALREADY_RUNNING')
    liveHosts.set(this.directory, this)
  }
  private async revokeCurrentGrants(): Promise<void> {
    const path = join(this.directory, `${this.config.mode}-ledger.json`)
    try { await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    await new DeviceStore(path).transaction(l => { revokeDeviceGrants(l, grant => grant.principal === DEVICE_HOST_PRINCIPAL, Date.now()) })
  }
  private async ensureBroker(): Promise<DeviceBroker> {
    await this.load()
    if (!this.config.enabled) throw new Error('DEVICE_HOST_DISABLED')
    if (process.platform === 'win32') throw new Error('DEVICE_HOST_PRIVATE_STORAGE_UNSUPPORTED')
    this.claimHost()
    if (this.broker) return this.broker
    return this.recovering ??= (async () => {
      if (this.config.mode === 'home-assistant' && !this.adapter) throw new Error('DEVICE_HA_CREDENTIALS_REQUIRED')
      const generation = this.generation
      const registry = new DeviceRegistry(new DeviceStore(join(this.directory, `${this.config.mode}-ledger.json`)))
      const adapter = this.adapter ?? new SimulatedDeviceAdapter()
      if (adapter instanceof SimulatedDeviceAdapter) adapter.hydrate(await registry.store.transaction(l => l.devices, false))
      const broker = new DeviceBroker(registry, [adapter], { hostIdentity: { instanceId: this.hostInstanceId, epoch: generation }, canDispatch: () => this.config.enabled && !this.closed && this.generation === generation })
      try { await broker.recover(); if (!this.config.enabled || this.generation !== generation) throw new Error('DEVICE_HOST_DISABLED'); this.broker = broker; return broker }
      catch (e) { await broker.close(); throw e }
    })().finally(() => { this.recovering = undefined })
  }
  /** Local read-only evidence remains available without an adapter, token or enablement. */
  async history() {
    await this.load()
    const commands: DeviceCommand[] = [], permissionEvents: DevicePermissionEvent[] = [], grants: DeviceGrant[] = []
    for (const mode of ['simulator', 'home-assistant']) {
      const path = join(this.directory, `${mode}-ledger.json`)
      try { await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
      const ledger = await new DeviceStore(path).transaction(l => ({ commands: l.commands.filter(c => c.principal === DEVICE_HOST_PRINCIPAL), grants: l.grants.filter(g => g.principal === DEVICE_HOST_PRINCIPAL && g.expiresAt > Date.now() && l.enrolled.includes(g.deviceId)), permissionEvents: (l.permissionEvents ?? []).filter(event => event.grant.principal === DEVICE_HOST_PRINCIPAL) }), false)
      commands.push(...ledger.commands); permissionEvents.push(...ledger.permissionEvents); grants.push(...ledger.grants)
    }
    return { ...projectCommandHistory(commands), grants, permissionEvents: permissionEvents.sort((a, b) => b.at - a.at).slice(0, 30), permissionEventCount: permissionEvents.length }
  }
  async status() {
    await this.load()
    const ready = this.config.enabled && (this.config.mode === 'simulator' || Boolean(this.adapter))
    const broker = ready ? await this.ensureBroker() : undefined
    const records = broker ? await broker.registry.list() : []
    return { enabled: this.config.enabled, mode: this.config.mode, epoch: this.epoch, ready, simulated: this.config.mode === 'simulator',
      homeAssistantTemperature: this.config.homeAssistantTemperature ?? null,
      realHardwareVerified: false, credentials: this.adapter ? 'memory-only' : 'not-configured',
      status: !this.config.enabled ? 'disabled' : !ready ? 'credentials-required' : this.config.mode === 'simulator' ? 'simulator-only' : 'configured-not-hardware-verified',
      devices: records,
      ...await this.history(),
    }
  }
  async configure(input: unknown) {
    return this.serialize(async () => {
      await this.load()
      const next = z.object({ enabled: z.boolean(), mode: z.enum(['simulator', 'home-assistant']) }).strict().parse(input)
      this.claimHost()
      if (next.enabled === this.config.enabled && next.mode === this.config.mode) return this.status()
      // Invalidate tools and queued actions before awaiting any cleanup or disk work.
      this.generation++; const previous = this.broker; this.broker = undefined
      await this.revokeCurrentGrants()
      this.config = { ...this.config, ...next }
      await this.recovering?.catch(() => {}); await previous?.close()
      if (this.adapter) { await this.adapter.close?.(); this.adapter = undefined }
      try { await this.save() } catch (e) { this.config.enabled = false; throw e }
      return this.status()
    })
  }
  async connectHomeAssistant(input: unknown) {
    return this.serialize(async () => {
      await this.load()
      const parsed = haSchema.parse(input)
      this.claimHost()
      // Construction validates the fixed URL and entity allowlist before receiving network access.
      let token = parsed.token
      const adapter = new HomeAssistantAdapter({ homeId: parsed.homeId, baseUrl: parsed.baseUrl, allowInsecureLocalHttp: parsed.allowInsecureLocalHttp, ...(parsed.climateTemperatureUnit ? { climateTemperatureUnit: parsed.climateTemperatureUnit } : {}), entities: parsed.entities.map(e => ({ entityId: e.entityId, writable: e.writable, ...(e.roomId ? { roomId: e.roomId } : {}) })), getAccessToken: async () => token })
      this.generation++; const previous = this.broker; this.broker = undefined
      await this.revokeCurrentGrants()
      this.config = { version: 1, enabled: false, mode: 'home-assistant', ...(parsed.climateTemperatureUnit ? { homeAssistantTemperature: { homeId: parsed.homeId, baseUrl: new URL(parsed.baseUrl).origin, climateTemperatureUnit: parsed.climateTemperatureUnit } } : {}) }
      await this.recovering?.catch(() => {}); await previous?.close(); await this.adapter?.close?.()
      this.adapter = adapter
      this.config.enabled = true
      try {
        const broker = await this.ensureBroker(); await broker.discover(); await adapter.startEvents(); await this.save()
        return this.status()
      } catch { token = ''; this.generation++; this.config.enabled = false; await (this.broker as DeviceBroker | undefined)?.close(); this.broker = undefined; await adapter.close(); this.adapter = undefined; await this.save(); throw new Error('DEVICE_HA_CONNECTION_FAILED') }
    })
  }
  /** Local management query: preserve the original command and never dispatch/retry it. */
  async reconcile(input: unknown) {
    return this.serialize(async () => {
      await this.load(); this.claimHost()
      const { commandId } = z.object({ commandId: z.string().uuid() }).strict().parse(input)
      const matches: Array<{ mode: 'simulator' | 'home-assistant'; command: DeviceCommand }> = []
      for (const mode of ['simulator', 'home-assistant'] as const) {
        const path = join(this.directory, `${mode}-ledger.json`)
        try { await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
        const command = await new DeviceStore(path).transaction(l => l.commands.find(c => c.commandId === commandId && c.principal === DEVICE_HOST_PRINCIPAL), false)
        if (command) matches.push({ mode, command })
      }
      if (matches.length !== 1) throw new Error('DEVICE_COMMAND_NOT_FOUND')
      const { mode, command } = matches[0]!
      let outcome: string
      if (hasManualIsolationRelease(command)) outcome = 'manually-released'
      else if (!['accepted', 'sent', 'unknown'].includes(command.status)) outcome = 'not-pending'
      else if (command.status === 'accepted') outcome = 'not-sent'
      else if (!this.config.enabled) outcome = 'disabled'
      else if (mode !== this.config.mode) outcome = 'mode-not-active'
      else if (mode === 'home-assistant' && !this.adapter) outcome = 'credentials-required'
      // Old HA ledgers do not bind a gateway origin. A new connection with the
      // same home/entity IDs cannot prove the old command's result. Fail closed.
      else if (mode === 'home-assistant' && (command.audit?.origin.hostInstanceId !== this.hostInstanceId || command.audit.origin.epoch !== this.generation)) outcome = 'connection-unverified'
      else outcome = (await (await this.ensureBroker()).reconcileResult(DEVICE_HOST_PRINCIPAL, commandId)).outcome
      return { ...await this.status(), reconciliation: { commandId, outcome, checkedAt: Date.now() } }
    })
  }
  private async manualCommand(commandId: string) {
    const matches: Array<{ mode: 'simulator' | 'home-assistant'; command: DeviceCommand }> = []
    for (const mode of ['simulator', 'home-assistant'] as const) {
      const path = join(this.directory, `${mode}-ledger.json`)
      try { await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
      const command = await new DeviceStore(path).transaction(l => l.commands.find(c => c.commandId === commandId && c.principal === DEVICE_HOST_PRINCIPAL), false)
      if (command) matches.push({ mode, command })
    }
    if (matches.length !== 1) throw new Error('DEVICE_COMMAND_NOT_FOUND')
    return matches[0]!
  }
  private assertManualCandidate(command: DeviceCommand, devices: import('./types.js').DeviceRecord[], grants: DeviceGrant[]) {
    if (this.config.enabled || this.broker || this.recovering) throw new Error('DEVICE_MANUAL_DISABLE_AND_REVOKE_FIRST')
    const device = devices.find(d => d.deviceId === command.request.deviceId), identity = command.audit?.dispatch?.device
    if (command.status !== 'unknown' || command.sentAt === undefined || command.manualDisposition || !command.audit?.origin.hostInstanceId || !identity || !device || identity.deviceId !== device.deviceId || identity.adapter !== device.adapter || identity.homeId !== device.homeId) throw new Error('DEVICE_MANUAL_RECORD_UNSUPPORTED')
    if (!(device.deviceId === 'sim:light' && device.adapter === 'simulator') && !(device.adapter === 'home-assistant' && device.deviceId.startsWith(`home-assistant:${device.homeId}:light.`))) throw new Error('DEVICE_MANUAL_RECORD_UNSUPPORTED')
    if (!device.capabilities.every(c => ['power', 'brightness'].includes(c.kind)) || !Object.keys(command.request.desiredState).length || Object.keys(command.request.desiredState).some(key => !['power', 'brightness'].includes(key))) throw new Error('DEVICE_MANUAL_RECORD_UNSUPPORTED')
    if (grants.some(g => g.deviceId === device.deviceId && g.expiresAt > Date.now())) throw new Error('DEVICE_MANUAL_DISABLE_AND_REVOKE_FIRST')
    return identity
  }
  /** Preview is session-bound, short lived and not a physical-confirmation credential. */
  async previewManualResolution(input: unknown, binding: string) {
    return this.serialize(async () => {
      await this.load(); this.claimHost()
      const { commandId } = z.object({ commandId: z.string().uuid() }).strict().parse(input)
      if (!binding || binding.length > 200) throw new Error('DEVICE_MANUAL_CONFIRMATION_INVALID')
      const { mode } = await this.manualCommand(commandId), store = new DeviceStore(join(this.directory, `${mode}-ledger.json`))
      const command = await store.transaction(l => { const c = l.commands.find(c => c.commandId === commandId && c.principal === DEVICE_HOST_PRINCIPAL)!; this.assertManualCandidate(c, l.devices, l.grants); return c }, false)
      // Bounded memory. Expired challenges cannot authorize a later management action.
      for (const [id, challenge] of this.manualChallenges) if (challenge.expiresAt <= Date.now()) this.manualChallenges.delete(id)
      if (this.manualChallenges.size >= 100) throw new Error('DEVICE_MANUAL_PREVIEW_CAPACITY')
      const challengeId = randomUUID(), expiresAt = Date.now() + 120000
      this.manualChallenges.set(challengeId, { binding, commandId, mode, digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), epoch: this.generation, expiresAt, deviceId: command.request.deviceId })
      return { challengeId, expiresAt, acknowledgementVersion: 1, commandId, device: command.audit!.dispatch!.device, desiredState: command.request.desiredState, sentAt: command.sentAt ?? null, warning: '原命令执行结果仍未知。旧动作仍可能迟到；请现场核实具体设备当前安全并确认身份。设备ID和家庭标识不证明实物身份，无法确定对应设备时请取消。本操作仅人工解除此条隔离，不证明执行或停止，不重发、不恢复授权。设备接入保持关闭，后续连接、授权和新请求需另行进行。' }
    })
  }
  async confirmManualResolution(input: unknown, binding: string) {
    return this.serialize(async () => {
      await this.load(); this.claimHost()
      const value = z.object({ commandId: z.string().uuid(), challengeId: z.string().uuid(), deviceId: deviceIdSchema }).strict().parse(input)
      const challenge = this.manualChallenges.get(value.challengeId)
      if (!challenge || challenge.binding !== binding || challenge.commandId !== value.commandId || challenge.deviceId !== value.deviceId || challenge.expiresAt <= Date.now() || challenge.epoch !== this.generation) throw new Error('DEVICE_MANUAL_CONFIRMATION_INVALID')
      const store = new DeviceStore(join(this.directory, `${challenge.mode}-ledger.json`))
      if (challenge.eventId) {
        const eventId = challenge.eventId
        const committed = await store.transaction(l => l.commands.some(c => c.commandId === value.commandId && c.principal === DEVICE_HOST_PRINCIPAL && c.manualDisposition?.eventId === eventId), false)
        if (!committed) throw new Error('DEVICE_MANUAL_CONFIRMATION_INVALID')
        return this.status()
      }
      try {
        const eventId = randomUUID()
        await withQuiescentDevice(store.path, value.deviceId, () => store.transaction(l => {
          const command = l.commands.find(c => c.commandId === value.commandId && c.principal === DEVICE_HOST_PRINCIPAL)
          if (!command || createHash('sha256').update(JSON.stringify(command)).digest('hex') !== challenge.digest) throw new Error('DEVICE_MANUAL_PREVIEW_STALE')
          const device = this.assertManualCandidate(command, l.devices, l.grants)
          command.manualDisposition = { version: 1, eventId, at: Date.now(), source: 'trusted-local-admin', action: 'release-isolation', acknowledgementVersion: 1, commandFingerprint: command.fingerprint, device: structuredClone(device) }
        }))
        challenge.eventId = eventId
        return this.status()
      } catch (error) { if (!challenge.eventId) this.manualChallenges.delete(value.challengeId); throw error }
    })
  }
  async discover() { return this.serialize(async () => { await (await this.ensureBroker()).discover(); return this.status() }) }
  async enroll(input: unknown) {
    return this.serialize(async () => {
      const value = z.object({ deviceId: deviceIdSchema, roomId: deviceIdSchema.optional(), aliases: z.array(z.string().trim().min(1).max(160)).max(30).optional() }).strict().parse(input)
      await (await this.ensureBroker()).registry.enroll(value.deviceId, { ...(value.roomId ? { roomId: value.roomId } : {}), ...(value.aliases ? { aliases: value.aliases } : {}) })
      return this.status()
    })
  }
  async grant(input: unknown) {
    return this.serialize(async () => {
      const value = grantSchema.parse(input), broker = await this.ensureBroker()
      const device = await broker.registry.inspect(value.deviceId)
      // Only lights in the current limited adapters receive writes. No thermostat/heating/security grant path.
      if (!(device.deviceId === 'sim:light' && device.adapter === 'simulator') && !(device.adapter === 'home-assistant' && device.capabilities.every(c => ['power', 'brightness'].includes(c.kind)))) throw new Error('DEVICE_HOST_HIGH_RISK_UNSUPPORTED')
      for (const action of value.actions) if (!device.capabilities.some(c => c.kind === action && c.writable)) throw new Error('DEVICE_ACTION_UNSUPPORTED')
      await broker.registry.grant({ authorizationRef: `local-grant:${randomUUID()}`, principal: DEVICE_HOST_PRINCIPAL, deviceId: value.deviceId, actions: [...new Set(value.actions)], expiresAt: Date.now() + value.expiresInMinutes * 60000, limits: { brightness: { min: 0, max: value.brightnessMax } } })
      return this.status()
    })
  }
  async revoke(input: unknown) {
    return this.serialize(async () => {
      await this.load(); this.claimHost()
      const value = z.object({ authorizationRef: z.string().min(1).max(200) }).strict().parse(input)
      // Withdrawing authority does not require a gateway, token or enabled adapter.
      for (const mode of ['simulator', 'home-assistant']) {
        const path = join(this.directory, `${mode}-ledger.json`)
        try { await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
        await new DeviceStore(path).transaction(l => revokeDeviceGrants(l, grant => grant.principal === DEVICE_HOST_PRINCIPAL && grant.authorizationRef === value.authorizationRef, Date.now()))
      }
      return this.status()
    })
  }
  async activation(entryPoint: DeviceCommandSource['entryPoint'] = 'host-runtime'): Promise<CapabilityPackActivation> {
    await this.load()
    if (!this.config.enabled || this.config.mode === 'home-assistant' && !this.adapter) return { tools: [], instructions: ['Device Use is disabled or requires a local credential handoff. No real hardware is configured. Ask the user to open local Settings > Device Use; never claim a device action was performed.'] }
    const broker = await this.ensureBroker(), epoch = this.generation
    const base = await createDeviceCapabilityPack(broker, DEVICE_HOST_PRINCIPAL, { entryPoint }).activate({ workspaceRoot: '', config: {}, signal: new AbortController().signal })
    return { ...base, tools: base.tools.map(tool => ({ ...tool, execute: async (input, context) => {
      if (this.closed || !this.config.enabled || this.generation !== epoch) throw new Error('DEVICE_HOST_DISABLED_OR_CHANGED')
      const result = await tool.execute(input, context)
      if (tool.manifest.name !== 'device.list') return result
      const grants = await broker.registry.store.transaction(l => l.grants.filter(g => g.principal === DEVICE_HOST_PRINCIPAL && g.expiresAt > Date.now() && l.enrolled.includes(g.deviceId)), false)
      return { simulated: this.config.mode === 'simulator', realHardwareVerified: false, devices: result, grants }
    } })) }
  }
  async executeTool(name: string, input: unknown, context: ToolContext, epoch = this.epoch): Promise<unknown> {
    if (epoch !== this.epoch) throw new Error('DEVICE_HOST_DISABLED_OR_CHANGED')
    const activation = await this.activation('host-executor')
    // Activation may yield while settings rotate. Never give an old worker tools
    // created under the new generation, even when those tools are valid now.
    if (this.closed || epoch !== this.epoch) throw new Error('DEVICE_HOST_DISABLED_OR_CHANGED')
    const tool = activation.tools.find(t => t.manifest.name === name)
    if (!tool) throw new Error('DEVICE_TOOL_UNAVAILABLE')
    return tool.execute(tool.validateInput ? tool.validateInput(input) : input, context)
  }
  async close() {
    this.manualChallenges.clear(); this.closed = true; this.generation++; await this.tail.catch(() => {}); await this.recovering?.catch(() => {}); await this.broker?.close(); this.broker = undefined; await this.adapter?.close?.(); this.adapter = undefined; if (liveHosts.get(this.directory) === this) liveHosts.delete(this.directory)
  }
}
