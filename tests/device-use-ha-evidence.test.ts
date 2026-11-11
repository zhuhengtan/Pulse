import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { DeviceBroker } from '../packages/server/src/device-use/broker.js'
import { DeviceRegistry } from '../packages/server/src/device-use/registry.js'
import { TestDeviceStore } from './helpers/device-store.js'
import { HomeAssistantAdapter } from '../packages/server/src/device-use/home-assistant.js'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { createDeviceCapabilityPack } from '../packages/server/src/device-use/pack.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const context = (): ToolContext => ({ toolCallId: 'evidence-tool', effectId: 'evidence-effect', attemptId: 'attempt', agentId: 'agent', laneId: 'lane', signal: new AbortController().signal, emit: () => {} })
const snapshot = (updated: number, reported = updated, attributes: Record<string, unknown> = {}, state = 'on') => ({ entity_id: 'light.test', state, attributes: { ...attributes }, last_updated: new Date(updated).toISOString(), last_reported: new Date(reported).toISOString() })
async function fixture(id = 'home-assistant') {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-ha-evidence-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  let now = Date.now(), raw = snapshot(now - 1000)
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? [] : raw)))
  const adapter = new HomeAssistantAdapter({ id, homeId: 'fixture', baseUrl: 'https://fixture.example', entities: [{ entityId: 'light.test', writable: true }], getAccessToken: async () => 'fixture-token', fetch: request as typeof fetch, now: () => now })
  const store = new TestDeviceStore(join(dir, 'ledger.json')), registry = new DeviceRegistry(store, () => now)
  const broker = new DeviceBroker(registry, [adapter], { now: () => now, hostIdentity: { instanceId: randomUUID(), epoch: 1 }, confirmationWindowMs: 5 }); cleanup.push(() => broker.close())
  await broker.discover(); const device = (await registry.list())[0]!
  await registry.enroll(device.deviceId); await registry.grant({ authorizationRef: 'fixture-grant', principal: 'owner', deviceId: device.deviceId, actions: ['power'], expiresAt: now + 60000 })
  const input = { requestId: 'original', deviceId: device.deviceId, desiredState: { power: true }, deadline: now + 5000, authorizationRef: 'fixture-grant' }
  const command = await broker.set('owner', input)
  expect(command.status).toBe('unknown'); expect(device.capabilities.every(c => !c.confirmable)).toBe(true)
  return { dir, adapter, broker, registry, store, request, command, input, device, initial: now, advance() { now += 10; return now }, setRaw(value: typeof raw) { raw = value }, posts() { return request.mock.calls.filter(([, init]) => init?.method === 'POST').length } }
}
describe('HA gateway snapshots never confirm physical execution', () => {
  it.each(['same-state-report', 'retained-style-replay', 'assumed-state', 'attribute-only-update'] as const)('preserves unknown and conflict isolation for %s, including model reconciliation', async kind => {
    const f = await fixture(), at = f.advance()
    f.setRaw(kind === 'same-state-report' ? snapshot(f.initial - 1000, at) : snapshot(at, at, kind === 'assumed-state' ? { assumed_state: true } : kind === 'attribute-only-update' ? { link_quality: 99 } : {}))
    const result = await f.broker.reconcileResult('owner', f.command.commandId)
    expect(result.outcome).toBe('state-match-unverified'); expect(result.command).toEqual(f.command)
    const activation = await createDeviceCapabilityPack(f.broker, 'owner').activate({ workspaceRoot: f.dir, config: {}, signal: new AbortController().signal })
    const query = activation.tools.find(tool => tool.manifest.name === 'device.command.status')!
    expect((await query.execute({ commandId: f.command.commandId, reconcile: true }, context()) as any).status).toBe('unknown')
    const conflicting = await f.broker.set('owner', { ...f.input, requestId: 'conflicting', desiredState: { power: false } })
    expect(conflicting.reason).toBe('DEVICE_UNRESOLVED_PREVIOUS_COMMAND')
    expect((await f.broker.status('owner', f.command.commandId))).toEqual(f.command)
    expect((await f.broker.set('owner', f.input)).commandId).toBe(f.command.commandId)
    expect(f.posts()).toBe(1)
  })
  it('does not treat old timestamps on repeated MQTT-style values as fresh physical evidence', async () => {
    const f = await fixture(); f.advance()
    const result = await f.broker.reconcileResult('owner', f.command.commandId)
    expect(result.outcome).toBe('stale'); expect(result.command).toEqual(f.command); expect(f.posts()).toBe(1)
  })
  it('honors the trusted adapter declaration with custom IDs and legacy confirmable capability records', async () => {
    const f = await fixture('configured-ha-id'), at = f.advance(); f.setRaw(snapshot(at))
    await f.store.transaction(l => { for (const capability of l.devices[0]!.capabilities) capability.confirmable = true })
    expect((await f.broker.reconcileResult('owner', f.command.commandId)).outcome).toBe('state-match-unverified')
    expect((await f.broker.status('owner', f.command.commandId)).status).toBe('unknown'); expect(f.posts()).toBe(1)
  })
  it('marks an older REST response replaced by internal cache as stale, never new observation evidence', async () => {
    const f = await fixture(), at = f.advance(); f.setRaw(snapshot(at))
    expect((await f.broker.reconcileResult('owner', f.command.commandId)).outcome).toBe('state-match-unverified')
    f.setRaw(snapshot(f.initial - 2000, f.initial - 2000, {}, 'off'))
    expect(await f.broker.read(f.device.deviceId)).toMatchObject({ source: 'home-assistant:cache', stale: true, state: { power: true } })
    expect((await f.broker.reconcileResult('owner', f.command.commandId)).outcome).toBe('stale')
    expect((await f.broker.status('owner', f.command.commandId))).toEqual(f.command); expect(f.posts()).toBe(1)
  })
})
it.skipIf(process.platform === 'win32')('keeps the same current-connection HA command unresolved through trusted Host/UI and runtime-tool queries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-ha-host-evidence-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  let raw = snapshot(Date.now())
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? [] : raw)))
  vi.stubGlobal('fetch', request); vi.spyOn(HomeAssistantAdapter.prototype, 'startEvents').mockResolvedValue()
  const host = new HostDeviceService(dir); cleanup.push(() => host.close())
  const status = await host.connectHomeAssistant({ homeId: 'fixture', baseUrl: 'https://fixture.example', token: 'fixture-token', entities: [{ entityId: 'light.test', writable: true }] })
  const deviceId = status.devices[0]!.deviceId
  await host.enroll({ deviceId }); const grant = (await host.grant({ deviceId, actions: ['power'], expiresInMinutes: 10 })).grants[0]!
  const input = { deviceId, requestId: 'original', desiredState: { power: true }, deadline: Date.now() + 5000, authorizationRef: grant.authorizationRef }
  const command = await host.executeTool('device.set', input, context()) as any; expect(command.status).toBe('unknown')
  raw = snapshot(Date.now() + 1, Date.now() + 1, { assumed_state: true })
  const queried = await host.reconcile({ commandId: command.commandId })
  expect(queried.reconciliation.outcome).toBe('state-match-unverified'); expect(queried.unresolvedCount).toBe(1); expect(queried.commands[0]).toEqual(command)
  expect((await host.executeTool('device.command.status', { commandId: command.commandId, reconcile: true }, context()) as any).status).toBe('unknown')
  expect((await host.executeTool('device.set', { ...input, requestId: 'conflict', desiredState: { power: false } }, context()) as any).reason).toBe('DEVICE_UNRESOLVED_PREVIOUS_COMMAND')
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(request.mock.calls.every(([url, init]) => String(url) === `https://fixture.example${init?.method === 'POST' ? '/api/services/light/turn_on' : '/api/states/light.test'}`)).toBe(true)
})
