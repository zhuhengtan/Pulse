import { deviceObservationSchema, type DeviceObservation } from './types.js'

export type DeviceEventGatewayStatus = 'syncing' | 'ready' | 'degraded' | 'closed'

/** Bounded observation cache. An overflow or disconnect invalidates live reads
 * until a complete snapshot is installed. No event text can execute a task. */
export class DeviceEventGateway {
  private cache = new Map<string, DeviceObservation>()
  private pending: DeviceObservation[] = []
  private listeners = new Set<(observation: DeviceObservation) => void>()
  private generation = 0
  status: DeviceEventGatewayStatus = 'syncing'
  constructor(readonly capacity = 256, readonly maxAgeMs = 30_000, private now = Date.now) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('INVALID_EVENT_GATEWAY_OPTIONS')
  }
  subscribe(listener: (observation: DeviceObservation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  beginSync(): number {
    if (this.status === 'closed') throw new Error('EVENT_GATEWAY_CLOSED')
    this.status = 'syncing'
    this.pending = []
    return ++this.generation
  }
  /** A generation prevents an older in-flight snapshot from clearing a newer gap. */
  completeSync(generation: number, snapshot: DeviceObservation[]): boolean {
    if (generation !== this.generation || this.status !== 'syncing') return false
    const buffered = this.pending
    this.pending = []
    this.cache.clear()
    for (const observation of snapshot) this.apply(observation)
    for (const observation of buffered) this.apply(observation)
    this.status = 'ready'
    return true
  }
  ingest(observation: DeviceObservation): boolean {
    if (this.status === 'closed' || this.status === 'degraded') return false
    if (!this.valid(observation)) return false
    if (this.status === 'syncing') {
      if (this.pending.length >= this.capacity) { this.invalidate(); return false }
      this.pending.push(structuredClone(observation))
      return true
    }
    return this.apply(observation)
  }
  invalidate(): void {
    if (this.status === 'closed') return
    this.status = 'degraded'
    this.pending = []
    ++this.generation
    // Preserve the physical observation time while making a connection gap visible
    // to the Broker. A gap must not leave a recently cached reading looking online.
    for (const [deviceId, previous] of this.cache) {
      const unavailable: DeviceObservation = { ...structuredClone(previous), availability: 'unavailable', source: 'event-gateway:resync-required' }
      this.cache.set(deviceId, unavailable)
      this.notify(unavailable)
    }
  }
  read(deviceId: string, requireFresh = true): DeviceObservation | undefined {
    const observation = this.cache.get(deviceId)
    if (!observation) return undefined
    if (requireFresh && (this.status !== 'ready' || observation.availability !== 'online' || this.now() - observation.observedAt > this.maxAgeMs)) return undefined
    return structuredClone(observation)
  }
  close(): void { this.status = 'closed'; this.pending = []; this.cache.clear(); this.listeners.clear(); ++this.generation }
  private valid(observation: DeviceObservation): boolean {
    return deviceObservationSchema.safeParse(observation).success && Number.isSafeInteger(observation.stateVersion) && observation.observedAt <= this.now() + 5_000
  }
  private notify(observation: DeviceObservation): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(observation)) } catch { /* A subscriber cannot break state ingestion. */ }
    }
  }
  private apply(observation: DeviceObservation): boolean {
    if (!this.valid(observation)) return false
    const previous = this.cache.get(observation.deviceId)
    if (previous && (observation.stateVersion <= previous.stateVersion || observation.observedAt < previous.observedAt)) return false
    const copy = structuredClone(observation)
    this.cache.set(copy.deviceId, copy)
    this.notify(copy)
    return true
  }
}
