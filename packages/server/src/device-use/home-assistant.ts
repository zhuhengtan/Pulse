import WebSocket from 'ws'
import { DeviceEventGateway } from './event-gateway.js'
import type { DeviceAdapter, DeviceCapability, DeviceObservation, DeviceRecord, DeviceState } from './types.js'

export interface HomeAssistantEntity {
  entityId: string
  deviceId?: string
  name?: string
  roomId?: string
  /** Adapter allowlist only. Broker authorization is still required. */
  writable?: boolean
}
export interface HomeAssistantSocket {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: any[]) => void): unknown
  send(data: string): void
  close(): void
}
export interface HomeAssistantOptions {
  id?: string
  homeId: string
  baseUrl: string
  entities: HomeAssistantEntity[]
  /** Host-owned provider. Never put credentials in a tool argument or registry. */
  getAccessToken: () => Promise<string>
  allowInsecureLocalHttp?: boolean
  /** Trusted host assertion of HA's displayed system unit for legacy climate
   * states before Core 2026.11 that omit temperature_unit. Core 2026.11+ supplies
   * the displayed unit in each climate state. Never inferred from locale or model
   * input; no extra account/config request is made. */
  climateTemperatureUnit?: 'celsius' | 'fahrenheit'
  fetch?: typeof fetch
  socketFactory?: (url: string) => HomeAssistantSocket
  requestTimeoutMs?: number
  eventCapacity?: number
  maxStateAgeMs?: number
  now?: () => number
}
interface HaState {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_updated: string
  last_reported?: string
}
class HaRequestError extends Error {
  constructor(readonly status?: number) { super(status ? `HA_HTTP_${status}` : 'HA_TRANSPORT_ERROR') }
}

/** Restricted HA adapter: explicit entity allowlist, read-only by default, and
 * target-state light services only. Construction never connects or saves secrets. */
export class HomeAssistantAdapter implements DeviceAdapter {
  readonly id: string
  readonly confirmationEvidence = 'gateway-state' as const
  readonly events: DeviceEventGateway
  private readonly base: URL
  private readonly entities = new Map<string, HomeAssistantEntity>()
  private readonly byDevice = new Map<string, HomeAssistantEntity>()
  private readonly revisions = new Map<string, number>()
  private readonly latestStates = new Map<string, HaState>()
  private readonly now: () => number
  private readonly requestTimeoutMs: number
  private readonly climateTemperatureUnit: 'celsius' | 'fahrenheit' | undefined
  private socket: HomeAssistantSocket | undefined
  private eventRun: Promise<void> | undefined
  private stopEventRun: (() => void) | undefined
  private closed = false
  constructor(private readonly options: HomeAssistantOptions) {
    this.id = options.id ?? 'home-assistant'
    this.now = options.now ?? Date.now
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    if (options.climateTemperatureUnit !== undefined && !['celsius', 'fahrenheit'].includes(options.climateTemperatureUnit)) throw new Error('INVALID_HA_CLIMATE_TEMPERATURE_UNIT')
    this.climateTemperatureUnit = options.climateTemperatureUnit
    if (!this.id || !options.homeId || !Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) throw new Error('INVALID_HA_OPTIONS')
    this.base = new URL(options.baseUrl)
    const local = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[^/]+\.local)$/.test(this.base.hostname)
    if (this.base.username || this.base.password || this.base.search || this.base.hash || !['', '/'].includes(this.base.pathname) || (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && options.allowInsecureLocalHttp && local))) throw new Error('INVALID_HA_BASE_URL')
    if (!options.entities.length) throw new Error('HA_ENTITY_ALLOWLIST_REQUIRED')
    for (const input of options.entities) {
      const entity = { ...input }
      if (!/^(light|sensor|climate)\.[a-z0-9_]+$/.test(entity.entityId)) throw new Error('HA_UNSUPPORTED_ENTITY')
      const deviceId = this.deviceId(entity)
      if (this.entities.has(entity.entityId) || this.byDevice.has(deviceId)) throw new Error('HA_DUPLICATE_ENTITY')
      this.entities.set(entity.entityId, entity)
      this.byDevice.set(deviceId, entity)
    }
    this.events = new DeviceEventGateway(options.eventCapacity ?? 256, options.maxStateAgeMs ?? 30_000, this.now)
  }
  subscribe(listener: (observation: DeviceObservation) => void): () => void { return this.events.subscribe(listener) }
  async discover(signal?: AbortSignal): Promise<DeviceRecord[]> {
    this.ensureOpen()
    const records: DeviceRecord[] = []
    for (const entity of this.entities.values()) {
      const raw = await this.getState(entity, signal)
      records.push(this.record(entity, raw, this.observation(entity, raw, false)))
    }
    return records
  }
  async read(device: DeviceRecord, signal?: AbortSignal): Promise<DeviceObservation> {
    const entity = this.entityFor(device)
    const raw = await this.getState(entity, signal)
    return this.observation(entity, raw, false)
  }
  async set(device: DeviceRecord, desiredState: DeviceState, context: { commandId: string; deadline: number; signal?: AbortSignal }): Promise<{ status: 'sent' | 'rejected'; reason?: string }> {
    const entity = this.entityFor(device)
    if (context.deadline <= this.now() || context.signal?.aborted) return { status: 'rejected', reason: 'HA_COMMAND_EXPIRED_OR_CANCELLED' }
    const keys = Object.keys(desiredState)
    if (!entity.writable || !entity.entityId.startsWith('light.')) return { status: 'rejected', reason: 'HA_ENTITY_READ_ONLY' }
    if (!keys.length || keys.some(key => key !== 'power' && key !== 'brightness') || ('power' in desiredState && typeof desiredState.power !== 'boolean') || ('brightness' in desiredState && (!Number.isFinite(desiredState.brightness) || desiredState.brightness! < 0 || desiredState.brightness! > 100)) || ((desiredState.power === false && desiredState.brightness !== undefined && desiredState.brightness > 0) || (desiredState.power === true && desiredState.brightness === 0))) return { status: 'rejected', reason: 'HA_UNSUPPORTED_DESIRED_STATE' }
    if (desiredState.brightness !== undefined && !device.capabilities.some(cap => cap.kind === 'brightness' && cap.writable)) return { status: 'rejected', reason: 'HA_BRIGHTNESS_UNSUPPORTED' }
    const off = desiredState.power === false || desiredState.brightness === 0
    const body: Record<string, unknown> = { entity_id: entity.entityId }
    if (!off && desiredState.brightness !== undefined) body.brightness_pct = desiredState.brightness
    try {
      // A request attempted once can have executed even if the response is lost.
      await this.request(`/api/services/light/${off ? 'turn_off' : 'turn_on'}`, 'POST', body, context.signal, context.deadline)
      return { status: 'sent' }
    } catch (error) {
      // Only explicit input/auth rejections prove non-execution. 5xx/timeout stay unknown.
      if (error instanceof HaRequestError && [400, 401, 403, 404, 405, 422].includes(error.status ?? 0)) return { status: 'rejected', reason: error.message }
      throw new Error('HA_COMMAND_OUTCOME_UNKNOWN')
    }
  }
  /** Explicitly starts server-filtered entity events. Reinvoke after a disconnect.
   * Only subscribe_entities with the exact nonempty allowlist is allowed; unsupported
   * servers fail closed. Compressed updates are hints for scoped REST reads, never
   * permission to subscribe to the household event bus. */
  startEvents(): Promise<void> {
    this.ensureOpen()
    if (this.eventRun) return this.eventRun
    this.eventRun = this.openEvents().catch(error => { this.eventRun = undefined; throw error })
    return this.eventRun
  }
  async close(): Promise<void> {
    this.closed = true
    this.stopEventRun?.()
    this.socket?.close()
    this.socket = undefined
    this.eventRun = undefined
    this.events.close()
  }
  private async openEvents(): Promise<void> {
    const generation = this.events.beginSync()
    const token = await this.token()
    if (this.closed) throw new Error('HA_ADAPTER_CLOSED')
    const url = new URL('/api/websocket', this.base); url.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = this.options.socketFactory?.(url.href) ?? new WebSocket(url, { followRedirects: false, maxPayload: 1_048_576 })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let settled = false, subscribed = false, authenticated = false, snapshotStarted = false
      let queuedRefreshes = 0
      let refreshTail = Promise.resolve()
      const timeout = setTimeout(() => fail('HA_EVENT_SYNC_TIMEOUT'), this.requestTimeoutMs)
      timeout.unref?.()
      const fail = (reason: string) => {
        if (this.socket !== socket) return
        clearTimeout(timeout)
        this.events.invalidate()
        this.eventRun = undefined
        if (this.socket === socket) this.socket = undefined
        if (!settled) { settled = true; reject(new Error(reason)) }
        socket.close()
      }
      this.stopEventRun = () => fail('HA_ADAPTER_CLOSED')
      socket.on('error', () => fail('HA_EVENT_TRANSPORT_ERROR'))
      socket.on('close', () => {
        if (this.socket !== socket) return
        clearTimeout(timeout); this.events.invalidate(); this.eventRun = undefined
        if (this.socket === socket) this.socket = undefined
        if (!settled) { settled = true; reject(new Error('HA_EVENT_DISCONNECTED')) }
      })
      socket.on('message', (data: unknown) => {
        if (this.socket !== socket || this.closed) return
        void (async () => {
          const text = String(data)
          if (Buffer.byteLength(text) > 1_048_576) { fail('HA_EVENT_TOO_LARGE'); return }
          const message = JSON.parse(text) as Record<string, any>
          if (message.type === 'auth_required' && !authenticated) { authenticated = true; socket.send(JSON.stringify({ type: 'auth', access_token: token })); return }
          if (message.type === 'auth_invalid') { fail('HA_AUTH_REJECTED'); return }
          if (message.type === 'auth_ok' && authenticated && !subscribed) { subscribed = true; socket.send(JSON.stringify({ id: 1, type: 'subscribe_entities', entity_ids: [...this.entities.keys()] })); return }
          if (message.type === 'result' && message.id === 1 && subscribed && !snapshotStarted) {
            snapshotStarted = true
            if (!message.success) { fail('HA_EVENT_SUBSCRIPTION_REJECTED'); return }
            const snapshot: DeviceObservation[] = []
            for (const entity of this.entities.values()) snapshot.push(this.observation(entity, await this.getState(entity), false))
            if (!this.events.completeSync(generation, snapshot)) { fail('HA_EVENT_RESYNC_REQUIRED'); return }
            clearTimeout(timeout)
            if (!settled) { settled = true; resolve() }
            return
          }
          if (message.type === 'event' && message.id === 1 && subscribed) {
            // HA subscribe_entities sends compressed additions/changes/removals.
            // Treat them only as entity-scoped invalidation hints: get the precise
            // full state and last_reported timestamp from the fixed REST endpoint.
            const update = message.event
            if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).some(key => !['a', 'c', 'r'].includes(key))) { fail('HA_EVENT_INVALID_FORMAT'); return }
            const ids = new Set<string>()
            for (const key of ['a', 'c']) {
              if (update[key] === undefined) continue
              if (!update[key] || typeof update[key] !== 'object' || Array.isArray(update[key])) { fail('HA_EVENT_INVALID_FORMAT'); return }
              for (const entityId of Object.keys(update[key])) ids.add(entityId)
            }
            if (update.r !== undefined) {
              if (!Array.isArray(update.r) || update.r.some((id: unknown) => typeof id !== 'string')) { fail('HA_EVENT_INVALID_FORMAT'); return }
              for (const entityId of update.r) ids.add(entityId)
            }
            // No broad-subscription fallback, even if a server ignores the filter.
            if ([...ids].some(id => !this.entities.has(id))) { fail('HA_EVENT_SCOPE_VIOLATION'); return }
            if (update.r?.length) { fail('HA_ENTITY_REMOVED_RESYNC_REQUIRED'); return }
            if (queuedRefreshes + ids.size > (this.options.eventCapacity ?? 256)) { fail('HA_EVENT_RESYNC_REQUIRED'); return }
            for (const entityId of ids) {
              const entity = this.entities.get(entityId)!
              ++queuedRefreshes
              refreshTail = refreshTail.then(async () => {
                if (this.socket !== socket || this.closed) return
                const raw = await this.getState(entity)
                if (this.socket !== socket || this.closed) return
                const observation = this.observation(entity, raw, true)
                if (observation) this.events.ingest(observation)
                if (this.events.status === 'degraded') fail('HA_EVENT_RESYNC_REQUIRED')
              }).catch(() => fail('HA_EVENT_INVALID_OR_SYNC_FAILED')).finally(() => { --queuedRefreshes })
            }
          }
        })().catch(() => fail('HA_EVENT_INVALID_OR_SYNC_FAILED'))
      })
    })
  }
  private ensureOpen(): void { if (this.closed) throw new Error('HA_ADAPTER_CLOSED') }
  private entityFor(device: DeviceRecord): HomeAssistantEntity {
    this.ensureOpen()
    const entity = this.byDevice.get(device.deviceId)
    if (device.adapter !== this.id || !entity) throw new Error('HA_DEVICE_NOT_ALLOWLISTED')
    return entity
  }
  private deviceId(entity: HomeAssistantEntity): string { return entity.deviceId ?? `${this.id}:${this.options.homeId}:${entity.entityId}` }
  private async token(): Promise<string> {
    let token: string
    try { token = await this.options.getAccessToken() } catch { throw new Error('HA_CREDENTIAL_UNAVAILABLE') }
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('HA_CREDENTIAL_UNAVAILABLE')
    return token
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal, deadline?: number): Promise<unknown> {
    this.ensureOpen()
    const token = await this.token()
    const remaining = Math.min(this.requestTimeoutMs, (deadline ?? Infinity) - this.now())
    if (remaining <= 0 || signal?.aborted) throw new HaRequestError()
    const abort = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.base), {
      method, redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, abort]) : abort,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new HaRequestError(response.status)
    if (!response.body) return undefined
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        size += value.byteLength
        if (size > 1_048_576) { await reader.cancel(); throw new Error('HA_RESPONSE_TOO_LARGE') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : undefined
  }
  private async getState(entity: HomeAssistantEntity, signal?: AbortSignal): Promise<HaState> {
    return this.parseState(await this.request(`/api/states/${entity.entityId}`, 'GET', undefined, signal), entity)
  }
  private parseState(value: unknown, entity: HomeAssistantEntity): HaState {
    if (!value || typeof value !== 'object') throw new Error('HA_INVALID_STATE')
    const raw = value as HaState
    if (raw.entity_id !== entity.entityId || typeof raw.state !== 'string' || !raw.attributes || typeof raw.attributes !== 'object' || Array.isArray(raw.attributes) || typeof raw.last_updated !== 'string' || !Number.isFinite(Date.parse(raw.last_updated))) throw new Error('HA_INVALID_STATE')
    return raw
  }
  private observation(entity: HomeAssistantEntity, raw: HaState, event: true): DeviceObservation | undefined
  private observation(entity: HomeAssistantEntity, raw: HaState, event: false): DeviceObservation
  private observation(entity: HomeAssistantEntity, raw: HaState, event: boolean): DeviceObservation | undefined {
    const previous = this.revisions.get(entity.entityId)
    let cached = false
    const micros = /\.(\d+)/.exec(raw.last_updated)?.[1]?.padEnd(6, '0').slice(3, 6) ?? '000'
    const revision = Date.parse(raw.last_updated) * 1_000 + Number(micros)
    if (!Number.isSafeInteger(revision) || revision < 0 || revision / 1_000 > this.now() + 5_000) throw new Error('HA_INVALID_STATE_VERSION')
    if (event && previous !== undefined && revision <= previous) return undefined
    // A stale REST response cannot replace a newer event already received.
    const newer = previous === undefined || revision > previous
    if (newer || (!event && revision === previous)) { this.revisions.set(entity.entityId, revision); this.latestStates.set(entity.entityId, structuredClone(raw)) }
    else if (!event) { raw = this.latestStates.get(entity.entityId) ?? raw; cached = true }
    const state: DeviceState = {}
    const domain = entity.entityId.split('.')[0]
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    if (domain === 'light' && ['on', 'off'].includes(raw.state)) {
      state.power = raw.state === 'on'
      if (raw.state === 'off') state.brightness = 0
      else if (finite(raw.attributes.brightness) && raw.attributes.brightness >= 0 && raw.attributes.brightness <= 255) state.brightness = Math.round(raw.attributes.brightness / 255 * 100)
    }
    if (domain === 'sensor' && raw.attributes.device_class === 'temperature' && raw.state.trim() !== '') {
      const value = Number(raw.state), unit = raw.attributes.unit_of_measurement
      if (Number.isFinite(value) && ['°C', '°F'].includes(String(unit))) state.temperatureC = unit === '°F' ? (value - 32) * 5 / 9 : value
    }
    if (domain === 'climate') {
      if (raw.state !== 'unknown' && raw.state !== 'unavailable') { state.mode = raw.state; state.power = raw.state !== 'off' }
      const unit = this.climateUnit(raw)
      // HA climate values use the displayed system unit. Core 2026.11+ supplies
      // temperature_unit; legacy states can use an explicit host assertion only.
      // Unknown/conflicting units must never default to Celsius.
      if (unit && finite(raw.attributes.current_temperature)) state.temperatureC = unit === 'fahrenheit' ? (raw.attributes.current_temperature - 32) * 5 / 9 : raw.attributes.current_temperature
      if (unit && finite(raw.attributes.temperature)) state.targetTemperatureC = unit === 'fahrenheit' ? (raw.attributes.temperature - 32) * 5 / 9 : raw.attributes.temperature
      if (typeof raw.attributes.fan_mode === 'string') state.fanMode = raw.attributes.fan_mode
    }
    // HA microsecond timestamps are stable across host restarts, unlike a process-local counter.
    const stateVersion = this.revisions.get(entity.entityId) ?? revision
    const reported = raw.last_reported ? Date.parse(raw.last_reported) : Date.parse(raw.last_updated)
    if (!Number.isFinite(reported) || reported > this.now() + 5_000) throw new Error('HA_INVALID_OBSERVATION_TIME')
    return { deviceId: this.deviceId(entity), availability: raw.state === 'unavailable' ? 'offline' : raw.state === 'unknown' ? 'unavailable' : 'online', observedAt: reported, stateVersion, state, source: cached ? 'home-assistant:cache' : 'home-assistant:state' }
  }
  private climateUnit(raw: HaState): 'celsius' | 'fahrenheit' | undefined {
    const marker = raw.attributes.temperature_unit
    const explicit = marker === '°C' ? 'celsius' : marker === '°F' ? 'fahrenheit' : undefined
    // An explicit but invalid/conflicting marker is an error in evidence, not
    // permission to silently substitute the configured unit.
    if (marker !== undefined && (!explicit || (this.climateTemperatureUnit && explicit !== this.climateTemperatureUnit))) return undefined
    return explicit ?? this.climateTemperatureUnit
  }
  private record(entity: HomeAssistantEntity, raw: HaState, observation: DeviceObservation): DeviceRecord {
    const capabilities: DeviceCapability[] = []
    // HA state objects (including optimistic/retained values) are gateway evidence,
    // not a command-correlated physical device acknowledgement.
    const readonly = { readable: true, writable: false, confirmable: false }
    if (entity.entityId.startsWith('light.')) {
      capabilities.push({ kind: 'power', ...readonly, writable: entity.writable === true })
      const modes = raw.attributes.supported_color_modes
      if (Array.isArray(modes) && modes.some(mode => ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'].includes(String(mode)))) capabilities.push({ kind: 'brightness', ...readonly, writable: entity.writable === true, min: 0, max: 100, step: 1, unit: 'percent' })
    }
    if (entity.entityId.startsWith('sensor.') && raw.attributes.device_class === 'temperature' && ['°C', '°F'].includes(String(raw.attributes.unit_of_measurement))) capabilities.push({ kind: 'temperature_sensor', ...readonly, unit: 'celsius' })
    // Climate remains read-only until a concrete model's ranges/modes are verified.
    if (entity.entityId.startsWith('climate.')) capabilities.push({ kind: 'thermostat', ...readonly, ...(this.climateUnit(raw) ? { unit: 'celsius' as const } : {}) })
    const { source: _source, ...fields } = observation
    return { ...fields, adapter: this.id, homeId: this.options.homeId, roomId: entity.roomId ?? 'unassigned', name: entity.name ?? entity.entityId, aliases: [], capabilities }
  }
}
