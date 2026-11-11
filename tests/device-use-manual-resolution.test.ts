import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { SimulatedDeviceAdapter } from '../packages/server/src/device-use/simulator.js'
import { DeviceStore } from '../packages/server/src/device-use/store.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
const context = (): ToolContext => ({ toolCallId: 'test-tool', effectId: 'effect', attemptId: 'attempt', agentId: 'agent', laneId: 'lane', signal: new AbortController().signal, emit: () => {} })
async function fixture(pending?: Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-manual-device-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const host = new HostDeviceService(dir); cleanup.push(() => host.close())
  await host.configure({ enabled: true, mode: 'simulator' }); await host.discover(); await host.enroll({ deviceId: 'sim:light' })
  const grant = (await host.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
  const original = SimulatedDeviceAdapter.prototype.set
  const set = vi.spyOn(SimulatedDeviceAdapter.prototype, 'set').mockImplementationOnce(async function (device, state, ctx) {
    if (pending) { await pending; return { status: 'sent' } }
    await original.call(this, device, state, ctx); throw new Error('fixture reply lost')
  })
  const input = { deviceId: 'sim:light', requestId: 'original', desiredState: { power: true }, deadline: Date.now() + (pending ? 800 : 5000), authorizationRef: grant.authorizationRef }
  const command = await host.executeTool('device.set', input, context()) as any
  expect(command.status).toBe('unknown')
  const store = new DeviceStore(join(dir, 'device-use', 'simulator-ledger.json'))
  const disable = () => host.configure({ enabled: false, mode: 'simulator' })
  const preview = () => host.previewManualResolution({ commandId: command.commandId }, 'session-a')
  const confirm = (value: Awaited<ReturnType<typeof preview>>, binding = 'session-a') => host.confirmManualResolution({ commandId: command.commandId, challengeId: value.challengeId, deviceId: 'sim:light' }, binding)
  return { dir, host, store, set, input, command, grant, disable, preview, confirm }
}
describe.skipIf(process.platform === 'win32')('trusted per-command manual isolation handling', () => {
  it('retains original unknown/audit, is idempotent and does not reconnect, restore grants or replay; a new explicit grant/request is needed', async () => {
    const f = await fixture(), old = await f.host.activation(); await f.disable()
    const preview = await f.preview()
    expect(preview).toMatchObject({ commandId: f.command.commandId, device: { deviceId: 'sim:light' }, desiredState: { power: true } })
    expect(preview.warning).toContain('旧动作仍可能迟到')
    let status = await f.confirm(preview)
    expect(status).toMatchObject({ enabled: false, ready: false, grants: [], unresolvedCount: 1, blockingCount: 0, manuallyReleasedCount: 1 })
    const released = status.commands[0]!
    expect(released.manualDisposition).toMatchObject({ source: 'trusted-local-admin', action: 'release-isolation', commandFingerprint: f.command.fingerprint })
    expect({ ...released, manualDisposition: undefined }).toEqual({ ...f.command, manualDisposition: undefined })
    expect((await f.confirm(preview)).commands[0]).toEqual(released); expect(f.set).toHaveBeenCalledTimes(1)
    expect((await f.host.reconcile({ commandId: f.command.commandId })).reconciliation.outcome).toBe('manually-released')
    expect((await f.store.transaction(l => l.commands[0], false))).toEqual(released)
    await expect(old.tools[0]!.execute({}, context())).rejects.toThrow('DEVICE_HOST_DISABLED_OR_CHANGED')
    await f.host.close(); const next = new HostDeviceService(f.dir); cleanup.push(() => next.close())
    expect((await next.status()).commands[0]).toEqual(released)
    await next.configure({ enabled: true, mode: 'simulator' })
    expect((await next.executeTool('device.set', f.input, context()) as any).commandId).toBe(f.command.commandId)
    expect((await next.executeTool('device.set', { ...f.input, requestId: 'no-restored-grant', deadline: Date.now() + 5000 }, context()) as any).reason).toBe('DEVICE_NOT_AUTHORIZED')
    const grant = (await next.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
    expect((await next.executeTool('device.set', { ...f.input, requestId: 'independent-new-request', deadline: Date.now() + 5000, desiredState: { power: false }, authorizationRef: grant.authorizationRef }, context()) as any).status).toBe('observed')
    expect(f.set).toHaveBeenCalledTimes(2)
  })
  it('requires disable/revoke first, leaves preview/cancellation read-only and exposes no model management tool', async () => {
    const f = await fixture()
    await expect(f.preview()).rejects.toThrow('DEVICE_MANUAL_DISABLE_AND_REVOKE_FIRST')
    expect((await f.host.activation()).tools.map(t => t.manifest.name).some(name => /manual|resolution/.test(name))).toBe(false)
    await expect(f.host.executeTool('device.set', { ...f.input, manualDisposition: { action: 'release-isolation' } }, context())).rejects.toThrow()
    await expect(f.host.confirmManualResolution({ commandId: f.command.commandId, deviceId: 'sim:light', confirmed: true }, 'session-a')).rejects.toThrow()
    await f.disable(); await f.preview()
    expect(await f.store.transaction(l => l.commands[0], false)).toEqual(f.command); expect(f.set).toHaveBeenCalledTimes(1)
  })
  it('binds the confirmation to the authenticated session, exact command/device, epoch and expiry', async () => {
    const f = await fixture(); await f.disable(); const preview = await f.preview()
    await expect(f.confirm(preview, 'session-b')).rejects.toThrow('DEVICE_MANUAL_CONFIRMATION_INVALID')
    await expect(f.host.confirmManualResolution({ commandId: randomUUID(), challengeId: preview.challengeId, deviceId: 'sim:light' }, 'session-a')).rejects.toThrow('DEVICE_MANUAL_CONFIRMATION_INVALID')
    await expect(f.host.confirmManualResolution({ commandId: f.command.commandId, challengeId: preview.challengeId, deviceId: 'sim:temperature' }, 'session-a')).rejects.toThrow('DEVICE_MANUAL_CONFIRMATION_INVALID')
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 121000)
    await expect(f.confirm(preview)).rejects.toThrow('DEVICE_MANUAL_CONFIRMATION_INVALID')
    expect(await f.store.transaction(l => l.commands[0], false)).toEqual(f.command)
  })
  it('rejects changed records and newly active grants at the final atomic check', async () => {
    const f = await fixture(); await f.disable(); const first = await f.preview()
    await f.store.transaction(l => { l.commands[0]!.reason = 'fixture changed since preview' })
    await expect(f.confirm(first)).rejects.toThrow('DEVICE_MANUAL_PREVIEW_STALE')
    const second = await f.preview(); await f.store.transaction(l => { l.grants.push(f.grant) })
    await expect(f.confirm(second)).rejects.toThrow('DEVICE_MANUAL_DISABLE_AND_REVOKE_FIRST')
    expect((await f.store.transaction(l => l.commands[0], false))!.manualDisposition).toBeUndefined()
  })
  it('cannot clear an unsettled local dispatch after timeout, even after disable', async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve })
    try {
      const f = await fixture(pending); await f.disable(); const preview = await f.preview()
      await expect(f.confirm(preview)).rejects.toThrow('DEVICE_MANUAL_DISPATCH_NOT_QUIESCENT')
      expect((await f.store.transaction(l => l.commands[0], false))!.manualDisposition).toBeUndefined()
      release(); await new Promise(resolve => setTimeout(resolve, 0))
      expect((await f.confirm(await f.preview())).blockingCount).toBe(0)
      expect(f.set).toHaveBeenCalledTimes(1)
    } finally { release?.() }
  })
  it.each(['missing-audit', 'high-risk-target', 'sent', 'other-owner'])('refuses unsupported or non-owned record: %s', async kind => {
    const f = await fixture(); await f.disable()
    await f.store.transaction(l => { const c = l.commands[0]!; if (kind === 'missing-audit') delete c.audit; else if (kind === 'high-risk-target') c.request.desiredState = { targetTemperatureC: 30 }; else if (kind === 'sent') c.status = 'sent'; else c.principal = 'other-owner' })
    await expect(f.preview()).rejects.toThrow(kind === 'other-owner' ? 'DEVICE_COMMAND_NOT_FOUND' : 'DEVICE_MANUAL_RECORD_UNSUPPORTED')
    expect(f.set).toHaveBeenCalledTimes(1)
  })
  it('releases only the selected command; another unknown for the same device continues blocking', async () => {
    const f = await fixture(); await f.disable(); const otherId = randomUUID()
    await f.store.transaction(l => { l.commands.push({ ...structuredClone(f.command), commandId: otherId, request: { ...f.command.request, requestId: 'another-pending', desiredState: { power: false } } }) })
    const status = await f.confirm(await f.preview())
    expect(status).toMatchObject({ unresolvedCount: 2, blockingCount: 1, manuallyReleasedCount: 1 })
    expect(status.commands.find(c => c.commandId === otherId)?.manualDisposition).toBeUndefined()
    await f.host.configure({ enabled: true, mode: 'simulator' }); const grant = (await f.host.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
    expect((await f.host.executeTool('device.set', { ...f.input, requestId: 'still-blocked', deadline: Date.now() + 5000, authorizationRef: grant.authorizationRef }, context()) as any).reason).toBe('DEVICE_UNRESOLVED_PREVIOUS_COMMAND')
    expect(f.set).toHaveBeenCalledTimes(1)
  })
  it('rejects previews from an older enablement epoch or Host lifetime', async () => {
    const f = await fixture(); await f.disable(); const preview = await f.preview()
    await f.host.configure({ enabled: true, mode: 'simulator' }); await f.disable()
    await expect(f.confirm(preview)).rejects.toThrow('DEVICE_MANUAL_CONFIRMATION_INVALID')
    const nextPreview = await f.preview(); await f.host.close()
    const next = new HostDeviceService(f.dir); cleanup.push(() => next.close())
    await expect(next.confirmManualResolution({ commandId: f.command.commandId, challengeId: nextPreview.challengeId, deviceId: 'sim:light' }, 'session-a')).rejects.toThrow('DEVICE_MANUAL_CONFIRMATION_INVALID')
    expect((await next.status()).commands[0]?.manualDisposition).toBeUndefined()
  })

})

it.skipIf(process.platform === 'win32')('requires authenticated same-origin local management for the real preview/confirm HTTP routes', async () => {
  const { createLocalHost, H5Server } = await import('../packages/server/src/index.js')
  const dir = await mkdtemp(join(tmpdir(), 'pulse-manual-http-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), jarvis: { enabled: false } })
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: join(dir, 'data') }); cleanup.push(async () => { await server.stop(); await host.close() })
  const base = `http://127.0.0.1:${(await server.start()).port}`
  const path = `${base}/api/device-use/manual-resolution`
  expect((await fetch(`${path}/preview`, { method: 'POST', body: '{}' })).status).toBe(401)
  const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
  const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
  await host.deviceUse.configure({ enabled: true, mode: 'simulator' }); await host.deviceUse.discover(); await host.deviceUse.enroll({ deviceId: 'sim:light' })
  const grant = (await host.deviceUse.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
  const set = vi.spyOn(SimulatedDeviceAdapter.prototype, 'set').mockRejectedValueOnce(new Error('fixture uncertain'))
  const command = await host.deviceUse.executeTool('device.set', { deviceId: 'sim:light', requestId: 'http-original', desiredState: { power: true }, deadline: Date.now() + 5000, authorizationRef: grant.authorizationRef }, context()) as any
  await host.deviceUse.configure({ enabled: false, mode: 'simulator' })
  const body = JSON.stringify({ commandId: command.commandId })
  expect((await fetch(`${path}/preview`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status).toBe(403)
  const response = await fetch(`${path}/preview`, { method: 'POST', headers, body }); expect(response.headers.get('cache-control')).toBe('no-store')
  const preview = await response.json() as any; expect(preview.commandId).toBe(command.commandId); expect(preview.warning).toContain('迟到')
  const confirmBody = JSON.stringify({ commandId: command.commandId, challengeId: preview.challengeId, deviceId: 'sim:light' })
  expect((await fetch(`${path}/confirm`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: confirmBody })).status).toBe(403)
  const result = await fetch(`${path}/confirm`, { method: 'POST', headers, body: confirmBody }); expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ enabled: false, grants: [], unresolvedCount: 1, blockingCount: 0, commands: [{ status: 'unknown', manualDisposition: { source: 'trusted-local-admin' } }] })
  expect(set).toHaveBeenCalledTimes(1)
})
