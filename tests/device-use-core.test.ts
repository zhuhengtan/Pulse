import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DeviceStore, DeviceRegistry, DeviceBroker, SimulatedDeviceAdapter, createDeviceCapabilityPack, deviceStateSchema, type DeviceCommandRequest } from '../packages/server/src/device-use/index.js'
import { CapabilityPackRegistry } from '../packages/server/src/capabilities.js'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture(options: ConstructorParameters<typeof DeviceBroker>[2] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-')); cleanup.push(() => rm(dir, { force: true, recursive: true }))
  const store = new DeviceStore(join(dir, 'ledger.json')), registry = new DeviceRegistry(store), adapter = new SimulatedDeviceAdapter()
  const broker = new DeviceBroker(registry, [adapter], { confirmationWindowMs: 50, pollIntervalMs: 5, ...options }); cleanup.push(() => broker.close())
  await broker.discover()
  for (const deviceId of ['sim:light', 'sim:thermostat']) { await registry.enroll(deviceId); await registry.grant({ authorizationRef: `grant:${deviceId}`, principal: 'owner', deviceId, actions: ['power', 'brightness', 'targetTemperatureC', 'mode', 'fanMode'], expiresAt: Date.now() + 60_000 }) }
  const request = (desiredState: DeviceCommandRequest['desiredState'] = { power: true }, extra: Partial<DeviceCommandRequest> = {}): DeviceCommandRequest => ({ requestId: 'r1', deviceId: 'sim:light', desiredState, authorizationRef: 'grant:sim:light', deadline: Date.now() + 5_000, ...extra })
  return { store, registry, adapter, broker, request }
}
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(2) } throw new Error('condition timeout') }
describe('Device Use core closed loop', () => {
  it('discovers without granting control, does not guess same-name devices', async () => {
    const f = await fixture(); const sensor = await f.registry.inspect('sim:temperature')
    await f.registry.discover([{ ...sensor, deviceId: 'sim:temperature2', name: '客厅温度' }])
    await expect(f.registry.resolve('客厅温度')).rejects.toThrow('DEVICE_AMBIGUOUS')
    const result = await f.broker.set('owner', f.request({ power: true }, { deviceId: sensor.deviceId }))
    expect(result.status).toBe('failed'); expect(result.reason).toBe('DEVICE_NOT_ENROLLED'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('confirms only fresh target state and retains an auditable receipt', async () => {
    const f = await fixture(); const result = await f.broker.set('owner', f.request({ power: true, brightness: 30 }))
    expect(result.status).toBe('observed'); expect(result.evidence?.source).toBe('simulator'); expect(result.evidence?.state.brightness).toBe(30)
    expect(result.timeline.map(t => t.status)).toEqual(['accepted', 'sent', 'observed'])
    if (process.platform !== 'win32') expect((await stat(f.store.path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(f.store.path, 'utf8')).commands[0].commandId).toBe(result.commandId)
  })
  it('deduplicates in-flight and completed requests without resending', async () => {
    const f = await fixture(); f.adapter.delayMs = 20; const request = f.request()
    const [a, b] = await Promise.all([f.broker.set('owner', request), f.broker.set('owner', request)])
    expect(a.commandId).toBe(b.commandId); expect(f.adapter.calls).toHaveLength(1)
    expect((await f.broker.set('owner', request)).status).toBe('observed'); expect(f.adapter.calls).toHaveLength(1)
    await expect(f.broker.set('owner', { ...request, desiredState: { power: false } })).rejects.toThrow('DEVICE_REQUEST_ID_CONFLICT')
  })
  it('rejects revoked, wrong-principal, unknown, out-of-range and unsupported actions', async () => {
    const f = await fixture()
    expect((await f.broker.set('other', f.request())).reason).toBe('DEVICE_NOT_AUTHORIZED')
    expect(() => deviceStateSchema.parse({ toggle: true })).toThrow()
    expect((await f.broker.set('owner', f.request({ temperatureC: 25 }, { requestId: 'r2' }))).reason).toBe('DEVICE_ACTION_UNSUPPORTED')
    await f.registry.grant({ authorizationRef: 'limited', principal: 'owner', deviceId: 'sim:light', actions: ['brightness'], expiresAt: Date.now() + 1_000, limits: { brightness: { min: 0, max: 40 } } })
    expect((await f.broker.set('owner', f.request({ brightness: 60 }, { requestId: 'r3', authorizationRef: 'limited' }))).reason).toBe('DEVICE_GRANT_LIMIT')
    await f.registry.revoke('grant:sim:light')
    expect((await f.broker.set('owner', f.request({ power: true }, { requestId: 'r4' }))).reason).toBe('DEVICE_NOT_AUTHORIZED'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('requires trusted action confirmation, never a model boolean', async () => {
    const f = await fixture(); await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 1_000 })
    expect((await f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm' }))).reason).toBe('DEVICE_CONFIRMATION_REQUIRED')
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('checks revocation after a confirmation prompt', async () => {
    const f = await fixture({ confirm: async () => { await f.registry.revoke('confirm'); return true } })
    await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 1_000 })
    expect((await f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm' }))).reason).toBe('DEVICE_NOT_AUTHORIZED'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('rechecks a queued grant across separate Broker instances sharing one store', async () => {
    const f = await fixture(); f.adapter.delayMs = 50
    const other = new DeviceBroker(new DeviceRegistry(new DeviceStore(f.store.path)), [f.adapter], { confirmationWindowMs: 50 }); cleanup.push(() => other.close())
    const a = f.broker.set('owner', f.request())
    await until(async () => f.adapter.calls.length > 0)
    const b = other.set('owner', f.request({ power: false }, { requestId: 'r2' }))
    await until(() => f.store.transaction(l => l.commands.length === 2, false)); await f.registry.revoke('grant:sim:light')
    expect((await a).status).toBe('observed'); expect((await b).reason).toBe('DEVICE_NOT_AUTHORIZED'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('serializes opposite commands for the same device', async () => {
    const f = await fixture(); f.adapter.delayMs = 10
    const [a, b] = await Promise.all([f.broker.set('owner', f.request()), f.broker.set('owner', f.request({ power: false }, { requestId: 'r2' }))])
    expect([a.status, b.status]).toEqual(['observed', 'observed']); expect(f.adapter.calls.map(c => c.desiredState.power)).toEqual([true, false])
  })
  it('runs different devices concurrently', async () => {
    const f = await fixture(); f.adapter.delayMs = 50
    const a = f.broker.set('owner', f.request()), b = f.broker.set('owner', f.request({ targetTemperatureC: 26 }, { requestId: 'r2', deviceId: 'sim:thermostat', authorizationRef: 'grant:sim:thermostat' }))
    await until(async () => f.adapter.calls.length === 2); expect((await a).status).toBe('observed'); expect((await b).status).toBe('observed')
  })
  it('gateway acceptance without target state remains unknown, no blind resend', async () => {
    const f = await fixture(); f.adapter.fault('sim:light', 'no-change'); const request = f.request()
    const result = await f.broker.set('owner', request)
    expect(result.status).toBe('unknown'); expect((await f.broker.set('owner', request)).commandId).toBe(result.commandId)
    expect((await f.broker.set('owner', f.request({ power: false }, { requestId: 'r2' }))).reason).toBe('DEVICE_UNRESOLVED_PREVIOUS_COMMAND'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('reconciles a disconnect-after-send by observation without replay', async () => {
    const f = await fixture(); f.adapter.fault('sim:light', 'disconnect-after-send')
    const result = await f.broker.set('owner', f.request()); expect(result.status).toBe('unknown')
    expect((await f.broker.reconcile('owner', result.commandId)).status).toBe('observed'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('send timeout is unknown, not failed or safely cancelled', async () => {
    const f = await fixture(); f.adapter.fault('sim:light', 'timeout')
    const result = await f.broker.set('owner', f.request({ power: true }, { deadline: Date.now() + 2_000 }))
    expect(result.status).toBe('unknown'); expect(f.adapter.calls).toHaveLength(1); await expect(f.broker.cancel('owner', result.commandId)).rejects.toThrow('DEVICE_CANNOT_PROVE_STOPPED')
  })
  it('rejects stale/offline data, expired deadlines and version conflicts before sending', async () => {
    const f = await fixture(); f.adapter.fault('sim:light', 'stale')
    expect((await f.broker.read('sim:light')).stale).toBe(true)
    expect((await f.broker.set('owner', f.request())).reason).toBe('DEVICE_STATE_NOT_FRESH')
    f.adapter.fault('sim:light', 'offline'); expect((await f.broker.read('sim:light')).stale).toBe(true)
    f.adapter.fault('sim:light'); expect((await f.broker.set('owner', f.request({}, { requestId: 'r2', desiredState: { power: true }, deadline: Date.now() - 1 }))).status).toBe('expired')
    expect((await f.broker.set('owner', f.request({ power: true }, { requestId: 'r3', expectedVersion: 99 }))).reason).toBe('DEVICE_VERSION_CONFLICT'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('ignores duplicate conflicting and reordered observations', async () => {
    const f = await fixture(); const d = await f.registry.inspect('sim:light')
    expect(await f.registry.observe({ deviceId: d.deviceId, stateVersion: d.stateVersion - 1, observedAt: Date.now(), availability: 'online', state: { power: true }, source: 'simulator' })).toBe(false)
    expect(await f.registry.observe({ deviceId: d.deviceId, stateVersion: d.stateVersion, observedAt: Date.now(), availability: 'online', state: { power: true }, source: 'simulator' })).toBe(false)
    expect((await f.registry.inspect(d.deviceId)).state.power).toBe(false)
  })
  it('restores sent as unknown and accepted as unsent cancellation, never dispatches', async () => {
    const f = await fixture(); const result = await f.broker.set('owner', f.request())
    await f.store.transaction(l => { l.commands[0]!.status = 'sent'; l.commands.push({ ...l.commands[0]!, commandId: crypto.randomUUID(), request: { ...l.commands[0]!.request, requestId: 'queued' }, status: 'accepted' }) })
    const recovered = new DeviceBroker(new DeviceRegistry(new DeviceStore(f.store.path)), [f.adapter]); cleanup.push(() => recovered.close()); await recovered.recover()
    expect((await recovered.status('owner', result.commandId)).status).toBe('unknown'); expect(await f.store.transaction(l => l.commands[1]!.status, false)).toBe('cancelled'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('returns per-device scene outcomes without claiming atomic rollback', async () => {
    const f = await fixture(); f.adapter.fault('sim:thermostat', 'reject')
    await f.registry.registerScene({ sceneId: 'evening', steps: [{ deviceId: 'sim:light', desiredState: { power: true }, authorizationRef: 'grant:sim:light' }, { deviceId: 'sim:thermostat', desiredState: { targetTemperatureC: 26 }, authorizationRef: 'grant:sim:thermostat' }] })
    const result = await f.broker.scene('owner', 'evening', 'scene1', Date.now() + 1_000)
    expect(result.atomic).toBe(false); expect(result.commands.map(c => c.status)).toEqual(['observed', 'failed'])
  })

  it('cancels an accepted queued command without dispatch', async () => {
    const f = await fixture(); f.adapter.delayMs = 60
    const first = f.broker.set('owner', f.request())
    await until(async () => f.adapter.calls.length === 1)
    const queued = f.broker.set('owner', f.request({ power: false }, { requestId: 'queued' }))
    await until(() => f.store.transaction(l => l.commands.length === 2, false))
    const id = await f.store.transaction(l => l.commands[1]!.commandId, false)
    expect((await f.broker.cancel('owner', id)).status).toBe('cancelled')
    await first; expect((await queued).status).toBe('cancelled'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('expires a queued command before it can send', async () => {
    const f = await fixture(); f.adapter.delayMs = 80
    const first = f.broker.set('owner', f.request())
    await until(async () => f.adapter.calls.length === 1)
    const queued = f.broker.set('owner', f.request({ power: false }, { requestId: 'queued', deadline: Date.now() + 20 }))
    await first; expect((await queued).status).toBe('expired'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('does not promote non-confirmable actions to observed on later reconciliation', async () => {
    const f = await fixture(); const device = await f.registry.inspect('sim:light')
    await f.registry.discover([{ ...device, capabilities: device.capabilities.map(c => ({ ...c, confirmable: false })) }])
    const result = await f.broker.set('owner', f.request())
    expect(result.status).toBe('unknown'); expect(result.reason).toBe('DEVICE_UNCONFIRMABLE_SENT')
    expect((await f.broker.reconcile('owner', result.commandId)).status).toBe('unknown')
  })
  it('bounds reads even if a broken adapter ignores its abort signal', async () => {
    const f = await fixture({ readTimeoutMs: 15 }); f.adapter.read = async () => new Promise(() => {})
    await expect(f.broker.read('sim:light')).rejects.toThrow('DEVICE_READ_TIMEOUT')
    expect((await f.broker.set('owner', f.request())).reason).toBe('DEVICE_READ_TIMEOUT'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('refuses another living ledger owner and recovers a dead owner conservatively', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-device-owner-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'ledger.json'), store = new DeviceStore(path)
    await writeFile(`${path}.owner`, JSON.stringify({ pid: process.pid, token: 'another-host' }), { mode: 0o600 })
    await expect(store.transaction(l => l.commands)).rejects.toThrow('DEVICE_STORE_IN_USE')
    await writeFile(`${path}.owner`, JSON.stringify({ pid: 1073741823, token: 'dead-host' }))
    expect(await store.transaction(l => l.commands)).toEqual([])
  })
  it('retains host-selected room and aliases on rediscovery', async () => {
    const f = await fixture(); await f.registry.enroll('sim:light', { roomId: 'office', aliases: ['Desk light'] })
    await f.broker.discover(); const device = await f.registry.inspect('sim:light')
    expect(device.roomId).toBe('office'); expect(device.aliases).toEqual(['Desk light'])
  })

  it('rechecks expectedVersion after a confirmation wait', async () => {
    const f = await fixture({ confirm: async () => {
      const d = await f.registry.inspect('sim:light')
      await f.registry.observe({ deviceId: d.deviceId, availability: 'online', observedAt: Date.now(), stateVersion: d.stateVersion + 1, state: { power: false, brightness: 10 }, source: 'manual-change' })
      return true
    } })
    await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 1_000 })
    expect((await f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm', expectedVersion: 1 }))).reason).toBe('DEVICE_VERSION_CONFLICT'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('redacts arbitrary adapter errors before model-facing reads', async () => {
    const f = await fixture(); f.adapter.read = async () => { throw new Error('secret account token: do not expose') }
    await expect(f.broker.read('sim:light')).rejects.toThrow(/^DEVICE_ADAPTER_READ_FAILED$/)
    const result = await f.broker.set('owner', f.request()); expect(result.reason).toBe('DEVICE_ADAPTER_READ_FAILED')
    expect(JSON.stringify(result)).not.toContain('secret account')
  })

  it('checks the trusted host dispatch gate after a confirmation wait', async () => {
    let enabled = true
    const f = await fixture({ canDispatch: () => enabled, confirm: async () => { enabled = false; return true } })
    await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 1_000 })
    expect((await f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm' }))).reason).toBe('DEVICE_HOST_DISABLED'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('expires an unanswered trusted confirmation without sending', async () => {
    const f = await fixture({ confirm: async () => new Promise(() => {}) })
    await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 1_000 })
    expect((await f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm', deadline: Date.now() + 40 }))).status).toBe('expired'); expect(f.adapter.calls).toHaveLength(0)
  })

  it('restores simulated state versions across host adapter recreation', async () => {
    const f = await fixture(); expect((await f.broker.set('owner', f.request({ power: true, brightness: 30 }))).status).toBe('observed')
    const adapter = new SimulatedDeviceAdapter(); adapter.hydrate(await f.store.transaction(l => l.devices, false))
    const broker = new DeviceBroker(f.registry, [adapter], { confirmationWindowMs: 50 }); cleanup.push(() => broker.close())
    await broker.recover(); await broker.discover()
    const result = await broker.set('owner', f.request({ power: false }, { requestId: 'after-restart' }))
    expect(result.status).toBe('observed'); expect(result.evidence?.stateVersion).toBe(3); expect(adapter.calls).toHaveLength(1)
    expect(() => adapter.hydrate([{ ...({} as any), deviceId: 'other' }])).toThrow()
  })

  it('retains scene receipts when another step fails before command acceptance', async () => {
    const f = await fixture(); const deadline = Date.now() + 5_000
    await f.broker.set('owner', f.request({ power: true }, { requestId: 'scene-conflict:0', deadline }))
    await f.registry.registerScene({ sceneId: 'conflict', steps: [{ deviceId: 'sim:light', desiredState: { power: false }, authorizationRef: 'grant:sim:light' }, { deviceId: 'sim:thermostat', desiredState: { targetTemperatureC: 26 }, authorizationRef: 'grant:sim:thermostat' }] })
    const result = await f.broker.scene('owner', 'conflict', 'scene-conflict', deadline)
    expect(result.commands).toHaveLength(1); expect(result.commands[0]?.status).toBe('observed')
    expect(result.failures).toEqual([{ deviceId: 'sim:light', requestId: 'scene-conflict:0', error: 'DEVICE_REQUEST_ID_CONFLICT' }])
  })

  it('atomically decides a cancellation even when its transaction return is paused during dispatch', async () => {
    const confirmed = Promise.withResolvers<boolean>(), confirmEntered = Promise.withResolvers<void>()
    const f = await fixture({ confirm: async () => { confirmEntered.resolve(); return confirmed.promise } })
    await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 60_000 })
    const adapterEntered = Promise.withResolvers<void>(), releaseAdapter = Promise.withResolvers<void>()
    const realSet = f.adapter.set.bind(f.adapter)
    vi.spyOn(f.adapter, 'set').mockImplementation(async (...args) => { adapterEntered.resolve(); await releaseAdapter.promise; return realSet(...args) })
    const running = f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm' }))
    await confirmEntered.promise
    const commandId = await f.store.transaction(l => l.commands[0]!.commandId, false)
    const transactionReturned = Promise.withResolvers<void>(), releaseTransaction = Promise.withResolvers<void>()
    const realTransaction = f.store.transaction.bind(f.store)
    let pauseNext = true
    const transactionSpy = vi.spyOn(f.store, 'transaction').mockImplementation(async (change, write) => {
      const pause = pauseNext; pauseNext = false
      const result = await realTransaction(change, write)
      if (pause) { transactionReturned.resolve(); await releaseTransaction.promise }
      return result
    })
    const cancelling = f.broker.cancel('owner', commandId)
    const cancellationOutcome = cancelling.then(command => ({ command }), error => ({ error }))
    try {
      await transactionReturned.promise
      confirmed.resolve(true)
      const winner = await Promise.race([adapterEntered.promise.then(() => 'dispatch'), running.then(() => 'cancel')])
      releaseTransaction.resolve()
      const outcome = await cancellationOutcome
      if (winner === 'dispatch') {
        // A separate accepted read followed by update used to reach this branch
        // and incorrectly turn the already-sent command into cancelled.
        expect(outcome).toHaveProperty('error.message', 'DEVICE_CANNOT_PROVE_STOPPED')
        expect((await f.broker.status('owner', commandId)).status).toBe('sent')
      } else {
        expect(outcome).toHaveProperty('command.status', 'cancelled')
        expect(f.adapter.set).not.toHaveBeenCalled()
      }
    } finally {
      confirmed.resolve(true); releaseTransaction.resolve(); releaseAdapter.resolve(); transactionSpy.mockRestore(); await running
    }
  })
  it('rejects cancellation when dispatch commits while the cancellation transaction is waiting', async () => {
    const confirmed = Promise.withResolvers<boolean>(), confirmEntered = Promise.withResolvers<void>()
    const f = await fixture({ confirm: async () => { confirmEntered.resolve(); return confirmed.promise } })
    await f.registry.grant({ authorizationRef: 'confirm', principal: 'owner', deviceId: 'sim:light', actions: ['power'], requireConfirmation: true, expiresAt: Date.now() + 60_000 })
    const adapterEntered = Promise.withResolvers<void>(), releaseAdapter = Promise.withResolvers<void>()
    const realSet = f.adapter.set.bind(f.adapter)
    vi.spyOn(f.adapter, 'set').mockImplementation(async (...args) => { adapterEntered.resolve(); await releaseAdapter.promise; return realSet(...args) })
    const running = f.broker.set('owner', f.request({ power: true }, { authorizationRef: 'confirm' }))
    await confirmEntered.promise
    const commandId = await f.store.transaction(l => l.commands[0]!.commandId, false)
    const cancellationWaiting = Promise.withResolvers<void>(), releaseCancellation = Promise.withResolvers<void>()
    const realTransaction = f.store.transaction.bind(f.store)
    let pauseNext = true
    const transactionSpy = vi.spyOn(f.store, 'transaction').mockImplementation(async (change, write) => {
      const pause = pauseNext; pauseNext = false
      if (pause) { cancellationWaiting.resolve(); await releaseCancellation.promise }
      return realTransaction(change, write)
    })
    const cancelling = f.broker.cancel('owner', commandId)
    const cancellationOutcome = cancelling.then(command => ({ command }), error => ({ error }))
    try {
      await cancellationWaiting.promise; confirmed.resolve(true); await adapterEntered.promise
      expect((await f.broker.status('owner', commandId)).status).toBe('sent')
      releaseCancellation.resolve()
      expect(await cancellationOutcome).toHaveProperty('error.message', 'DEVICE_CANNOT_PROVE_STOPPED')
      const receipt = await f.broker.status('owner', commandId)
      expect(receipt.status).toBe('sent'); expect(receipt.timeline.map(t => t.status)).toEqual(['accepted', 'sent'])
    } finally {
      confirmed.resolve(true); releaseCancellation.resolve(); releaseAdapter.resolve(); transactionSpy.mockRestore(); await running
    }
  })
  it.each(['sent', 'unknown'] as const)('does not downgrade %s through stale internal cancellation or expiry updates', async status => {
    const f = await fixture(), result = await f.broker.set('owner', f.request())
    await f.store.transaction(l => { l.commands[0]!.status = status })
    for (const stale of ['cancelled', 'expired']) {
      const receipt = await (f.broker as any).update(result.commandId, stale, 'DEVICE_STALE_PRE_SEND_DECISION')
      expect(receipt.status).toBe(status); expect(receipt.timeline.at(-1)?.status).not.toBe(stale)
    }
    await expect(f.broker.cancel('other', result.commandId)).rejects.toThrow('DEVICE_COMMAND_NOT_FOUND')
    await expect(f.broker.cancel('owner', result.commandId)).rejects.toThrow('DEVICE_CANNOT_PROVE_STOPPED')
  })
  it('exposes exactly limited tools through the existing CapabilityPack contract', async () => {
    const f = await fixture(); const packs = new CapabilityPackRegistry(); packs.register(createDeviceCapabilityPack(f.broker, 'owner'))
    const active = await packs.activate(['device'], { workspaceRoot: '/tmp', config: {}, signal: new AbortController().signal })
    expect(active.tools.map(t => t.manifest.name)).toEqual(['device.list', 'device.inspect', 'device.read', 'device.set', 'device.scene.run', 'device.command.status', 'device.wait'])
    expect(active.tools.find(t => t.manifest.name === 'device.set')?.manifest.sideEffectPolicy).toBe('external'); await active.dispose()
  })
})
