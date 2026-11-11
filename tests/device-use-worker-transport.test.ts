import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startH5WorkWorker, startAdmittedH5WorkWorker } from '../packages/server/src/h5/work-worker.js'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { createDeviceCapabilityPack } from '../packages/server/src/device-use/pack.js'
import type { DeviceBroker } from '../packages/server/src/device-use/broker.js'
const fixture = fileURLToPath(new URL('./fixtures/device-use-worker.mjs', import.meta.url))
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work() })
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'pulse-device-transport-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir }
async function activation() { return createDeviceCapabilityPack({} as DeviceBroker, 'local-owner').activate({ workspaceRoot: '/tmp', config: {}, signal: new AbortController().signal }) }
async function collect(handle: Awaited<ReturnType<typeof startH5WorkWorker>>) { const seen = []; for await (const event of handle.events) if (event.type === 'text') seen.push(JSON.parse(event.data as string)); await handle.outcome(); return seen }
it('runs the child device tool through only its captured parent executor', async () => {
  const dir = await directory(), active = await activation(), execute = vi.fn(async () => ({ parentOnly: true }))
  const handle = await startH5WorkWorker({ entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask', deviceUse: { tools: active.tools.map(t => t.manifest), instructions: [], execute } }, { conversationId: 'device-ipc', text: 'read' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  expect(await collect(handle)).toMatchObject([{ ok: true, value: { parentOnly: true } }]); expect(execute).toHaveBeenCalledTimes(1)
  expect(execute.mock.calls[0]?.[0]).toBe('device.list')
})
it('rejects a child message from a different session and closes it before returning outcome', async () => {
  const dir = await directory(), active = await activation(), execute = vi.fn(async () => ({}))
  const handle = await startH5WorkWorker({ entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask', deviceUse: { tools: active.tools.map(t => t.manifest), instructions: [], execute } }, { conversationId: 'device-ipc', text: 'wrong-session' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  await expect(handle.outcome()).rejects.toThrow('DEVICE_IPC_SCOPE'); expect(handle.isActive?.()).toBe(false); expect(execute).not.toHaveBeenCalled()
})
it('validates inputs in the parent even if a child bypasses the remote tool schema', async () => {
  const dir = await directory(), active = await activation(), execute = vi.fn(async () => ({}))
  const handle = await startH5WorkWorker({ entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask', deviceUse: { tools: active.tools.map(t => t.manifest), instructions: [], execute } }, { conversationId: 'device-ipc', text: 'invalid-input' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  expect(await collect(handle)).toMatchObject([{ ok: false, error: 'DEVICE_IPC_INPUT_INVALID' }]); expect(execute).not.toHaveBeenCalled()
})
it('uses the admitted production launcher to control a simulator through the shared parent ledger', async () => {
  const dir = await directory(), service = new HostDeviceService(dir); cleanup.push(() => service.close())
  await service.configure({ enabled: true, mode: 'simulator' }); await service.discover(); await service.enroll({ deviceId: 'sim:light' }); await service.grant({ deviceId: 'sim:light', actions: ['power', 'brightness'], expiresInMinutes: 10, brightnessMax: 40 })
  let admitted = false
  const original = service.activation.bind(service)
  vi.spyOn(service, 'activation').mockImplementation(async () => { expect(admitted).toBe(true); return original() })
  const host = { deviceUse: service, scheduleTask: async (_conversation: string, input: object, launch: (input: object, permit: object) => Promise<unknown>) => { admitted = true; return launch({ ...input, runId: 'run-device-admitted' }, { runId: 'run-device-admitted' }) } }
  const handle = await startAdmittedH5WorkWorker(host as any, { entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask' }, { conversationId: 'device-admitted', text: 'control' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  expect(await collect(handle)).toMatchObject([{ ok: true, value: { status: 'observed', evidence: { source: 'simulator', state: { power: true, brightness: 30 } } } }])
  const ledger = JSON.parse(await readFile(join(dir, 'device-use', 'simulator-ledger.json'), 'utf8'))
  expect(ledger.commands).toHaveLength(1); expect(ledger.commands[0].principal).toBe('local-owner')
})
it('does not expose device tools to a disabled worker session', async () => {
  const dir = await directory(), service = new HostDeviceService(dir); cleanup.push(() => service.close())
  const host = { deviceUse: service, scheduleTask: async (_conversation: string, input: object, launch: (input: object, permit: object) => Promise<unknown>) => launch(input, { runId: 'run-device-disabled' }) }
  const handle = await startAdmittedH5WorkWorker(host as any, { entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask' }, { conversationId: 'device-disabled', text: 'read' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  expect(await collect(handle)).toEqual([{ disabled: true }]); expect((await service.status()).commands).toEqual([])
})

it('wires the actual runH5WorkWorker bootstrap to parent-only device tools', async () => {
  const dir = await directory(), active = await activation(), execute = vi.fn(async () => ({ parentOnly: true, actualWorkerBootstrap: true }))
  const entry = fileURLToPath(new URL('./fixtures/device-use-runtime-worker.mjs', import.meta.url))
  const handle = await startH5WorkWorker({ entry, dataDir: dir, cwd: dir, approvalMode: 'ask', deviceUse: { tools: active.tools.map(t => t.manifest), instructions: [], execute } }, { conversationId: 'device-bootstrap', text: 'read' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  expect(await collect(handle)).toEqual([{ parentOnly: true, actualWorkerBootstrap: true }]); expect(execute).toHaveBeenCalledTimes(1)
})
