/** Offline SDK example: no network, accounts or physical actions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, DeviceRegistry, DeviceBroker, SimulatedDeviceAdapter, createDeviceCapabilityPack } from '../packages/server/src/device-use/index.js'

const directory = await mkdtemp(join(tmpdir(), 'pulse-device-example-'))
const registry = new DeviceRegistry(new DeviceStore(join(directory, 'ledger.json')))
const broker = new DeviceBroker(registry, [new SimulatedDeviceAdapter()])
try {
  await broker.recover()
  await broker.discover()
  // Only trusted Host onboarding calls these after user approval. The model cannot.
  await registry.enroll('sim:light', { roomId: 'living-room', aliases: ['主灯'] })
  await registry.grant({ authorizationRef: 'simulation-lamp-grant', principal: 'demo-owner', deviceId: 'sim:light', actions: ['power', 'brightness'], limits: { brightness: { min: 0, max: 60 } }, expiresAt: Date.now() + 60_000 })
  const pack = createDeviceCapabilityPack(broker, 'demo-owner')
  console.log('Register this host-installed pack explicitly:', pack.manifest.id)
  const command = await broker.set('demo-owner', { requestId: 'demo-lamp-30', deviceId: 'sim:light', desiredState: { power: true, brightness: 30 }, deadline: Date.now() + 5_000, authorizationRef: 'simulation-lamp-grant' })
  console.log(JSON.stringify({ simulated: true, commandId: command.commandId, status: command.status, evidence: command.evidence }, null, 2))
  await registry.revoke('simulation-lamp-grant')
} finally { await broker.close(); await rm(directory, { recursive: true, force: true }) }
