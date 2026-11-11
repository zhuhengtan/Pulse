import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { DeviceBroker } from '../packages/server/src/device-use/broker.js'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { HomeAssistantAdapter } from '../packages/server/src/device-use/home-assistant.js'
import { SimulatedDeviceAdapter } from '../packages/server/src/device-use/simulator.js'
import { DeviceStore } from '../packages/server/src/device-use/store.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
const context = (): ToolContext => ({ toolCallId: 'test-tool', effectId: 'test-effect', attemptId: 'test-attempt', agentId: 'test-agent', laneId: 'test-lane', signal: new AbortController().signal, emit: () => {} })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-reconcile-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const service = new HostDeviceService(dir); cleanup.push(() => service.close())
  await service.configure({ enabled: true, mode: 'simulator' }); await service.discover(); await service.enroll({ deviceId: 'sim:light' })
  const grant = (await service.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
  const original = SimulatedDeviceAdapter.prototype.set
  const set = vi.spyOn(SimulatedDeviceAdapter.prototype, 'set').mockImplementationOnce(async function (device, desired, ctx) {
    await original.call(this, device, desired, ctx)
    throw new Error('fixture lost response after send')
  })
  const command = await service.executeTool('device.set', { deviceId: 'sim:light', requestId: 'original-uncertain', desiredState: { power: true }, deadline: Date.now() + 5000, authorizationRef: grant.authorizationRef }, context()) as any
  expect(command.status).toBe('unknown'); expect(set).toHaveBeenCalledTimes(1)
  const store = new DeviceStore(join(dir, 'device-use', 'simulator-ledger.json'))
  return { dir, service, grant, command, set, store }
}
describe.skipIf(process.platform === 'win32')('local command reconciliation never resends', () => {
  it('only reads fresh matching state after revoke, preserves identity/audit and never creates or dispatches another command', async () => {
    const f = await fixture(); await f.service.revoke({ authorizationRef: f.grant.authorizationRef })
    const read = vi.spyOn(SimulatedDeviceAdapter.prototype, 'read')
    const result = await f.service.reconcile({ commandId: f.command.commandId })
    expect(result.reconciliation).toMatchObject({ commandId: f.command.commandId, outcome: 'observed' })
    expect(result.unresolvedCount).toBe(0); expect(read).toHaveBeenCalledTimes(1); expect(f.set).toHaveBeenCalledTimes(1)
    expect(result.commands[0]).toMatchObject({ commandId: f.command.commandId, request: f.command.request, audit: f.command.audit, status: 'observed', evidence: { source: 'simulator' } })
    const again = await f.service.reconcile({ commandId: f.command.commandId })
    expect(again.reconciliation.outcome).toBe('not-pending'); expect(read).toHaveBeenCalledTimes(1)
    expect(await f.store.transaction(l => l.commands.length, false)).toBe(1)
  })
  it.each(['offline', 'stale', 'state-mismatch', 'read-timeout', 'read-failed'] as const)('reports %s without changing uncertain evidence or dispatching', async outcome => {
    const f = await fixture()
    const read = vi.spyOn(DeviceBroker.prototype, 'read')
    if (outcome === 'read-failed' || outcome === 'read-timeout') read.mockRejectedValue(new Error(outcome === 'read-timeout' ? 'DEVICE_READ_TIMEOUT' : 'fixture-secret must not leak'))
    else read.mockResolvedValue({ deviceId: 'sim:light', availability: outcome === 'offline' ? 'offline' : 'online', observedAt: Date.now(), stateVersion: 20, state: { power: outcome !== 'state-mismatch' }, source: 'fixture', stale: outcome === 'stale' })
    const result = await f.service.reconcile({ commandId: f.command.commandId })
    expect(result.reconciliation.outcome).toBe(outcome); expect(result.unresolvedCount).toBe(1)
    expect(result.commands[0]).toEqual(f.command)
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(read).toHaveBeenCalledTimes(1); expect(f.set).toHaveBeenCalledTimes(1)
    expect(await f.store.transaction(l => l.commands, false)).toEqual([f.command])
  })
  it('keeps disabled and inactive-adapter records inspectable without reads, automatic enablement or dispatch', async () => {
    const f = await fixture(), read = vi.spyOn(SimulatedDeviceAdapter.prototype, 'read')
    await f.service.configure({ enabled: false, mode: 'simulator' })
    expect((await f.service.reconcile({ commandId: f.command.commandId })).reconciliation.outcome).toBe('disabled')
    await f.service.configure({ enabled: true, mode: 'home-assistant' })
    expect((await f.service.reconcile({ commandId: f.command.commandId })).reconciliation.outcome).toBe('mode-not-active')
    expect(read).not.toHaveBeenCalled(); expect(f.set).toHaveBeenCalledTimes(1)
    expect((await f.service.status()).commands[0]?.status).toBe('unknown')
  })
  it('preserves missing-credential and unverified old-connection HA evidence without borrowing the current gateway', async () => {
    const f = await fixture()
    await f.service.configure({ enabled: true, mode: 'home-assistant' })
    const haStore = new DeviceStore(join(f.dir, 'device-use', 'home-assistant-ledger.json'))
    const commandId = randomUUID(), deviceId = 'home-assistant:fixture:light.test'
    const device = { ...(await new SimulatedDeviceAdapter().discover())[0]!, deviceId, adapter: 'home-assistant', homeId: 'fixture' }
    await haStore.transaction(l => { l.devices.push(device); l.enrolled.push(deviceId); l.commands.push({ ...structuredClone(f.command), commandId, request: { ...f.command.request, deviceId } }) })
    const read = vi.spyOn(HomeAssistantAdapter.prototype, 'read')
    expect((await f.service.reconcile({ commandId })).reconciliation.outcome).toBe('credentials-required')
    vi.spyOn(HomeAssistantAdapter.prototype, 'discover').mockResolvedValue([device]); vi.spyOn(HomeAssistantAdapter.prototype, 'startEvents').mockResolvedValue()
    await f.service.connectHomeAssistant({ homeId: 'fixture', baseUrl: 'https://fixture.example', token: 'fixture-only-token', entities: [{ entityId: 'light.test' }] })
    expect((await f.service.reconcile({ commandId })).reconciliation.outcome).toBe('connection-unverified')
    expect((await f.service.executeTool('device.command.status', { commandId, reconcile: true }, context()) as any).status).toBe('unknown')
    expect(read).not.toHaveBeenCalled(); expect(f.set).toHaveBeenCalledTimes(1)
    expect(await haStore.transaction(l => l.commands[0]?.status, false)).toBe('unknown')
  })
  it('does not dispatch accepted commands or disclose another principal, and rejects additional request fields', async () => {
    const f = await fixture(), read = vi.spyOn(SimulatedDeviceAdapter.prototype, 'read')
    await f.store.transaction(l => { l.commands[0]!.status = 'accepted'; delete l.commands[0]!.sentAt })
    expect((await f.service.reconcile({ commandId: f.command.commandId })).reconciliation.outcome).toBe('not-sent')
    await expect(f.service.reconcile({ commandId: f.command.commandId, principal: 'another-owner', retry: true })).rejects.toThrow()
    await f.store.transaction(l => { l.commands[0]!.principal = 'another-owner' })
    await expect(f.service.reconcile({ commandId: f.command.commandId })).rejects.toThrow('DEVICE_COMMAND_NOT_FOUND')
    expect(read).not.toHaveBeenCalled(); expect(f.set).toHaveBeenCalledTimes(1)
  })
})
