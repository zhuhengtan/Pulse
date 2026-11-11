import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { HomeAssistantAdapter } from '../packages/server/src/device-use/home-assistant.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const context = (): ToolContext => ({ toolCallId: 'test-tool', effectId: 'test-effect', attemptId: 'test-attempt', agentId: 'test-agent', laneId: 'test-lane', signal: new AbortController().signal, emit: () => {} })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-device-host-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const service = new HostDeviceService(dir); cleanup.push(() => service.close())
  return { dir, service }
}
async function light(service: HostDeviceService) {
  await service.configure({ enabled: true, mode: 'simulator' }); await service.discover(); await service.enroll({ deviceId: 'sim:light', roomId: 'living-room', aliases: ['模拟灯'] })
  const status = await service.grant({ deviceId: 'sim:light', actions: ['power', 'brightness'], expiresInMinutes: 10, brightnessMax: 40 })
  return status.grants[0]!
}
describe.skipIf(process.platform === 'win32')('trusted Device Use host', () => {
  it('defaults disabled without writing a ledger, and never invents real hardware availability', async () => {
    const { service, dir } = await fixture()
    expect(await service.status()).toMatchObject({ enabled: false, ready: false, status: 'disabled', realHardwareVerified: false, devices: [], grants: [] })
    expect((await service.activation()).tools).toEqual([])
    expect(await readdir(dir)).toEqual([])
    await expect(service.executeTool('device.set', {}, context())).rejects.toThrow('DEVICE_TOOL_UNAVAILABLE')
  })
  it('requires explicit enrollment and scoped grant then exposes usable references, limited target receipts and revoke', async () => {
    const { service } = await fixture(); await service.configure({ enabled: true, mode: 'simulator' }); await service.discover()
    await expect(service.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).rejects.toThrow('DEVICE_NOT_ENROLLED')
    const grant = await light(service)
    const listing = await service.executeTool('device.list', {}, context()) as any
    expect(listing).toMatchObject({ simulated: true, realHardwareVerified: false }); expect(listing.grants[0].authorizationRef).toBe(grant.authorizationRef)
    const input = { deviceId: 'sim:light', requestId: 'host-set', desiredState: { power: true, brightness: 30 }, deadline: Date.now() + 5000, authorizationRef: grant.authorizationRef }
    const receipt = await service.executeTool('device.set', input, context()) as any
    expect(receipt.status).toBe('observed'); expect(receipt.evidence.source).toBe('simulator')
    expect((await service.executeTool('device.set', { ...input, requestId: 'too-bright', desiredState: { brightness: 50 } }, context()) as any).reason).toBe('DEVICE_GRANT_LIMIT')
    await service.revoke({ authorizationRef: grant.authorizationRef })
    expect((await service.executeTool('device.set', { ...input, requestId: 'revoked' }, context()) as any).reason).toBe('DEVICE_NOT_AUTHORIZED')
  })
  it('restores simulated state/version across disable, re-enable and a fresh Host process lifetime', async () => {
    const { service, dir } = await fixture(); let grant = await light(service)
    const send = (target: number, ref: string, requestId: string, source = service) => source.executeTool('device.set', { deviceId: 'sim:light', requestId, desiredState: { power: true, brightness: target }, deadline: Date.now() + 5000, authorizationRef: ref }, context()) as Promise<any>
    const first = await send(30, grant.authorizationRef, 'before-disable'); expect(first.status).toBe('observed')
    await service.configure({ enabled: false, mode: 'simulator' }); await service.configure({ enabled: true, mode: 'simulator' })
    grant = (await service.grant({ deviceId: 'sim:light', actions: ['power', 'brightness'], expiresInMinutes: 10 })).grants[0]!
    const second = await send(20, grant.authorizationRef, 'after-reenable'); expect(second.status).toBe('observed'); expect(second.evidence.stateVersion).toBeGreaterThan(first.evidence.stateVersion)
    await service.close(); const next = new HostDeviceService(dir); cleanup.push(() => next.close())
    const third = await send(10, grant.authorizationRef, 'after-restart', next); expect(third.status).toBe('observed'); expect(third.evidence.stateVersion).toBeGreaterThan(second.evidence.stateVersion)
  })
  it('does not let a second living Host recover or close another Hosts broker', async () => {
    const { service, dir } = await fixture(); await light(service)
    const second = new HostDeviceService(dir); cleanup.push(() => second.close())
    await expect(second.status()).rejects.toThrow('DEVICE_HOST_ALREADY_RUNNING'); await second.close()
    expect((await service.activation()).tools).toHaveLength(7)
  })
  it('blocks high-risk/non-light authorization and refuses model-selected principal or confirmation booleans', async () => {
    const { service } = await fixture(); await light(service); await service.enroll({ deviceId: 'sim:thermostat' })
    await expect(service.grant({ deviceId: 'sim:thermostat', actions: ['power'], expiresInMinutes: 10 })).rejects.toThrow('DEVICE_HOST_HIGH_RISK_UNSUPPORTED')
    await expect(service.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10, principal: 'attacker' })).rejects.toThrow()
    await expect(service.configure({ enabled: true, mode: 'simulator', confirm: true })).rejects.toThrow()
    expect((await service.activation()).tools.map(t => t.manifest.name)).not.toContain('device.grant')
  })
  it('invalidates old packs and worker epochs, revokes grants and cannot revive old permissions after re-enable', async () => {
    const { service } = await fixture(); await light(service); const old = await service.activation(), epoch = service.getEpoch()
    await service.configure({ enabled: false, mode: 'simulator' })
    await expect(old.tools[0]!.execute({}, context())).rejects.toThrow('DEVICE_HOST_DISABLED_OR_CHANGED')
    await service.configure({ enabled: true, mode: 'simulator' })
    await expect(service.executeTool('device.list', {}, context(), epoch)).rejects.toThrow('DEVICE_HOST_DISABLED_OR_CHANGED')
    expect((await service.status()).grants).toEqual([])
    await expect(service.executeTool('device.grant', {}, context())).rejects.toThrow('DEVICE_TOOL_UNAVAILABLE')
  })
  it('rejects an old worker epoch when settings change while activation is awaiting new tools', async () => {
    const { service } = await fixture(); await light(service)
    const oldEpoch = service.getEpoch(), activate = service.activation.bind(service)
    let entered!: () => void, resume!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { resume = resolve })
    const executed = vi.fn()
    vi.spyOn(service, 'activation').mockImplementationOnce(async () => {
      entered(); await gate
      // Model the dangerous schedule: activation returns a valid NEW-generation tool.
      const activation = await activate()
      return { ...activation, tools: activation.tools.map(tool => ({ ...tool, execute: async (input, ctx) => { executed(); return tool.execute(input, ctx) } })) }
    })
    const result = service.executeTool('device.list', {}, context(), oldEpoch)
    // Attach rejection handling before advancing the deterministic race.
    const rejected = expect(result).rejects.toThrow('DEVICE_HOST_DISABLED_OR_CHANGED')
    await waiting
    await service.configure({ enabled: false, mode: 'simulator' })
    await service.configure({ enabled: true, mode: 'simulator' })
    const currentGrant = (await service.grant({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 10 })).grants[0]!
    expect(service.getEpoch()).toBeGreaterThan(oldEpoch)
    resume(); await rejected
    expect(executed).not.toHaveBeenCalled()
    const current = await service.executeTool('device.list', {}, context(), service.getEpoch()) as any
    expect(current.grants.map((grant: any) => grant.authorizationRef)).toContain(currentGrant.authorizationRef)
    expect((await service.status()).commands).toEqual([])
  })
  it('recovers only once despite concurrent activation/status, and closes every old pack', async () => {
    const { service } = await fixture(); await light(service)
    const recovered = vi.spyOn((await import('../packages/server/src/device-use/broker.js')).DeviceBroker.prototype, 'recover')
    await Promise.all([service.status(), service.activation(), service.activation(), service.status()]); expect(recovered).not.toHaveBeenCalled()
    const tools = (await service.activation()).tools; await service.close(); await expect(tools[0]!.execute({}, context())).rejects.toThrow('DEVICE_HOST_DISABLED_OR_CHANGED')
  })
  it('fails closed on corrupt settings and on HA restart without an explicit credential handoff', async () => {
    const { service, dir } = await fixture(); await service.configure({ enabled: true, mode: 'home-assistant' })
    expect(await service.status()).toMatchObject({ ready: false, credentials: 'not-configured', status: 'credentials-required' }); expect((await service.activation()).tools).toEqual([])
    await service.close(); await writeFile(join(dir, 'device-use', 'settings.json'), '{broken')
    const next = new HostDeviceService(dir); cleanup.push(() => next.close()); await expect(next.status()).rejects.toThrow('DEVICE_HOST_SETTINGS_INVALID')
  })
  it('never persists or exposes handed-off HA secrets, and sanitizes a failed connection', async () => {
    const { service, dir } = await fixture(), secret = 'test-token-do-not-leak'
    vi.spyOn(HomeAssistantAdapter.prototype, 'discover').mockRejectedValue(new Error(`raw error ${secret}`))
    await expect(service.connectHomeAssistant({ homeId: 'test-home', baseUrl: 'https://test.example', token: secret, entities: [{ entityId: 'light.test' }] })).rejects.toThrow('DEVICE_HA_CONNECTION_FAILED')
    expect(JSON.stringify(await service.status())).not.toContain(secret)
    expect(await readFile(join(dir, 'device-use', 'settings.json'), 'utf8')).not.toContain(secret)
    expect((await service.status()).enabled).toBe(false)
  })
  it('handles repeated/concurrent disable and status without retaining a usable pack', async () => {
    const { service } = await fixture(); await light(service); const old = await service.activation()
    await Promise.all([service.status(), service.configure({ enabled: false, mode: 'simulator' }), service.configure({ enabled: false, mode: 'simulator' })])
    expect(await service.status()).toMatchObject({ enabled: false, ready: false })
    await expect(old.tools[0]!.execute({}, context())).rejects.toThrow('DEVICE_HOST_DISABLED_OR_CHANGED')
  })
})

it.skipIf(process.platform === 'win32')('protects Device Use settings over real loopback HTTP with local scope and same-origin enforcement', async () => {
  const { dir } = await fixture(), host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), jarvis: { enabled: false } })
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: join(dir, 'data') }); cleanup.push(async () => { await server.stop(); await host.close() })
  const base = `http://127.0.0.1:${(await server.start()).port}`
  expect((await fetch(`${base}/api/device-use/status`)).status).toBe(401)
  const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
  const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
  expect((await fetch(`${base}/api/device-use/config`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ enabled: true, mode: 'simulator' }) })).status).toBe(403)
  const config = await fetch(`${base}/api/device-use/config`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, mode: 'simulator' }) }); expect(config.status).toBe(200); expect(config.headers.get('cache-control')).toBe('no-store')
  expect((await fetch(`${base}/api/device-use/discover`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
  const status = await (await fetch(`${base}/api/device-use/status`, { headers })).json() as any; expect(status.devices).toHaveLength(3); expect(status.grants).toEqual([])
  expect((await fetch(`${base}/api/device-use/grant`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'sim:light', actions: ['power'], expiresInMinutes: 60, token: 'test-secret' }) })).status).toBe(400)
  expect((await fetch(`${base}/api/device-use/reconcile`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ commandId: '00000000-0000-4000-8000-000000000000' }) })).status).toBe(403)
  const missing = await fetch(`${base}/api/device-use/reconcile`, { method: 'POST', headers, body: JSON.stringify({ commandId: '00000000-0000-4000-8000-000000000000' }) })
  expect(missing.status).toBe(400); expect(await missing.json()).toEqual({ error: 'DEVICE_COMMAND_NOT_FOUND' })

})

it.skipIf(process.platform === 'win32')('offers the seven device tools to assistant/voice turns only after local enablement', async () => {
  const { dir } = await fixture(), seen: string[][] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const body = JSON.parse(String(options.body)); seen.push(body.tools?.map((t: any) => t.function.name) ?? [])
    return new Response(JSON.stringify({ choices: [{ message: { content: 'fixture response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  }))
  const profile = { provider: 'openai-compatible' as const, defaultModel: 'fixture', baseURL: 'http://127.0.0.1:12345/v1' }
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: profile, providerProfiles: { fixture: profile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', jarvis: { enabled: false } }); cleanup.push(() => host.close())
  const conversation = await host.createConversation()
  let run = await host.sendMessage(conversation.id, { text: '有哪些设备？', assistantChat: true }); for await (const _ of run.events) {} await run.outcome()
  expect(seen.flat()).not.toContain('device_list'); seen.length = 0
  await light(host.deviceUse)
  run = await host.sendMessage(conversation.id, { text: '有哪些模拟设备？', assistantChat: true }); for await (const _ of run.events) {} await run.outcome()
  expect(seen.flat()).toContain('device_list'); expect(seen.flat()).toContain('device_set'); expect(seen.flat()).not.toContain('device_grant')
})

it.skipIf(process.platform !== 'win32')('fails closed where trusted private storage ACLs are not yet implemented', async () => { const { service } = await fixture(); expect((await service.activation()).tools).toEqual([]); await expect(service.configure({ enabled: true, mode: 'simulator' })).rejects.toThrow('DEVICE_HOST_PRIVATE_STORAGE_UNSUPPORTED'); expect((await service.activation()).tools).toEqual([]) })

it.skipIf(process.platform === 'win32').each([false, true])('preserves the assistant external-action approval boundary (approved=%s)', async approved => {
  const { dir } = await fixture()
  const profile = { provider: 'openai-compatible' as const, defaultModel: 'fixture', baseURL: 'http://127.0.0.1:12345/v1' }
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: profile, providerProfiles: { fixture: profile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', approvalMode: 'ask', jarvis: { enabled: false } }); cleanup.push(() => host.close())
  const grant = await light(host.deviceUse); let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    const tool = calls++ === 0
    const message = tool ? { content: '', tool_calls: [{ id: 'device-action', function: { name: 'device_set', arguments: JSON.stringify({ deviceId: 'sim:light', requestId: `approval-${approved}`, desiredState: { power: true, brightness: 30 }, deadline: Date.now() + 10000, authorizationRef: grant.authorizationRef }) } }] } : { content: 'fixture result' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  }))
  const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '把模拟灯设为30%，先按配置审批', assistantChat: true })
  let asked = false
  for await (const event of run.events) if (event.type === 'waiting') {
    expect((await host.deviceUse.status()).commands).toHaveLength(0)
    const pending = await run.pendingInteractions(); expect(pending[0]?.kind).toBe('approval'); asked = true
    await run.reply(pending[0]!.items[0]!.effectId, { approved })
  }
  await run.outcome(); expect(asked).toBe(true)
  const commands = (await host.deviceUse.status()).commands
  if (approved) expect(commands).toMatchObject([{ status: 'observed', evidence: { source: 'simulator' } }]); else expect(commands).toEqual([])
})
