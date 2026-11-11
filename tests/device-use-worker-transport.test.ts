import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startH5WorkWorker, startAdmittedH5WorkWorker } from '../packages/server/src/h5/work-worker.js'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { createDeviceCapabilityPack } from '../packages/server/src/device-use/pack.js'
import { DeviceBroker } from '../packages/server/src/device-use/broker.js'
import { DeviceRegistry } from '../packages/server/src/device-use/registry.js'
import { SimulatedDeviceAdapter } from '../packages/server/src/device-use/simulator.js'
import { TestDeviceStore } from './helpers/device-store.js'
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
it('uses the admitted production launcher to control a simulator through a shared volatile parent ledger', async () => {
  const dir = await directory()
  // This transport fixture owns a volatile parent service, not private disk storage.
  // The real Host's POSIX persistence and Windows refusal are covered separately.
  const store = new TestDeviceStore(join(dir, 'simulator-ledger.json'), false), registry = new DeviceRegistry(store)
  const broker = new DeviceBroker(registry, [new SimulatedDeviceAdapter()]); cleanup.push(() => broker.close())
  await broker.discover(); await registry.enroll('sim:light')
  await registry.grant({ authorizationRef: 'worker-fixture-grant', principal: 'local-owner', deviceId: 'sim:light', actions: ['power', 'brightness'], expiresAt: Date.now() + 600_000, limits: { brightness: { min: 0, max: 40 } } })
  let admitted = false
  const active = await createDeviceCapabilityPack(broker, 'local-owner', { entryPoint: 'host-runtime' }).activate({ workspaceRoot: dir, config: {}, signal: new AbortController().signal })
  const service: Pick<HostDeviceService, 'getEpoch' | 'activation' | 'executeTool'> = {
    getEpoch: () => 0,
    activation: vi.fn(async () => { expect(admitted).toBe(true); return active }),
    executeTool: vi.fn(async (name, input, context, epoch) => {
      expect(admitted).toBe(true); expect(epoch).toBe(0)
      const tool = active.tools.find(tool => tool.manifest.name === name)
      if (!tool) throw new Error('DEVICE_TOOL_UNAVAILABLE')
      const result = await tool.execute(tool.validateInput ? tool.validateInput(input) : input, context)
      return name === 'device.list' ? { devices: result, grants: await store.transaction(l => l.grants, false) } : result
    }),
  }
  const host = { deviceUse: service, scheduleTask: async (_conversation: string, input: object, launch: (input: object, permit: object) => Promise<unknown>) => { admitted = true; return launch({ ...input, runId: 'run-device-admitted' }, { runId: 'run-device-admitted' }) } }
  const handle = await startAdmittedH5WorkWorker(host as any, { entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask' }, { conversationId: 'device-admitted', text: 'control' })
  cleanup.push(() => handle.shutdown?.() ?? Promise.resolve())
  const results = await collect(handle)
  expect(results).toMatchObject([{ ok: true, value: { status: 'observed', evidence: { source: 'simulator', state: { power: true, brightness: 30 } } } }])
  expect(service.activation).toHaveBeenCalledTimes(1)
  expect(vi.mocked(service.executeTool).mock.calls.map(call => call[0])).toEqual(['device.list', 'device.set'])
  const ledger = await store.reopen().transaction(l => l, false)
  expect(ledger.commands).toHaveLength(1); expect(ledger.commands[0]).toMatchObject({ commandId: results[0].value.commandId, principal: 'local-owner', status: 'observed', audit: { origin: { entryPoint: 'host-runtime', correlation: { toolCallId: 'fixture-call' } } } })
  expect(await readdir(dir)).not.toContain('simulator-ledger.json')
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
