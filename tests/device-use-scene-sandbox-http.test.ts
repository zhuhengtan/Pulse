import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
it('keeps scene sandbox isolated behind local-admin same-origin control, with preview-bound idempotent runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-scene-sandbox-http-'))
  const host = createLocalHost({ cwd: dir, dataDir: dir, jarvis: { enabled: false } })
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: dir })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`, endpoint = base + '/api/device-use/scene-sandbox'
    expect((await fetch(endpoint)).status).toBe(401)
    const login = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: login.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    let response = await fetch(endpoint, { headers }); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toMatchObject({ enabled: false, simulated: true, realDevices: false })
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{"action":"enable"}' })).status).toBe(403)
    const remoteSession = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Isolated remote browser fixture' }) })
    const remote = { Cookie: remoteSession.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    expect((await fetch(endpoint, { headers: remote })).status).toBe(403)
    expect((await fetch(endpoint, { method: 'POST', headers: remote, body: '{"action":"enable"}' })).status).toBe(403)
    const post = (body: unknown) => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    response = await post({ action: 'enable', token: 'MUST_NOT_ECHO' }); expect(response.status).toBe(400); expect(await response.text()).not.toContain('MUST_NOT_ECHO')
    expect((await post({ action: 'enable' })).status).toBe(200)
    response = await post({ action: 'configure', name: 'Offline only', steps: [{ deviceId: 'scene:lamp-a', desiredState: { power: true, brightness: 25 } }, { deviceId: 'scene:lamp-b', desiredState: { brightness: 40 } }] }); expect(response.status).toBe(200)
    const p = (await (await post({ action: 'preview' })).json()).preview
    expect(p.atomic).toBe(false)
    expect((await fetch(base + '/api/device-use/status', { headers }).then(r => r.json())).commands).toEqual([])
    const payload = { action: 'execute', previewId: p.previewId, version: p.version, fault: 'reject-second' }
    const first = await (await post(payload)).json(), second = await (await post(payload)).json()
    expect(first.run).toMatchObject({ status: 'completed', outcome: 'partial', atomic: false, steps: [{ status: 'observed' }, { status: 'failed' }] }); expect(second.run).toEqual(first.run)
    expect(first.devices[0].state).toMatchObject({ power: true, brightness: 25 })
    expect(first.devices[1].state).toMatchObject({ power: false, brightness: 0 })
    expect((await host.deviceUse.status()).enabled).toBe(false); expect((await host.deviceUse.status()).commands).toEqual([])
    expect((await host.deviceUse.activation()).tools).toEqual([])
    response = await post({ action: 'disable' }); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ enabled: false, cleanup: { state: 'completed' }, run: { outcome: 'partial' } })
  } finally { await server.stop(); await host.close(); await rm(dir, { recursive: true, force: true }) }
}, 15_000)
