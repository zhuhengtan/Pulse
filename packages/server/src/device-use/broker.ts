import { hasManualIsolationRelease, auditCapacity, commandAudit, MAX_DEVICE_COMMANDS } from './audit.js'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { DeviceRegistry, assertDeviceGrant } from './registry.js'
import { commandRequestSchema, stateMatches, type DeviceAdapter, type DeviceCommand, type DeviceCommandRequest, type DeviceObservation, type DeviceState, type DeviceCommandSource } from './types.js'

const locks = new Map<string, Promise<unknown>>()
const inFlight = new Set<string>()
/** Host management only. Refuse rather than wait behind an unsettled send. */
export async function withQuiescentDevice<T>(storePath: string, deviceId: string, work: () => Promise<T>): Promise<T> {
  const key = `${storePath}:${deviceId}`
  if (inFlight.has(key) || locks.has(key)) throw new Error('DEVICE_MANUAL_DISPATCH_NOT_QUIESCENT')
  const operation = Promise.resolve().then(() => { if (inFlight.has(key)) throw new Error('DEVICE_MANUAL_DISPATCH_NOT_QUIESCENT'); return work() })
  locks.set(key, operation)
  try { return await operation } finally { if (locks.get(key) === operation) locks.delete(key) }
}
export interface DeviceBrokerOptions {
  /** Host-only bounded storage and provenance. Neither is a model tool argument. */
  maxCommands?: number
  hostIdentity?: { instanceId: string; epoch: number }
  canDispatch?: () => boolean
  now?: () => number; maxAgeMs?: number; readTimeoutMs?: number; pollIntervalMs?: number; confirmationWindowMs?: number
  /** Trusted host verifier. Never pass a boolean supplied by the model. Called again immediately before dispatch. */
  confirm?: (input: { principal: string; request: DeviceCommandRequest; commandId: string }) => Promise<boolean>
}
export type DeviceReconciliationOutcome = 'not-pending' | 'not-sent' | 'unconfirmable' | 'offline' | 'stale' | 'read-timeout' | 'read-failed' | 'state-mismatch' | 'connection-unverified' | 'state-match-unverified' | 'manually-released' | 'observed'
export interface DeviceReconciliationResult { command: DeviceCommand; outcome: DeviceReconciliationOutcome }
export class DeviceBroker {
  private readonly brokerId = randomUUID()
  private readonly adapters = new Map<string, DeviceAdapter>()
  private readonly subscriptions: (() => void)[] = []
  private disposed = false
  private readonly now: () => number
  constructor(readonly registry: DeviceRegistry, adapters: DeviceAdapter[], private readonly options: DeviceBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    auditCapacity(options.maxCommands, MAX_DEVICE_COMMANDS)
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error('DEVICE_ADAPTER_DUPLICATE')
      this.adapters.set(adapter.id, adapter)
      if (adapter.subscribe) this.subscriptions.push(adapter.subscribe(observation => { void this.observeFromAdapter(adapter.id, observation).catch(() => { /* Invalid/untrusted events never confirm commands. Reads reconcile explicitly. */ }) }))
    }
  }
  async discover(signal?: AbortSignal): Promise<void> {
    for (const adapter of this.adapters.values()) {
      const records = await adapter.discover(signal)
      if (records.some(d => d.adapter !== adapter.id)) throw new Error('DEVICE_ADAPTER_IDENTITY')
      await this.registry.discover(records)
    }
  }
  async read(deviceId: string, signal?: AbortSignal): Promise<DeviceObservation & { stale: boolean }> {
    const device = await this.registry.inspect(deviceId)
    const adapter = this.adapters.get(device.adapter); if (!adapter) throw new Error('DEVICE_ADAPTER_UNAVAILABLE')
    const timeoutController = new AbortController()
    const readSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    const timeout = setTimeout(() => timeoutController.abort(), this.options.readTimeoutMs ?? 5_000)
    let raw: DeviceObservation
    try {
      raw = await new Promise<DeviceObservation>((resolve, reject) => {
        const abort = () => reject(new Error('DEVICE_READ_TIMEOUT'))
        readSignal.addEventListener('abort', abort, { once: true })
        if (readSignal.aborted) abort()
        void Promise.resolve().then(() => adapter.read(device, readSignal)).then(resolve, reject).finally(() => readSignal.removeEventListener('abort', abort)).catch(() => {})
      })
    } catch (error) { throw new Error(error instanceof Error && error.message === 'DEVICE_READ_TIMEOUT' ? 'DEVICE_READ_TIMEOUT' : 'DEVICE_ADAPTER_READ_FAILED') } finally { clearTimeout(timeout) }
    if (raw.deviceId !== deviceId) throw new Error('DEVICE_OBSERVATION_IDENTITY')
    let accepted: boolean
    try { accepted = await this.registry.observe(raw) } catch { throw new Error('DEVICE_OBSERVATION_INVALID') }
    const observation = accepted ? raw : { ...await this.registry.inspect(deviceId), source: 'registry-cache' }
    return { deviceId: observation.deviceId, availability: observation.availability, observedAt: observation.observedAt, stateVersion: observation.stateVersion, state: observation.state, source: observation.source, stale: !accepted || observation.source === 'home-assistant:cache' || observation.availability !== 'online' || this.now() - observation.observedAt > (this.options.maxAgeMs ?? 30_000) }
  }
  async set(principal: string, raw: DeviceCommandRequest, signal?: AbortSignal, source?: DeviceCommandSource): Promise<DeviceCommand> {
    if (this.disposed) throw new Error('DEVICE_BROKER_CLOSED')
    const request = commandRequestSchema.parse(raw)
    if (!principal || request.deadline > this.now() + 120_000) throw new Error('DEVICE_INVALID_REQUEST')
    const fingerprint = createHash('sha256').update(JSON.stringify({ principal, request: { ...request, desiredState: Object.fromEntries(Object.entries(request.desiredState).sort(([a], [b]) => a.localeCompare(b))) } })).digest('hex')
    // Dedup happens before grant validation so a revoked grant cannot cause a replay.
    const accepted = await this.registry.store.transaction(l => {
      const old = l.commands.find(c => c.principal === principal && c.request.requestId === request.requestId)
      if (old) { if (old.fingerprint !== fingerprint) throw new Error('DEVICE_REQUEST_ID_CONFLICT'); return { command: old, fresh: false } }
      if (l.commands.length >= auditCapacity(this.options.maxCommands, MAX_DEVICE_COMMANDS)) throw new Error('DEVICE_COMMAND_AUDIT_CAPACITY')
      const at = this.now()
      const grant = l.grants.find(g => g.authorizationRef === request.authorizationRef && g.deviceId === request.deviceId && g.principal === principal)
      const audit = commandAudit(this.brokerId, at, grant, source, this.options.hostIdentity)
      const command: DeviceCommand = { commandId: randomUUID(), principal, request, fingerprint, createdAt: at, updatedAt: at, status: 'accepted', audit, timeline: [{ status: 'accepted', at }] }
      l.commands.push(command); return { command, fresh: true }
    })
    if (!accepted.fresh) return accepted.command
    const key = `${this.registry.store.path}:${request.deviceId}`
    const previous = locks.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.execute(accepted.command, key, signal))
    locks.set(key, operation)
    try { return await operation } finally { if (locks.get(key) === operation) locks.delete(key) }
  }
  private async update(id: string, status: DeviceCommand['status'], reason?: string, evidence?: DeviceObservation): Promise<DeviceCommand> {
    return this.registry.store.transaction(l => {
      const command = l.commands.find(c => c.commandId === id); if (!command) throw new Error('DEVICE_COMMAND_NOT_FOUND')
      if (['observed', 'failed', 'expired', 'cancelled'].includes(command.status)) return command
      // A stale cancellation/expiry decision cannot prove that a dispatched action stopped.
      if ((status === 'cancelled' || status === 'expired') && command.status !== 'accepted') return command
      const at = this.now(); command.status = status; command.updatedAt = at
      if (status === 'sent') command.sentAt = at
      if (reason) command.reason = reason; else delete command.reason
      if (evidence) command.evidence = evidence
      command.timeline.push({ status, at, ...(reason ? { reason } : {}) }); return command
    })
  }
  private async confirm(command: DeviceCommand, signal?: AbortSignal): Promise<boolean> {
    if (!this.options.confirm) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.options.confirm!({ principal: command.principal, request: command.request, commandId: command.commandId })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DEVICE_DEADLINE_BEFORE_SEND')), Math.max(1, command.request.deadline - this.now()))
          abort = () => reject(new Error('DEVICE_CANCELLED_BEFORE_SEND'))
          signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
        }),
      ])
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
  private async execute(command: DeviceCommand, key: string, signal?: AbortSignal): Promise<DeviceCommand> {
    const { request, principal, commandId } = command
    const current = await this.status(principal, commandId)
    if (current.status !== 'accepted') return current
    let attempted = false
    try {
      if (signal?.aborted) return this.update(commandId, 'cancelled', 'DEVICE_CANCELLED_BEFORE_SEND')
      if (request.deadline <= this.now()) return this.update(commandId, 'expired', 'DEVICE_DEADLINE_BEFORE_SEND')
      if (inFlight.has(key)) throw new Error('DEVICE_UNRESOLVED_PREVIOUS_COMMAND')
      const unresolved = await this.registry.store.transaction(l => l.commands.filter(c => c.commandId !== commandId && c.request.deviceId === request.deviceId && (c.status === 'unknown' || c.status === 'sent') && !hasManualIsolationRelease(c)), false)
      for (const old of unresolved) if ((await this.reconcile(principal, old.commandId, signal, true)).status !== 'observed') throw new Error('DEVICE_UNRESOLVED_PREVIOUS_COMMAND')
      await this.registry.authorize(principal, request.deviceId, request.desiredState, request.authorizationRef)
      const fresh = await this.read(request.deviceId, signal)
      if (fresh.stale) throw new Error('DEVICE_STATE_NOT_FRESH')
      if (request.expectedVersion !== undefined && fresh.stateVersion !== request.expectedVersion) throw new Error('DEVICE_VERSION_CONFLICT')
      // Recheck after any queued wait and I/O, immediately before dispatch.
      const grant = await this.registry.authorize(principal, request.deviceId, request.desiredState, request.authorizationRef)
      let verifiedByHost = false
      if (grant.requireConfirmation) { verifiedByHost = await this.confirm(command, signal); if (!verifiedByHost) throw new Error('DEVICE_CONFIRMATION_REQUIRED') }
      if (signal?.aborted) return this.update(commandId, 'cancelled', 'DEVICE_CANCELLED_BEFORE_SEND')
      if (request.deadline <= this.now()) return this.update(commandId, 'expired', 'DEVICE_DEADLINE_BEFORE_SEND')
      if ((await this.status(principal, commandId)).status !== 'accepted') return this.status(principal, commandId)
      // Confirmation may itself wait. A final grant check prevents revocation during the prompt.
      await this.registry.authorize(principal, request.deviceId, request.desiredState, request.authorizationRef)
      const device = await this.registry.inspect(request.deviceId)
      const adapter = this.adapters.get(device.adapter); if (!adapter) throw new Error('DEVICE_ADAPTER_UNAVAILABLE')
      const controller = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined
      const dispatchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const dispatchable = await this.registry.store.transaction(l => {
        const c = l.commands.find(c => c.commandId === commandId)!
        if (c.status !== 'accepted') return false
        if (this.disposed || this.options.canDispatch?.() === false) throw new Error('DEVICE_HOST_DISABLED')
        if (l.commands.some(other => other.commandId !== commandId && other.request.deviceId === request.deviceId && ['sent', 'unknown'].includes(other.status) && !hasManualIsolationRelease(other))) throw new Error('DEVICE_UNRESOLVED_PREVIOUS_COMMAND')
        const finalGrant = assertDeviceGrant(l, this.now(), principal, request.deviceId, request.desiredState, request.authorizationRef)
        const finalDevice = l.devices.find(d => d.deviceId === request.deviceId)!
        if (finalDevice.availability !== 'online' || this.now() - finalDevice.observedAt > (this.options.maxAgeMs ?? 30_000)) throw new Error('DEVICE_STATE_NOT_FRESH')
        if (request.expectedVersion !== undefined && finalDevice.stateVersion !== request.expectedVersion) throw new Error('DEVICE_VERSION_CONFLICT')
        if (finalGrant.requireConfirmation && !grant.requireConfirmation) throw new Error('DEVICE_CONFIRMATION_REQUIRED')
        if (signal?.aborted) throw new Error('DEVICE_CANCELLED_BEFORE_SEND')
        if (request.deadline <= this.now()) throw new Error('DEVICE_DEADLINE_BEFORE_SEND')
        if (c.audit) c.audit.dispatch = { at: this.now(), grant: structuredClone(finalGrant), device: { deviceId: finalDevice.deviceId, adapter: finalDevice.adapter, homeId: finalDevice.homeId }, confirmation: { required: finalGrant.requireConfirmation === true, verifiedByHost } }
        c.status = 'sent'; c.sentAt = this.now(); c.updatedAt = c.sentAt; c.reason = 'DEVICE_DISPATCH_ATTEMPT'
        c.timeline.push({ status: 'sent', at: c.sentAt, reason: c.reason }); return true
      })
      if (!dispatchable) { clearTimeout(timeout); return this.status(principal, commandId) }
      attempted = true; inFlight.add(key)
      timeout = setTimeout(() => controller.abort(), Math.max(1, request.deadline - this.now()))
      const dispatch = Promise.resolve().then(() => adapter.set(device, request.desiredState, { commandId, deadline: request.deadline, signal: dispatchSignal }))
      void dispatch.finally(() => inFlight.delete(key)).catch(() => {})
      try {
        const result = await new Promise<Awaited<typeof dispatch>>((resolve, reject) => {
          const onAbort = () => reject(new Error('DEVICE_SEND_UNCERTAIN'))
          dispatchSignal.addEventListener('abort', onAbort, { once: true })
          if (dispatchSignal.aborted) onAbort()
          void dispatch.then(resolve, reject).finally(() => dispatchSignal.removeEventListener('abort', onAbort)).catch(() => {})
        })
        if (result.status === 'rejected') return this.update(commandId, 'failed', 'DEVICE_ADAPTER_REJECTED')
      } finally { clearTimeout(timeout) }
      const confirmable = Object.keys(request.desiredState).every(key => device.capabilities.some(c => c.confirmable && ((key === 'power' && c.kind === 'power') || (key === 'brightness' && c.kind === 'brightness') || (['targetTemperatureC', 'mode', 'fanMode'].includes(key) && c.kind === 'thermostat'))))
      if (!confirmable) return this.update(commandId, 'unknown', 'DEVICE_UNCONFIRMABLE_SENT')
      const until = Math.min(request.deadline, this.now() + (this.options.confirmationWindowMs ?? 5_000))
      do {
        const result = await this.reconcile(principal, commandId, signal)
        if (result.status === 'observed') return result
        if (signal?.aborted || this.now() >= until) break
        await sleep(Math.min(this.options.pollIntervalMs ?? 50, Math.max(1, until - this.now())), undefined, signal ? { signal } : undefined)
      } while (this.now() < until)
      return this.update(commandId, 'unknown', 'DEVICE_CONFIRMATION_TIMEOUT')
    } catch (error) {
      const reason = error instanceof Error && /^DEVICE_[A-Z_]+$/.test(error.message) ? error.message : 'DEVICE_ADAPTER_ERROR'
      return this.update(commandId, attempted ? 'unknown' : reason === 'DEVICE_CANCELLED_BEFORE_SEND' ? 'cancelled' : reason === 'DEVICE_DEADLINE_BEFORE_SEND' ? 'expired' : 'failed', reason)
    }
  }
  async status(principal: string, commandId: string): Promise<DeviceCommand> {
    return this.registry.store.transaction(l => { const c = l.commands.find(c => c.commandId === commandId && c.principal === principal); if (!c) throw new Error('DEVICE_COMMAND_NOT_FOUND'); return c }, false)
  }
  async cancel(principal: string, commandId: string): Promise<DeviceCommand> {
    return this.registry.store.transaction(l => {
      const command = l.commands.find(c => c.commandId === commandId && c.principal === principal)
      if (!command) throw new Error('DEVICE_COMMAND_NOT_FOUND')
      // This check and write share the same ledger transaction as dispatch's WAL gate.
      // Whichever commits first wins; there is no accepted snapshot to reuse later.
      if (command.status !== 'accepted') throw new Error('DEVICE_CANNOT_PROVE_STOPPED')
      const at = this.now()
      command.status = 'cancelled'; command.updatedAt = at; command.reason = 'DEVICE_CANCELLED_BEFORE_SEND'
      command.timeline.push({ status: 'cancelled', at, reason: command.reason })
      return command
    })
  }
  async reconcile(principal: string, commandId: string, signal?: AbortSignal, host = false): Promise<DeviceCommand> {
    return (await this.reconcileResult(principal, commandId, signal, host)).command
  }
  /** Query evidence only. Never calls set(), issues a new command or retries a dispatch. */
  async reconcileResult(principal: string, commandId: string, signal?: AbortSignal, host = false): Promise<DeviceReconciliationResult> {
    const command = host ? await this.registry.store.transaction(l => { const c = l.commands.find(c => c.commandId === commandId); if (!c) throw new Error('DEVICE_COMMAND_NOT_FOUND'); return c }, false) : await this.status(principal, commandId)
    if (hasManualIsolationRelease(command)) return { command, outcome: 'manually-released' }
    if (command.status === 'accepted') return { command, outcome: 'not-sent' }
    if (!['sent', 'unknown'].includes(command.status)) return { command, outcome: 'not-pending' }
    if (command.sentAt === undefined) return { command, outcome: 'unconfirmable' }
    try {
      const device = await this.registry.inspect(command.request.deviceId)
      // Enforce the same connection boundary for model reads and automatic
      // reconciliation, not only the trusted management UI.
      if (device.adapter === 'home-assistant' && this.options.hostIdentity && (command.audit?.origin.hostInstanceId !== this.options.hostIdentity.instanceId || command.audit.origin.epoch !== this.options.hostIdentity.epoch)) return { command, outcome: 'connection-unverified' }
      const gatewayState = this.adapters.get(device.adapter)?.confirmationEvidence === 'gateway-state' || device.adapter === 'home-assistant'
      if (!gatewayState && !Object.keys(command.request.desiredState).every(key => device.capabilities.some(c => c.confirmable && ((key === 'power' && c.kind === 'power') || (key === 'brightness' && c.kind === 'brightness') || (['targetTemperatureC', 'mode', 'fanMode'].includes(key) && c.kind === 'thermostat'))))) return { command, outcome: 'unconfirmable' }
      const observation = await this.read(command.request.deviceId, signal)
      if (observation.availability !== 'online') return { command, outcome: 'offline' }
      if (observation.stale || observation.source === 'registry-cache' || observation.observedAt < command.sentAt) return { command, outcome: 'stale' }
      if (stateMatches(observation.state, command.request.desiredState)) {
        // HA timestamps/revisions and target equality do not establish physical
        // execution. Never terminate the receipt or release its conflict guard.
        if (gatewayState || observation.source.startsWith('home-assistant:')) return { command, outcome: 'state-match-unverified' }
        const { stale: _stale, ...evidence } = observation
        const updated = await this.update(commandId, 'observed', undefined, evidence)
        return { command: updated, outcome: updated.status === 'observed' ? 'observed' : 'not-pending' }
      }
      return { command, outcome: 'state-mismatch' }
    } catch (error) {
      // Keep uncertainty and sanitize all adapter details, including credentials.
      return { command, outcome: error instanceof Error && error.message === 'DEVICE_READ_TIMEOUT' ? 'read-timeout' : 'read-failed' }
    }
  }
  private async observeFromAdapter(adapterId: string, observation: DeviceObservation): Promise<void> {
    if ((await this.registry.inspect(observation.deviceId)).adapter !== adapterId) throw new Error('DEVICE_ADAPTER_IDENTITY')
    await this.registry.observe(observation)
  }
  async observe(observation: DeviceObservation): Promise<void> { await this.registry.observe(observation) }
  /** Startup recovery never dispatches: accepted were unsent; sent may have executed. */
  async recover(): Promise<void> {
    await this.registry.store.transaction(l => { for (const c of l.commands) { if (c.status !== 'accepted' && c.status !== 'sent') continue; c.status = c.status === 'accepted' ? 'cancelled' : 'unknown'; c.reason = 'DEVICE_HOST_RESTART'; c.updatedAt = this.now(); c.timeline.push({ status: c.status, at: c.updatedAt, reason: c.reason }) } })
  }
  async scene(principal: string, sceneId: string, requestId: string, deadline: number, signal?: AbortSignal, source?: DeviceCommandSource): Promise<{ atomic: false; commands: DeviceCommand[]; failures: { deviceId: string; requestId: string; error: string }[] }> {
    const scene = await this.registry.store.transaction(l => l.scenes.find(s => s.sceneId === sceneId), false)
    if (!scene) throw new Error('DEVICE_SCENE_NOT_FOUND')
    const results = await Promise.all(scene.steps.map(async (step, i) => {
      const childRequestId = `${requestId}:${i}`
      try { return { command: await this.set(principal, { ...step, requestId: childRequestId, deadline }, signal, source) } }
      catch (error) { return { failure: { deviceId: step.deviceId, requestId: childRequestId, error: error instanceof Error && /^DEVICE_[A-Z_]+$/.test(error.message) ? error.message : 'DEVICE_SCENE_STEP_FAILED' } } }
    }))
    return { atomic: false, commands: results.flatMap(result => result.command ? [result.command] : []), failures: results.flatMap(result => result.failure ? [result.failure] : []) }
  }
  async wait(deviceId: string, desired: DeviceState, deadline: number, signal?: AbortSignal): Promise<DeviceObservation> {
    if (deadline > this.now() + 120_000 || !Number.isFinite(deadline)) throw new Error('DEVICE_WAIT_TOO_LONG')
    if (!Object.keys(desired).length) throw new Error('DEVICE_EMPTY_TARGET')
    if (deadline <= this.now()) throw new Error('DEVICE_WAIT_TIMEOUT')
    do { const observation = await this.read(deviceId, signal); if (!observation.stale && stateMatches(observation.state, desired)) return observation; await sleep(Math.min(100, Math.max(1, deadline - this.now())), undefined, signal ? { signal } : undefined) } while (this.now() < deadline)
    throw new Error('DEVICE_WAIT_TIMEOUT')
  }
  async close(): Promise<void> { this.disposed = true; for (const unsubscribe of this.subscriptions) unsubscribe(); for (const adapter of this.adapters.values()) await adapter.close?.() }
}
