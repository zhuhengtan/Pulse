import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { H5AuthStore, H5Server, createLocalHost } from '../packages/server/src/index.js'

it('remembers valid credentials across store reload and re-pairing without merging by name', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-device-identity-'))
 try {
  const auth = new H5AuthStore(root)
  const local = await auth.getOrCreateLocalDevice(undefined, 'electron')
  const reload = new H5AuthStore(root)
  expect((await reload.getOrCreateLocalDevice(local.token, 'electron')).device.id).toBe(local.device.id)
  const first = await reload.pairDeviceWithCode(reload.createPairingCode().code, 'Same name', undefined, 'h5')
  const repeated = await reload.pairDeviceWithCode(reload.createPairingCode().code, 'Same name', first!.token, 'h5')
  expect(repeated!.device.id).toBe(first!.device.id)
  expect(repeated!.token).toBe(first!.token)
  const different = await reload.pairDeviceWithCode(reload.createPairingCode().code, 'Same name', undefined, 'web')
  expect(different!.device.id).not.toBe(first!.device.id)
  expect(await reload.listDevices()).toHaveLength(3)
  await reload.revokeDevice(first!.device.id)
  expect(await reload.authenticateToken(first!.token)).toBeUndefined()
  const reconnect = await reload.pairDeviceWithCode(reload.createPairingCode().code, 'Same name', first!.token, 'h5')
  expect(reconnect!.device.id).not.toBe(first!.device.id)
  expect((await reload.listDevices()).some(d => 'tokenHash' in d)).toBe(false)
 } finally { await rm(root, { recursive: true, force: true }) }
})
it('leaves unclassified legacy records intact and refreshes metadata when they reconnect', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-legacy-device-'))
 try {
  const auth = new H5AuthStore(root), local = await auth.getOrCreateLocalDevice()
  const { clientType: _clientType, ...legacy } = local.device
  await writeFile(join(root, 'h5-devices.json'), JSON.stringify([legacy]))
  const loaded = new H5AuthStore(root)
  expect((await loaded.listDevices())[0]?.clientType).toBeUndefined()
  await loaded.getOrCreateLocalDevice(local.token, 'electron')
  expect(await loaded.listDevices()).toMatchObject([{ id: local.device.id, clientType: 'electron', scope: 'local' }])
 } finally { await rm(root, { recursive: true, force: true }) }
})
it('classifies Web/H5/Electron over HTTP and metadata never grants local administrator scope', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-device-http-'))
 const host = createLocalHost({ cwd: root, dataDir: root }), server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0 })
 try {
  const { port } = await server.start(), base = `http://127.0.0.1:${port}`
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base, 'X-Pulse-Client': 'electron' } })
  const localCookie = local.headers.get('set-cookie')!.split(';')[0]!
  const web = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base, 'User-Agent': 'Desktop Chrome' } })
  const code = server.createPairingCode().code
  const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { Origin: base, 'User-Agent': 'Android Mobile', 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
  const phoneCookie = paired.headers.get('set-cookie')!.split(';')[0]!
  const types = (await server.listDevices()).map(d => d.clientType)
  expect(types).toEqual(['electron', 'web', 'h5'])
  const replay = await fetch(base + '/api/pair', { method: 'POST', headers: { Cookie: phoneCookie, Origin: base, 'User-Agent': 'Android Mobile', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code }) })
  expect((await replay.json() as any).deviceId).toBe((await paired.json() as any).deviceId)
  expect(await server.listDevices()).toHaveLength(3)
  const spoofed = await fetch(base + '/api/session', { headers: { Cookie: phoneCookie, 'X-Pulse-Client': 'electron' } }).then(r => r.json()) as any
  expect(spoofed.localAdmin).toBe(false)
  expect((await fetch(base + '/api/devices', { headers: { Cookie: localCookie } })).status).toBe(200)
  expect(web.status).toBe(200)
 } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
