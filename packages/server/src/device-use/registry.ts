import { appendPermissionEvent, auditCapacity, MAX_DEVICE_PERMISSION_EVENTS, revokeDeviceGrants } from './audit.js'
import { deviceRecordSchema, deviceObservationSchema, assertDesiredState, type DeviceRecord, type DeviceObservation, type DeviceGrant, type DeviceState } from './types.js'
import { DeviceStore, type DeviceScene, type DeviceLedger } from './store.js'

/** Host-only enrollment and grants. None of these mutations are model tools. */
export class DeviceRegistry {
  constructor(readonly store: DeviceStore, readonly now: () => number = Date.now, readonly auditOptions: { maxPermissionEvents?: number } = {}) { auditCapacity(auditOptions.maxPermissionEvents, MAX_DEVICE_PERMISSION_EVENTS) }
  async discover(records: DeviceRecord[]): Promise<void> {
    const parsed = records.map(record => deviceRecordSchema.parse(record))
    if (parsed.some(record => record.observedAt > this.now() + 5_000 || new Set(record.capabilities.map(c => c.kind)).size !== record.capabilities.length)) throw new Error('DEVICE_INVALID_DISCOVERY')
    if (new Set(parsed.map(d => d.deviceId)).size !== parsed.length) throw new Error('DEVICE_DUPLICATE_ID')
    await this.store.transaction(ledger => {
      for (const record of parsed) {
        const index = ledger.devices.findIndex(d => d.deviceId === record.deviceId)
        const previous = ledger.devices[index]
        if (previous && (previous.adapter !== record.adapter || previous.homeId !== record.homeId)) throw new Error('DEVICE_IDENTITY_CHANGED')
        if (previous && (previous.stateVersion > record.stateVersion || previous.observedAt > record.observedAt)) ledger.devices[index] = { ...record, ...(ledger.enrolled.includes(record.deviceId) ? { roomId: previous.roomId, aliases: previous.aliases } : {}), state: previous.state, stateVersion: previous.stateVersion, observedAt: previous.observedAt, availability: previous.availability }
        else if (index < 0) ledger.devices.push(record)
        else ledger.devices[index] = { ...record, ...(previous && ledger.enrolled.includes(record.deviceId) ? { roomId: previous.roomId, aliases: previous.aliases } : {}) }
      }
    })
  }
  async list(): Promise<(DeviceRecord & { enrolled: boolean; stale: boolean })[]> {
    return this.store.transaction(l => l.devices.map(d => ({ ...d, enrolled: l.enrolled.includes(d.deviceId), stale: d.availability !== 'online' || this.now() - d.observedAt > 30_000 })), false)
  }
  async inspect(deviceId: string): Promise<DeviceRecord> {
    return this.store.transaction(l => { const d = l.devices.find(d => d.deviceId === deviceId); if (!d) throw new Error('DEVICE_NOT_FOUND'); return d }, false)
  }
  async resolve(reference: string, roomId?: string): Promise<DeviceRecord> {
    const devices = await this.list()
    const exact = devices.find(d => d.deviceId === reference)
    if (exact && (!roomId || roomId === exact.roomId)) return exact
    const matches = devices.filter(d => (!roomId || d.roomId === roomId) && [d.name, ...d.aliases].includes(reference))
    if (matches.length !== 1) throw new Error(matches.length ? 'DEVICE_AMBIGUOUS' : 'DEVICE_NOT_FOUND')
    return matches[0]!
  }
  async enroll(deviceId: string, options?: { roomId?: string; aliases?: string[] }): Promise<void> {
    await this.store.transaction(l => {
      const d = l.devices.find(d => d.deviceId === deviceId); if (!d) throw new Error('DEVICE_NOT_FOUND')
      const next = deviceRecordSchema.parse({ ...d, ...options }); Object.assign(d, next)
      if (!l.enrolled.includes(deviceId)) l.enrolled.push(deviceId)
    })
  }
  async grant(grant: DeviceGrant): Promise<void> {
    await this.store.transaction(l => {
      if (!l.enrolled.includes(grant.deviceId)) throw new Error('DEVICE_NOT_ENROLLED')
      if (!grant.principal || !grant.authorizationRef || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.now() || !grant.actions.length || grant.actions.includes('temperatureC')) throw new Error('DEVICE_INVALID_GRANT')
      const current = l.grants.find(g => g.authorizationRef === grant.authorizationRef)
      if (current && (current.deviceId !== grant.deviceId || current.principal !== grant.principal)) throw new Error('DEVICE_GRANT_IDENTITY_CHANGED')
      appendPermissionEvent(l, 'grant', grant, this.now(), this.auditOptions.maxPermissionEvents)
      l.grants = l.grants.filter(g => g.authorizationRef !== grant.authorizationRef); l.grants.push(structuredClone(grant))
    })
  }
  async revoke(authorizationRef: string): Promise<void> { await this.store.transaction(l => { revokeDeviceGrants(l, grant => grant.authorizationRef === authorizationRef, this.now()) }) }
  async authorize(principal: string, deviceId: string, desired: DeviceState, ref: string): Promise<DeviceGrant> {
    return this.store.transaction(l => assertDeviceGrant(l, this.now(), principal, deviceId, desired, ref), false)
  }

  async observe(raw: DeviceObservation): Promise<boolean> {
    const observation = deviceObservationSchema.parse(raw)
    if (observation.observedAt > this.now() + 5_000) throw new Error('DEVICE_OBSERVATION_FUTURE')
    return this.store.transaction(l => {
      const device = l.devices.find(d => d.deviceId === observation.deviceId)
      if (!device) throw new Error('DEVICE_NOT_FOUND')
      if (observation.stateVersion < device.stateVersion || observation.observedAt < device.observedAt) return false
      if (observation.stateVersion === device.stateVersion && JSON.stringify(observation.state) !== JSON.stringify(device.state)) return false
      Object.assign(device, { state: observation.state, observedAt: observation.observedAt, stateVersion: observation.stateVersion, availability: observation.availability }); return true
    })
  }
  async registerScene(scene: DeviceScene): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(scene.sceneId) || !scene.steps.length || scene.steps.length > 32) throw new Error('DEVICE_INVALID_SCENE')
    for (const step of scene.steps) assertDesiredState(await this.inspect(step.deviceId), step.desiredState)
    await this.store.transaction(l => { l.scenes = l.scenes.filter(s => s.sceneId !== scene.sceneId); l.scenes.push(structuredClone(scene)) })
  }
}

/** Synchronous check allows grant validation and the dispatch WAL transition to be atomic. */
export function assertDeviceGrant(l: DeviceLedger, now: number, principal: string, deviceId: string, desired: DeviceState, ref: string): DeviceGrant {
  const device = l.devices.find(d => d.deviceId === deviceId)
  if (!device || !l.enrolled.includes(deviceId)) throw new Error('DEVICE_NOT_ENROLLED')
  assertDesiredState(device, desired)
  const grant = l.grants.find(g => g.authorizationRef === ref && g.deviceId === deviceId && g.principal === principal && g.expiresAt > now)
  if (!grant || Object.keys(desired).some(k => !grant.actions.includes(k as keyof DeviceState))) throw new Error('DEVICE_NOT_AUTHORIZED')
  for (const key of ['brightness', 'targetTemperatureC'] as const) { const value = desired[key], limit = grant.limits?.[key]; if (value !== undefined && limit && (value < limit.min || value > limit.max)) throw new Error('DEVICE_GRANT_LIMIT') }
  return grant
}
