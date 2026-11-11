import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { DeviceBroker, type DeviceBrokerOptions } from '../packages/server/src/device-use/broker.js'
import { DeviceRegistry } from '../packages/server/src/device-use/registry.js'
import { DeviceStore } from '../packages/server/src/device-use/store.js'
import { SimulatedDeviceAdapter } from '../packages/server/src/device-use/simulator.js'
import { createDeviceCapabilityPack } from '../packages/server/src/device-use/pack.js'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { projectCommandHistory, revokeDeviceGrants } from '../packages/server/src/device-use/audit.js'
import { deviceCommandSchema, type DeviceCommandRequest } from '../packages/server/src/device-use/types.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const context = (): ToolContext => ({ toolCallId: 'tool-1', effectId: 'effect-1', attemptId: 'attempt-1', agentId: 'agent-1', laneId: 'lane-1', signal: new AbortController().signal, emit: () => {} })
async function fixture(options: DeviceBrokerOptions = {}, maxPermissionEvents?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-audit-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const store = new DeviceStore(join(dir, 'ledger.json')), registry = new DeviceRegistry(store, Date.now, maxPermissionEvents ? { maxPermissionEvents } : {}), adapter = new SimulatedDeviceAdapter()
  const broker = new DeviceBroker(registry, [adapter], { confirmationWindowMs: 20, pollIntervalMs: 2, ...options }); cleanup.push(() => broker.close())
  await broker.discover(); await registry.enroll('sim:light')
  const grant = { authorizationRef: 'audit-grant', principal: 'owner', deviceId: 'sim:light', actions: ['power', 'brightness'] as ('power' | 'brightness')[], expiresAt: Date.now() + 60000, limits: { brightness: { min: 0, max: 80 } } }
  await registry.grant(grant)
  const request = (extra: Partial<DeviceCommandRequest> = {}): DeviceCommandRequest => ({ requestId: 'audit-request', deviceId: 'sim:light', desiredState: { power: true, brightness: 30 }, authorizationRef: grant.authorizationRef, deadline: Date.now() + 5000, ...extra })
  return { dir, store, registry, adapter, broker, grant, request }
}
describe('Device Use authorization audit', () => {
  it('records a frozen acceptance snapshot and the exact final grant atomically with dispatch', async () => {
    const f = await fixture(), result = await f.broker.set('owner', f.request())
    expect(result.status).toBe('observed')
    expect(result.audit).toMatchObject({ version: 1, acceptance: { authorizationChecked: false, grant: { limits: { brightness: { max: 80 } } } }, dispatch: { grant: { authorizationRef: 'audit-grant', limits: { brightness: { max: 80 } } }, device: { deviceId: 'sim:light', adapter: 'simulator', homeId: 'simulation' }, confirmation: { required: false, verifiedByHost: false } } })
    expect(result.audit?.origin.entryPoint).toBe('broker-api'); expect(result.audit?.dispatch?.at).toBeLessThanOrEqual(result.sentAt!)
    f.grant.limits.brightness.max = 1
    await f.registry.revoke('audit-grant')
    const stored = await f.broker.status('owner', result.commandId)
    expect(stored.audit?.dispatch?.grant.limits?.brightness?.max).toBe(80)
    expect(await f.store.transaction(l => l.grants, false)).toEqual([])
    expect(await f.store.transaction(l => l.permissionEvents?.map(e => [e.action, e.grant.limits?.brightness?.max]), false)).toEqual([['grant', 80], ['revoke', 80]])
  })
  it('captures grant changes during trusted confirmation separately from acceptance', async () => {
    let fixtureRef: Awaited<ReturnType<typeof fixture>>
    const f = await fixture({ confirm: async () => { await fixtureRef.registry.grant({ ...fixtureRef.grant, requireConfirmation: true, limits: { brightness: { min: 0, max: 40 } } }); return true } }); fixtureRef = f
    await f.registry.grant({ ...f.grant, requireConfirmation: true })
    const result = await f.broker.set('owner', f.request())
    expect(result.status).toBe('observed')
    expect(result.audit?.acceptance.grant?.limits?.brightness?.max).toBe(80)
    expect(result.audit?.dispatch?.grant.limits?.brightness?.max).toBe(40)
    expect(result.audit?.dispatch?.confirmation).toEqual({ required: true, verifiedByHost: true })
  })
  it('records missing or denied authorization without fabricating dispatch or confirmation evidence', async () => {
    const f = await fixture()
    const missing = await f.broker.set('owner', f.request({ authorizationRef: 'not-a-grant' }))
    expect(missing.status).toBe('failed'); expect(missing.audit?.acceptance.grant).toBeNull(); expect(missing.audit?.dispatch).toBeUndefined()
    await f.registry.grant({ ...f.grant, requireConfirmation: true })
    const denied = await f.broker.set('owner', f.request({ requestId: 'confirmation-denied' }))
    expect(denied.reason).toBe('DEVICE_CONFIRMATION_REQUIRED'); expect(denied.audit?.dispatch).toBeUndefined(); expect(f.adapter.calls).toHaveLength(0)
  })
  it('binds Host-owned provenance and keeps runtime correlation separate from authority', async () => {
    const instanceId = randomUUID(), f = await fixture({ hostIdentity: { instanceId, epoch: 7 } })
    const activation = await createDeviceCapabilityPack(f.broker, 'owner', { entryPoint: 'host-runtime' }).activate({ workspaceRoot: f.dir, config: {}, signal: new AbortController().signal })
    const result = await activation.tools.find(t => t.manifest.name === 'device.set')!.execute(f.request(), context()) as any
    expect(result.audit.origin).toMatchObject({ hostInstanceId: instanceId, epoch: 7, entryPoint: 'host-runtime', correlation: { toolCallId: 'tool-1', effectId: 'effect-1' } })
    expect(result.audit.origin.brokerId).toMatch(/^[a-f0-9-]{36}$/)
    await expect(activation.tools.find(t => t.manifest.name === 'device.set')!.execute({ ...f.request({ requestId: 'forged' }), audit: { origin: { principal: 'admin', verifiedByHost: true } } }, context())).rejects.toThrow()
    expect(await f.store.transaction(l => l.commands.length, false)).toBe(1)
    expect(JSON.stringify(result.audit)).not.toContain('admin')
  })
  it('fails closed at command capacity, preserves unknown/dedup evidence, and never sends another action', async () => {
    const f = await fixture({ maxCommands: 2 }); f.adapter.fault('sim:light', 'no-change')
    const request = f.request(), unknown = await f.broker.set('owner', request)
    expect(unknown.status).toBe('unknown')
    const blocked = await f.broker.set('owner', f.request({ requestId: 'blocked-by-unresolved' })); expect(blocked.status).toBe('failed')
    await expect(f.broker.set('owner', f.request({ requestId: 'capacity' }))).rejects.toThrow('DEVICE_COMMAND_AUDIT_CAPACITY')
    const duplicate = await f.broker.set('owner', request); expect(duplicate.commandId).toBe(unknown.commandId); expect(duplicate.audit).toEqual(unknown.audit)
    expect(await f.store.transaction(l => l.commands.length, false)).toBe(2); expect(f.adapter.calls).toHaveLength(1)
  })
  it('refuses new grants at permission-audit capacity while always permitting existing-grant revocation', async () => {
    const f = await fixture({}, 2)
    await f.registry.grant({ ...f.grant, limits: { brightness: { min: 0, max: 40 } } })
    await expect(f.registry.grant({ ...f.grant, authorizationRef: 'denied-new-grant' })).rejects.toThrow('DEVICE_PERMISSION_AUDIT_CAPACITY')
    expect(await f.store.transaction(l => l.grants.map(g => g.authorizationRef), false)).toEqual(['audit-grant'])
    await f.registry.revoke('audit-grant'); await f.registry.revoke('audit-grant')
    expect(await f.store.transaction(l => l.permissionEvents?.map(e => e.action), false)).toEqual(['grant', 'grant', 'revoke'])
    expect(await f.store.transaction(l => l.grants, false)).toEqual([])
    expect((await f.broker.set('owner', f.request())).reason).toBe('DEVICE_NOT_AUTHORIZED'); expect(f.adapter.calls).toHaveLength(0)
  })
  it('does not widen a scoped withdrawal to another principal sharing a legacy reference', async () => {
    const f = await fixture()
    await f.store.transaction(l => { l.grants.push({ ...f.grant, principal: 'another-owner' }); revokeDeviceGrants(l, grant => grant.principal === 'owner', Date.now()) })
    expect(await f.store.transaction(l => l.grants.map(g => g.principal), false)).toEqual(['another-owner'])
    expect(await f.store.transaction(l => l.permissionEvents?.filter(e => e.action === 'revoke').map(e => e.grant.principal), false)).toEqual(['owner'])
  })
  it('keeps unknown audit after recovery and reconciliation never replays it', async () => {
    const f = await fixture(); f.adapter.fault('sim:light', 'no-change')
    const unknown = await f.broker.set('owner', f.request()); await f.registry.revoke('audit-grant')
    const recovered = new DeviceBroker(f.registry, [f.adapter]); cleanup.push(() => recovered.close()); await recovered.recover()
    expect((await recovered.status('owner', unknown.commandId)).audit).toEqual(unknown.audit)
    expect((await recovered.reconcile('owner', unknown.commandId)).status).toBe('unknown'); expect(f.adapter.calls).toHaveLength(1)
  })
  it('reads legacy records without inventing authorization snapshots or lifecycle history', async () => {
    const f = await fixture(), result = await f.broker.set('owner', f.request())
    const legacy = JSON.parse(await readFile(f.store.path, 'utf8')); delete legacy.commands[0].audit; delete legacy.permissionEvents
    await writeFile(f.store.path, JSON.stringify(legacy))
    expect(deviceCommandSchema.parse(legacy.commands[0]).audit).toBeUndefined()
    const duplicate = await f.broker.set('owner', result.request); expect(duplicate.audit).toBeUndefined(); expect(f.adapter.calls).toHaveLength(1)
    await f.registry.revoke('audit-grant')
    expect(await f.store.transaction(l => l.permissionEvents?.map(e => e.action), false)).toEqual(['revoke'])
  })
  it('never hides older unresolved commands behind the recent terminal-history window', async () => {
    const f = await fixture(), base = await f.broker.set('owner', f.request())
    const oldUnknown = { ...base, commandId: randomUUID(), status: 'unknown' as const, updatedAt: 1 }
    const terminal = Array.from({ length: 40 }, (_, i) => ({ ...base, commandId: randomUUID(), updatedAt: i + 100 }))
    const projection = projectCommandHistory([oldUnknown, ...terminal])
    expect(projection.commands).toHaveLength(31); expect(projection.commands[0]?.commandId).toBe(oldUnknown.commandId)
    expect(projection).toMatchObject({ unresolvedCount: 1, totalCount: 41, terminalHistoryTruncated: true })
  })
})

it.skipIf(process.platform === 'win32')('retains local pending-command and revocation evidence when disabled or missing HA credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-host-audit-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const service = new HostDeviceService(dir); cleanup.push(() => service.close())
  await service.configure({ enabled: true, mode: 'simulator' }); await service.discover(); await service.enroll({ deviceId: 'sim:light' })
  const grant = (await service.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
  const result = await service.executeTool('device.set', { deviceId: 'sim:light', requestId: 'host-audit', desiredState: { power: true }, authorizationRef: grant.authorizationRef, deadline: Date.now() + 5000 }, context()) as any
  expect(result.audit.origin).toMatchObject({ entryPoint: 'host-executor', epoch: service.getEpoch() }); expect(result.audit.origin.hostInstanceId).toMatch(/^[a-f0-9-]{36}$/)
  const store = new DeviceStore(join(dir, 'device-use', 'simulator-ledger.json'))
  await store.transaction(l => { const command = l.commands[0]!; command.status = 'unknown'; command.reason = 'DEVICE_SEND_UNCERTAIN'; command.timeline.push({ status: 'unknown', at: Date.now(), reason: command.reason }); for (let i = 0; i < 35; i++) l.commands.push({ ...structuredClone(result), commandId: randomUUID(), request: { ...result.request, requestId: `terminal-${i}` }, status: 'observed' }) })
  await service.configure({ enabled: false, mode: 'simulator' })
  let status = await service.status(); expect(status.commands.some(c => c.commandId === result.commandId && c.status === 'unknown')).toBe(true)
  expect(status).toMatchObject({ enabled: false, unresolvedCount: 1, terminalHistoryTruncated: true })
  expect(status.permissionEvents.map(e => e.action)).toContain('revoke')
  await service.configure({ enabled: true, mode: 'home-assistant' }); status = await service.status()
  expect(status.ready).toBe(false); expect(status.credentials).toBe('not-configured'); expect(status.commands.some(c => c.commandId === result.commandId)).toBe(true)
  expect((await store.transaction(l => l.commands.find(c => c.commandId === result.commandId)!, false)).audit).toEqual(result.audit)
})


it.skipIf(process.platform === 'win32')('can inspect and revoke a persisted HA grant without connecting or handing off credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-revoke-offline-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const service = new HostDeviceService(dir); cleanup.push(() => service.close())
  await service.configure({ enabled: true, mode: 'home-assistant' })
  const store = new DeviceStore(join(dir, 'device-use', 'home-assistant-ledger.json')), registry = new DeviceRegistry(store)
  const template = (await new SimulatedDeviceAdapter().discover())[0]!
  const device = { ...template, deviceId: 'home-assistant:home:light.test', adapter: 'home-assistant', homeId: 'home' }
  await registry.discover([device]); await registry.enroll(device.deviceId)
  await registry.grant({ authorizationRef: 'offline-ha-grant', principal: 'local-owner', deviceId: device.deviceId, actions: ['power'], expiresAt: Date.now() + 60000 })
  expect(await service.status()).toMatchObject({ ready: false, credentials: 'not-configured', grants: [{ authorizationRef: 'offline-ha-grant' }] })
  const revoked = await service.revoke({ authorizationRef: 'offline-ha-grant' })
  expect(revoked.grants).toEqual([]); expect(revoked.ready).toBe(false)
  expect(await store.transaction(l => l.permissionEvents?.map(e => e.action), false)).toEqual(['grant', 'revoke'])
  expect(await store.transaction(l => l.commands, false)).toEqual([])
})
