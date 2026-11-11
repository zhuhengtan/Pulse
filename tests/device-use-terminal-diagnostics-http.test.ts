import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
it('exposes synthetic diagnostics only to local admin with same-origin mutation and no-store results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-terminal-diagnostics-http-'))
  const host = createLocalHost({ cwd: dir, dataDir: dir, jarvis: { enabled: false } })
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: dir })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`, path = base + '/api/device-use/terminal-diagnostics'
    expect((await fetch(path)).status).toBe(401)
    const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: local.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    let response = await fetch(path, { headers }); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toMatchObject({ enabled: false, productionListener: false, persistentPairing: false })
    expect((await fetch(path, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{"action":"enable"}' })).status).toBe(403)
    const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Isolated test browser' }) })
    const remote = { Cookie: paired.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    expect((await fetch(path, { headers: remote })).status).toBe(403)
    expect((await fetch(path, { method: 'POST', headers: remote, body: '{"action":"enable"}' })).status).toBe(403)
    response = await fetch(path, { method: 'POST', headers, body: '{"action":"enable","token":"MUST_NOT_ECHO"}' })
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('MUST_NOT_ECHO')
    expect((await (await fetch(path, { headers })).json()).enabled).toBe(false)
    expect((await fetch(path, { method: 'POST', headers, body: '{"action":"enable"}' })).status).toBe(200)
    response = await fetch(path, { method: 'POST', headers, body: '{"action":"run","scenario":"callback-quarantine"}' })
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ simulated: true, cleanup: { state: 'unconfirmed', pendingCallbacks: 1 } })
    response = await fetch(path, { method: 'POST', headers, body: '{"action":"disable"}' })
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ enabled: false, cleanup: { state: 'completed', pendingCallbacks: 0 } })
    expect((await host.deviceUse.status()).enabled).toBe(false)
    expect((await host.deviceUse.status()).commands).toEqual([])
  } finally { await server.stop(); await host.close(); await rm(dir, { recursive: true, force: true }) }
}, 15_000)
