import { setTimeout as sleep } from 'node:timers/promises'
import { deviceRecordSchema, assertDesiredState, type DeviceAdapter, type DeviceRecord, type DeviceObservation, type DeviceState } from './types.js'
export type SimulatorFault = 'offline' | 'reject' | 'no-change' | 'disconnect-after-send' | 'stale' | 'timeout'
/** Explicit offline simulator; it never connects to or pretends to be real hardware. */
export class SimulatedDeviceAdapter implements DeviceAdapter {
  readonly id = 'simulator'
  readonly calls: { commandId: string; deviceId: string; desiredState: DeviceState }[] = []
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly listeners = new Set<(observation: DeviceObservation) => void>()
  private readonly faults = new Map<string, SimulatorFault>()
  delayMs = 0
  constructor(private readonly now: () => number = Date.now) {
    const common = { adapter: this.id, homeId: 'simulation', roomId: 'living-room', aliases: [], availability: 'online' as const, observedAt: now(), stateVersion: 1 }
    for (const d of [
      { ...common, deviceId: 'sim:light', name: '客厅灯', capabilities: [{ kind: 'power' as const, readable: true, writable: true, confirmable: true }, { kind: 'brightness' as const, readable: true, writable: true, confirmable: true, min: 0, max: 100, unit: 'percent' as const }], state: { power: false, brightness: 0 } },
      { ...common, deviceId: 'sim:temperature', name: '客厅温度', capabilities: [{ kind: 'temperature_sensor' as const, readable: true, writable: false, confirmable: true, unit: 'celsius' as const }], state: { temperatureC: 23.5 } },
      { ...common, deviceId: 'sim:thermostat', name: '客厅空调', capabilities: [{ kind: 'power' as const, readable: true, writable: true, confirmable: true }, { kind: 'thermostat' as const, readable: true, writable: true, confirmable: true, min: 16, max: 30, step: 1, unit: 'celsius' as const, modes: ['cool', 'heat', 'auto', 'off'], fanModes: ['auto', 'low', 'high'] }], state: { power: false, targetTemperatureC: 26, mode: 'cool', fanMode: 'auto' } },
    ]) this.devices.set(d.deviceId, d)
  }
  /** Host-only restoration of simulated state. Never imports executable capabilities or identities. */
  hydrate(records: readonly DeviceRecord[]): void {
    for (const raw of records) {
      const record = deviceRecordSchema.parse(raw), existing = this.devices.get(record.deviceId)
      if (!existing || record.adapter !== this.id || record.homeId !== existing.homeId) throw new Error('DEVICE_SIMULATOR_IDENTITY')
      if (record.observedAt > this.now() + 5_000) throw new Error('DEVICE_OBSERVATION_FUTURE')
      existing.state = structuredClone(record.state); existing.stateVersion = record.stateVersion; existing.observedAt = record.observedAt
    }
  }
  fault(deviceId: string, fault?: SimulatorFault): void { if (fault) this.faults.set(deviceId, fault); else this.faults.delete(deviceId) }
  async discover(): Promise<DeviceRecord[]> { return structuredClone([...this.devices.values()]) }
  async read(device: DeviceRecord, signal?: AbortSignal): Promise<DeviceObservation> {
    signal?.throwIfAborted()
    const d = this.devices.get(device.deviceId); if (!d) throw new Error('DEVICE_NOT_FOUND')
    const fault = this.faults.get(d.deviceId)
    return { deviceId: d.deviceId, availability: fault === 'offline' ? 'offline' : 'online', observedAt: fault === 'stale' ? this.now() - 60_000 : this.now(), stateVersion: d.stateVersion, state: structuredClone(d.state), source: 'simulator' }
  }
  async set(device: DeviceRecord, desiredState: DeviceState, context: { commandId: string; deadline: number; signal?: AbortSignal }): Promise<{ status: 'sent' | 'rejected' }> {
    context.signal?.throwIfAborted(); assertDesiredState(device, desiredState)
    this.calls.push({ commandId: context.commandId, deviceId: device.deviceId, desiredState: structuredClone(desiredState) })
    const fault = this.faults.get(device.deviceId)
    if (fault === 'reject' || fault === 'offline') return { status: 'rejected' }
    if (fault === 'timeout') { await sleep(Math.max(1, context.deadline - this.now() + 50), undefined, context.signal ? { signal: context.signal } : undefined); return { status: 'sent' } }
    if (this.delayMs) await sleep(this.delayMs, undefined, context.signal ? { signal: context.signal } : undefined)
    const d = this.devices.get(device.deviceId)!
    if (fault !== 'no-change') { Object.assign(d.state, desiredState); d.stateVersion++; d.observedAt = this.now() }
    if (fault === 'disconnect-after-send') throw new Error('SIMULATED_CONNECTION_LOST')
    if (fault !== 'no-change') this.emit({ deviceId: d.deviceId, availability: d.availability, observedAt: d.observedAt, stateVersion: d.stateVersion, state: structuredClone(d.state), source: 'simulator' })
    return { status: 'sent' }
  }
  /** Inject duplicates, reordered observations and timestamps explicitly in tests. */
  emit(observation: DeviceObservation): void { for (const listener of this.listeners) listener(structuredClone(observation)) }
  subscribe(listener: (observation: DeviceObservation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async close(): Promise<void> { this.listeners.clear() }
}
