import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import type { NativeBrowserHost } from '../packages/server/src/automation/native-browser.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it('removes Browser Use from Web and H5 and revokes device access on removal', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-connected-browser-'))
 const host = createLocalHost({ cwd: root, dataDir: root, enabledCapabilityPacks: ['computer'] })
 const server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0 })
 const info = await server.start(), base = `http://127.0.0.1:${info.port}`
 try {
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const cookie = local.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }
  const project = await fetch(base + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Browser', cwd: root }) }).then(r => r.json()) as { id: string }
  const pair = server.createPairingCode()
  const response = await fetch(base + '/api/pair', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'User-Agent': 'Mobile Android' }, body: JSON.stringify({ code: pair.code, name: 'Phone' }) })
  const device = await response.json() as { deviceId: string }
  const phoneHeaders = { ...headers, Cookie: response.headers.get('set-cookie')!.split(';')[0]! }
  expect((await fetch(base + '/api/automation/sessions', { headers: phoneHeaders })).status).toBe(200)
  expect((await fetch(base + '/api/devices', { headers: phoneHeaders })).status).toBe(403)
  expect((await fetch(base + '/api/automation/permissions', { method: 'POST', headers: phoneHeaders, body: '{}' })).status).toBe(403)
  expect((await fetch(base + '/api/automation/sessions', { method: 'POST', headers: phoneHeaders, body: JSON.stringify({ kind: 'computer', projectId: project.id }) })).status).toBe(403)
  const opened = await fetch(base + '/api/automation/sessions', { method: 'POST', headers: phoneHeaders, body: JSON.stringify({ kind: 'browser', manual: true, projectId: project.id }) })
  expect(opened.status).toBe(403)
  const browser = await host.automation.open('browser', 'device:test', root,'dedicated')
  expect((await fetch(`${base}/api/automation/sessions/${browser.id}/control`, { method: 'POST', headers: phoneHeaders, body: '{"action":"takeover"}' })).status).toBe(403)
  // Desktop sessions stay local, including their list, frame and socket views.
  const desktop = await host.automation.open('computer', 'device:local-test', root)
  const visible = await fetch(base + '/api/automation/sessions', { headers: phoneHeaders }).then(r => r.json()) as { sessions: Array<{ id: string }> }
  expect(visible.sessions.some(item => item.id === desktop.id)).toBe(false)
  expect((await fetch(`${base}/api/automation/sessions/${desktop.id}/frame`, { headers: phoneHeaders })).status).toBe(403)
  expect((await fetch(`${base}/api/devices/${device.deviceId}/revoke`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
  expect((await fetch(base + '/api/automation/sessions', { headers: phoneHeaders })).status).toBe(401)
 } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('allows explicit manual browsing with AI tools disabled while retaining device, origin and network gates', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-manual-browser-'))
 const host = createLocalHost({ cwd: root, dataDir: root, allowNetwork: false, enabledCapabilityPacks: [] })
 const server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0 })
 const info = await server.start(), base = `http://127.0.0.1:${info.port}`
 try {
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base, 'X-Pulse-Client':'electron' } })
  const cookie = local.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-Pulse-Client':'electron' }
  const project = await fetch(base + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Browser fixture', cwd: root }) }).then(r => r.json()) as { id: string }
  expect(project.id).toBeTruthy()
  const detach = host.automation.setNativeHost({call: async (_method:string,params:any) => { if(params.method==='navigate' && params.params.url!=='about:blank') throw new Error('BROWSER_NETWORK_NOT_ALLOWED'); return {revision:'test',items:[{index:0,title:'Blank',url:'about:blank',active:true}]} }} as unknown as NativeBrowserHost)
  expect(detach).toBeTypeOf('function')
  const open = (body: unknown, origin = base) => fetch(base + '/api/automation/sessions', { method: 'POST', headers: { ...headers, Origin: origin }, body: JSON.stringify(body) })
  for (const mode of ['dedicated', 'existing']) expect((await open({ kind: 'browser', manual: true, mode })).status).toBe(403)
  const standalone = await open({ kind: 'browser', manual: true })
  expect(standalone.status).toBe(200)
  const standaloneSession = await standalone.json() as {id:string;workspace:string;projectId?:string;mode:string}
  expect(standaloneSession.mode).toBe('native')
  expect(standaloneSession.projectId).toBeUndefined()
  expect(standaloneSession.workspace).toContain(join(root,'automation','manual'))
  await fetch(`${base}/api/automation/sessions/${standaloneSession.id}/control`, {method:'POST',headers,body:'{"action":"close"}'})
  expect((await open({kind:'browser'})).status).toBe(403)
  expect((await open({kind:'computer',manual:true})).status).toBe(403)
  expect((await open({ kind: 'browser', projectId: project.id })).status).toBe(403)
  expect((await open({ kind: 'computer', manual: true, projectId: project.id })).status).toBe(403)
  expect((await open({ kind: 'browser', manual: true, projectId: project.id }, 'https://example.com')).status).toBe(403)
  const opened = await open({ kind: 'browser', manual: true, mode: 'native', projectId: project.id })
  expect(opened.status).toBe(200)
  const session = await opened.json() as { id: string }
  const control = await fetch(`${base}/api/automation/sessions/${session.id}/control`, { method: 'POST', headers, body: '{"action":"takeover"}' }).then(r => r.json()) as { lease: string }
  const blocked = await fetch(`${base}/api/automation/sessions/${session.id}/command`, { method: 'POST', headers, body: JSON.stringify({ lease: control.lease, method: 'navigate', params: { url: 'https://www.baidu.com' } }) })
  expect(await blocked.json()).toEqual({ error: 'BROWSER_NETWORK_NOT_ALLOWED' })
  const options = await fetch(base + '/api/automation/sessions', { headers }).then(r => r.json())
  expect(options).toMatchObject({ enabled: [], manualBrowser: true })
  host.applyLiveOptions({ cwd: root, dataDir: root, approvalMode: 'read-only' })
  expect((await open({ kind: 'browser', manual: true, projectId: project.id })).status).toBe(403)
 } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
