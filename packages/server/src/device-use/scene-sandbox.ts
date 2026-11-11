import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { DeviceStore } from './store.js'
import { DeviceRegistry } from './registry.js'
import { DeviceBroker } from './broker.js'
import { type DeviceAdapter, type DeviceRecord, type DeviceState, type DeviceObservation } from './types.js'

const lampId = z.enum(['scene:lamp-a', 'scene:lamp-b'])
const target = z.object({ power: z.boolean().optional(), brightness: z.number().finite().min(0).max(100).optional() }).strict().refine(value => Object.keys(value).length > 0 && !(value.power === false && (value.brightness ?? 0) > 0) && !(value.power === true && value.brightness === 0))
const step = z.object({ deviceId: lampId, desiredState: target }).strict()
const faultSchema = z.enum(['none', 'reject-second', 'disconnect-second'])
export const sceneSandboxActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable') }).strict(), z.object({ action: z.literal('disable') }).strict(),
  z.object({ action: z.literal('configure'), name: z.string().trim().min(1).max(60).refine(value => !/[\x00-\x1f\x7f]/.test(value)), steps: z.array(step).min(1).max(2).refine(steps => new Set(steps.map(s => s.deviceId)).size === steps.length) }).strict(),
  z.object({ action: z.literal('preview') }).strict(),
  z.object({ action: z.literal('execute'), previewId: z.string().uuid(), version: z.number().int().nonnegative().safe(), fault: faultSchema }).strict(),
])
type SceneStep = z.infer<typeof step>
type Fault = z.infer<typeof faultSchema>
interface Preview { previewId: string; version: number; expiresAt: number; steps: { index: number; deviceId: string; from: DeviceState; to: DeviceState }[]; atomic: false }
interface Run { runId: string; version: number; status: 'running' | 'completed'; outcome: 'all-observed' | 'partial' | 'uncertain' | 'failed'; atomic: false; steps: { index: number; deviceId: string; status: string; commandId?: string; reason?: string }[] }
export interface SceneSandboxSnapshot {
  enabled: boolean; busy: boolean; simulated: true; realDevices: false; automaticRollback: false; automaticRetry: false; version: number
  scene: { name: string; steps: SceneStep[] }; devices: { deviceId: string; name: string; state: DeviceState }[]
  preview?: Preview; run?: Run; cleanup: { state: 'idle' | 'completed' | 'unconfirmed' }; lastError?: string
}
/** Deliberately not registered in HostDeviceService or any model capability pack. */
class SceneLamps implements DeviceAdapter {
  readonly id = 'scene-simulator'
  readonly calls: { deviceId: string; commandId: string }[] = []
  fault: { deviceId: string; kind: Fault } | undefined
  private readonly records: DeviceRecord[] = ['a', 'b'].map(letter => ({ deviceId: `scene:lamp-${letter}`, adapter: this.id, homeId: 'isolated-scene-sandbox', roomId: 'synthetic-room', name: `模拟灯 ${letter.toUpperCase()}`, aliases: [], availability: 'online', observedAt: Date.now(), stateVersion: 1, state: { power: false, brightness: 0 }, capabilities: [{ kind: 'power', readable: true, writable: true, confirmable: true }, { kind: 'brightness', readable: true, writable: true, confirmable: true, min: 0, max: 100, unit: 'percent' }] }))
  private readonly listeners = new Set<(observation: DeviceObservation) => void>()
  async discover() { return structuredClone(this.records) }
  async read(device: DeviceRecord) { const record = this.records.find(d => d.deviceId === device.deviceId); if (!record) throw new Error('DEVICE_NOT_FOUND'); return { deviceId: record.deviceId, observedAt: Date.now(), stateVersion: record.stateVersion, state: structuredClone(record.state), availability: 'online' as const, source: this.id } }
  async set(device: DeviceRecord, desiredState: DeviceState, context: { commandId: string; deadline: number; signal?: AbortSignal }): Promise<{ status: 'sent' | 'rejected' }> {
    context.signal?.throwIfAborted(); if (context.deadline <= Date.now()) return { status: 'rejected' }
    const record = this.records.find(d => d.deviceId === device.deviceId); if (!record) throw new Error('DEVICE_NOT_FOUND')
    this.calls.push({ deviceId: device.deviceId, commandId: context.commandId })
    const fault = this.fault?.deviceId === device.deviceId ? this.fault.kind : 'none'
    if (fault === 'reject-second') return { status: 'rejected' }
    Object.assign(record.state, desiredState); record.stateVersion++; record.observedAt = Date.now()
    if (fault === 'disconnect-second') throw new Error('DEVICE_SIMULATED_RESPONSE_LOST')
    const observation = await this.read(record); for (const listener of this.listeners) listener(structuredClone(observation))
    return { status: 'sent' }
  }
  subscribe(listener: (observation: DeviceObservation) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async close() { this.listeners.clear() }
}

/** Explicit local simulation, isolated private temporary ledger; no real adapter,
 * endpoint, credential, automation, persistent scene config or actual Host grant. */
export class SceneSandbox {
  private enabled = false
  private closed = false
  private busy = false
  private operation: Promise<SceneSandboxSnapshot> | undefined
  private version = 0
  private enableCount = 0
  private directory: string | undefined
  private registry: DeviceRegistry | undefined
  private broker: DeviceBroker | undefined
  private adapter: SceneLamps | undefined
  private readonly principal = 'isolated-scene-sandbox-owner'
  private scene: SceneSandboxSnapshot['scene'] = { name: '模拟双灯场景', steps: [{ deviceId: 'scene:lamp-a', desiredState: { power: true, brightness: 30 } }, { deviceId: 'scene:lamp-b', desiredState: { power: true, brightness: 60 } }] }
  private devices: SceneSandboxSnapshot['devices'] = ['a', 'b'].map(letter => ({ deviceId: `scene:lamp-${letter}`, name: `模拟灯 ${letter.toUpperCase()}`, state: { power: false, brightness: 0 } }))
  private preview: (Preview & { binding: string; versions: number[] }) | undefined
  private run: Run | undefined
  private committed: { previewId: string; fault: Fault } | undefined
  private cleanup: SceneSandboxSnapshot['cleanup'] = { state: 'idle' }
  private lastError: string | undefined
  snapshot(): SceneSandboxSnapshot {
    const preview = this.preview ? { previewId: this.preview.previewId, version: this.preview.version, expiresAt: this.preview.expiresAt, steps: this.preview.steps, atomic: false as const } : undefined
    return structuredClone({ enabled: this.enabled, busy: this.busy, simulated: true, realDevices: false, automaticRollback: false, automaticRetry: false, version: this.version, scene: this.scene, devices: this.devices, cleanup: this.cleanup, ...(preview ? { preview } : {}), ...(this.run ? { run: this.run } : {}), ...(this.lastError ? { lastError: this.lastError } : {}) })
  }
  act(raw: unknown, binding: string): Promise<SceneSandboxSnapshot> {
    if (this.closed) return Promise.reject(new Error('DEVICE_SCENE_SANDBOX_CLOSED'))
    if (this.busy) return Promise.reject(new Error('DEVICE_SCENE_SANDBOX_BUSY'))
    const parsed = sceneSandboxActionSchema.safeParse(raw)
    if (!parsed.success || !binding || binding.length > 200) return Promise.reject(new Error('DEVICE_SCENE_SANDBOX_INVALID'))
    const input = parsed.data
    if (!this.enabled && input.action !== 'enable' && input.action !== 'disable') return Promise.reject(new Error('DEVICE_SCENE_SANDBOX_DISABLED'))
    this.busy = true; this.lastError = undefined
    const operation = (async () => {
      try {
        if (input.action === 'enable') { if (!this.enabled) await this.enable() }
        else if (input.action === 'disable') { this.enabled = false; this.version++; this.preview = undefined; await this.dispose() }
        else if (input.action === 'configure') {
          await this.assertResolved()
          await this.register(input.steps); this.scene = { name: input.name, steps: input.steps }; this.version++; this.preview = undefined
        } else if (input.action === 'preview') await this.createPreview(binding)
        else await this.execute(input, binding)
      } catch (error) { this.lastError = error instanceof Error && /^DEVICE_[A-Z_]+$/.test(error.message) ? error.message : 'DEVICE_SCENE_SANDBOX_FAILED'; throw new Error(this.lastError) }
      finally { this.busy = false }
      return this.snapshot()
    })()
    this.operation = operation; void operation.finally(() => { if (this.operation === operation) this.operation = undefined }).catch(() => {})
    return operation
  }
  private grantRef(deviceId: string) { return `sandbox-grant:${deviceId}` }
  private async register(steps: SceneStep[], expectedVersions?: number[]) {
    await this.registry!.registerScene({ sceneId: 'sandbox-scene', steps: steps.map((step, index) => ({ ...step, authorizationRef: this.grantRef(step.deviceId), ...(expectedVersions ? { expectedVersion: expectedVersions[index]! } : {}) })) })
  }
  private async enable() {
    if (this.cleanup.state === 'unconfirmed') throw new Error('DEVICE_SCENE_SANDBOX_CLEANUP_UNCONFIRMED')
    if (this.enableCount >= 32) throw new Error('DEVICE_SCENE_SANDBOX_SESSION_CAPACITY')
    this.enableCount++; this.directory = await mkdtemp(join(tmpdir(), 'pulse-scene-sandbox-'))
    try {
      this.registry = new DeviceRegistry(new DeviceStore(join(this.directory, 'ledger.json'))); this.adapter = new SceneLamps()
      this.broker = new DeviceBroker(this.registry, [this.adapter], { confirmationWindowMs: 100, pollIntervalMs: 5, canDispatch: () => this.enabled && !this.closed })
      await this.broker.recover(); await this.broker.discover()
      for (const device of await this.registry.list()) { await this.registry.enroll(device.deviceId); await this.registry.grant({ authorizationRef: this.grantRef(device.deviceId), principal: this.principal, deviceId: device.deviceId, actions: ['power', 'brightness'], limits: { brightness: { min: 0, max: 100 } }, expiresAt: Date.now() + 60 * 60_000 }) }
      await this.register(this.scene.steps); await this.refreshDevices()
      this.version++; this.preview = undefined; this.run = undefined; this.committed = undefined; this.cleanup = { state: 'idle' }; this.enabled = true
    } catch (error) { await this.dispose(); throw error }
  }
  private async assertResolved() {
    if (!this.registry) throw new Error('DEVICE_SCENE_SANDBOX_DISABLED')
    if (this.run?.outcome === 'uncertain') throw new Error('DEVICE_SCENE_SANDBOX_UNRESOLVED')
    if (await this.registry.store.transaction(l => l.commands.some(c => ['accepted', 'sent', 'unknown'].includes(c.status)), false)) throw new Error('DEVICE_SCENE_SANDBOX_UNRESOLVED')
  }
  private async createPreview(binding: string) {
    await this.assertResolved()
    const steps: Preview['steps'] = [], versions: number[] = []
    for (const [index, step] of this.scene.steps.entries()) {
      const observation = await this.broker!.read(step.deviceId)
      versions.push(observation.stateVersion); steps.push({ index, deviceId: step.deviceId, from: observation.state, to: { ...observation.state, ...step.desiredState } })
    }
    this.preview = { previewId: randomUUID(), version: this.version, expiresAt: Date.now() + 120_000, steps, atomic: false, binding, versions }
    await this.refreshDevices()
  }
  private async execute(input: { previewId: string; version: number; fault: Fault }, binding: string) {
    const preview = this.preview
    if (!preview || preview.previewId !== input.previewId || preview.version !== input.version || input.version !== this.version || preview.binding !== binding) throw new Error('DEVICE_SCENE_SANDBOX_PREVIEW_CHANGED')
    if (this.committed?.previewId === input.previewId) { if (this.committed.fault !== input.fault) throw new Error('DEVICE_SCENE_SANDBOX_REQUEST_CONFLICT'); return }
    if (preview.expiresAt <= Date.now()) throw new Error('DEVICE_SCENE_SANDBOX_PREVIEW_EXPIRED')
    if (input.fault !== 'none' && this.scene.steps.length < 2) throw new Error('DEVICE_SCENE_SANDBOX_INVALID')
    await this.assertResolved(); await this.register(this.scene.steps, preview.versions)
    const runId = randomUUID(), deadline = Date.now() + 5000
    this.run = { runId, version: this.version, status: 'running', outcome: 'failed', atomic: false, steps: this.scene.steps.map((step, index) => ({ index, deviceId: step.deviceId, status: 'pending' })) }
    this.committed = { previewId: preview.previewId, fault: input.fault }
    this.adapter!.fault = input.fault === 'none' ? undefined : { deviceId: this.scene.steps[1]!.deviceId, kind: input.fault }
    try {
      const result = await this.broker!.scene(this.principal, 'sandbox-scene', runId, deadline, undefined, { entryPoint: 'host-executor' })
      this.run.steps = this.scene.steps.map((step, index) => {
        const requestId = `${runId}:${index}`, command = result.commands.find(c => c.request.requestId === requestId), failure = result.failures.find(f => f.requestId === requestId)
        return { index, deviceId: step.deviceId, status: command?.status ?? 'not-accepted', ...(command ? { commandId: command.commandId } : {}), ...(command?.reason || failure?.error ? { reason: command?.reason ?? failure!.error } : {}) }
      })
      const statuses = this.run.steps.map(step => step.status), observed = statuses.filter(status => status === 'observed').length
      this.run.outcome = statuses.some(status => ['accepted', 'sent', 'unknown'].includes(status)) ? 'uncertain' : observed === statuses.length ? 'all-observed' : observed > 0 ? 'partial' : 'failed'
    } catch { this.run.steps = this.scene.steps.map((step, index) => ({ index, deviceId: step.deviceId, status: 'unknown', reason: 'DEVICE_SCENE_SANDBOX_RUN_UNKNOWN' })); this.run.outcome = 'uncertain' }
    finally { this.adapter!.fault = undefined; this.run.status = 'completed'; await this.refreshDevices() }
  }
  private async refreshDevices() { if (this.registry) this.devices = (await this.registry.list()).map(d => ({ deviceId: d.deviceId, name: d.name, state: d.state })) }
  private async dispose() {
    try {
      await this.broker?.close()
      if (this.directory) await rm(this.directory, { recursive: true, force: true })
      this.broker = undefined; this.registry = undefined; this.adapter = undefined; this.directory = undefined; this.cleanup = { state: 'completed' }
    } catch { this.cleanup = { state: 'unconfirmed' }; throw new Error('DEVICE_SCENE_SANDBOX_CLEANUP_UNCONFIRMED') }
  }
  async close() { this.closed = true; await this.operation?.catch(() => {}); this.enabled = false; this.preview = undefined; await this.dispose() }
}
