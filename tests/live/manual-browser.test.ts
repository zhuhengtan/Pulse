import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'

it.runIf(process.env.PULSE_MANUAL_BROWSER_LIVE === '1')('opens workspace webpages in Electron without enabling AI browser tools', async () => {
 const require = createRequire(new URL('../../packages/server/package.json', import.meta.url))
 const playwright = createRequire(require.resolve('@playwright/mcp'))('playwright')
 const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-manual-browser-live-'))), workspace = join(root, 'workspace'), dataDir = join(root, 'data')
 await mkdir(workspace)
 const host = createLocalHost({ cwd: workspace, dataDir, allowNetwork: true, enabledCapabilityPacks: [], automation: { browser: { channel: 'chrome' } } })
 const server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
 const website = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>Manual browser ready</title><h1>Manual browser ready</h1><p>AI browser tools remain disabled.</p>') })
 let desktop: any
 try {
  await new Promise<void>(resolve => website.listen(0, '127.0.0.1', resolve))
  const info = await server.start(), base = `http://127.0.0.1:${info.port}`
  const local = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const cookie = local.headers.get('set-cookie')!.split(';')[0]!
  const project = await fetch(base + '/api/projects', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Manual browser fixture', cwd: workspace }) }).then(r => r.json()) as { id: string }
  const conversation = await host.createConversation({ title: 'Manual browser regression', projectId: project.id })
  const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(root, 'electron'), PULSE_DESKTOP_DATA_DIR: dataDir, PULSE_HOME: join(root, 'home'), PULSE_DESKTOP_DEV_URL: `${process.env.PULSE_MANUAL_BROWSER_VITE ?? 'http://127.0.0.1:5174'}/work/${conversation.id}?workspace=preview` }
  delete env.ELECTRON_RUN_AS_NODE
  const electronPath = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron')
  desktop = await playwright._electron.launch({ executablePath: electronPath, args: [fileURLToPath(new URL('../../packages/desktop', import.meta.url))], env, timeout: 20000 })
  const page = await desktop.firstWindow()
  await page.getByRole('heading', { name: '工具', exact: true }).waitFor()
  const localAddress = `127.0.0.1:${(website.address() as { port: number }).port}`
  await page.getByRole('textbox', { name: '浏览器地址' }).fill(localAddress)
  await page.getByRole('button', { name: '前往', exact: true }).click()
  console.log('Manual browser launch', JSON.stringify(await page.evaluate(async () => ({ url: location.href, alerts: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent), options: await (window as any).pulseDesktop.request('/api/automation/sessions') }))))
  await expect.poll(() => host.automation.list().find(item => item.state === 'human')?.title, { timeout: 30000 }).toBe('Manual browser ready')
  await expect.poll(() => page.locator('.automation-frame').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth), { timeout: 10000 }).toBeGreaterThan(300)
  expect(host.getAutomationOptions().enabled).toEqual([])
  expect(await page.locator('.workspace-error,[role="alert"]').count()).toBe(0)
  await page.getByRole('button', { name: '刷新网页', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: '前往', exact: true }).isEnabled()).toBe(true)
  await page.screenshot({ path: join(tmpdir(), 'pulse-manual-browser-local.png') })
  if (process.env.PULSE_MANUAL_BROWSER_EXTERNAL === '1') {
   await page.getByRole('textbox', { name: '浏览器地址' }).fill('www.baidu.com')
   await page.getByRole('button', { name: '前往', exact: true }).click()
   await expect.poll(() => host.automation.list().find(item => item.state === 'human')?.title, { timeout: 30000 }).toContain('百度')
   await expect.poll(() => page.getByRole('button', { name: '前往', exact: true }).isEnabled(), { timeout: 15000 }).toBe(true)
   await expect.poll(() => page.locator('.automation-frame').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth), { timeout: 10000 }).toBeGreaterThan(300)
   expect(await page.locator('.workspace-error,[role="alert"]').count()).toBe(0)
   await page.screenshot({ path: join(tmpdir(), 'pulse-manual-browser-baidu.png') })
  }
  const before = await page.evaluate(async () => { const value = await (window as any).pulseDesktop.request('/api/session'); return value.body.deviceId })
  const devicesBefore = await server.listDevices()
  expect(devicesBefore.find(device => device.id === before)?.clientType).toBe('electron')
  await desktop.close(); desktop = undefined
  desktop = await playwright._electron.launch({ executablePath: electronPath, args: [fileURLToPath(new URL('../../packages/desktop', import.meta.url))], env: { ...env, PULSE_DESKTOP_DEV_URL: `${process.env.PULSE_MANUAL_BROWSER_VITE ?? 'http://127.0.0.1:5174'}/settings/devices` }, timeout: 20000 })
  const reopened = await desktop.firstWindow()
  await reopened.getByText('当前设备', { exact: true }).waitFor()
  const after = await reopened.evaluate(async () => { const value = await (window as any).pulseDesktop.request('/api/session'); return value.body.deviceId })
  expect(after).toBe(before)
  expect(await server.listDevices()).toHaveLength(devicesBefore.length)
  expect(await reopened.getByRole('switch').count()).toBe(0)
  await reopened.getByRole('button', { name: '扫码连接', exact: true }).click()
  await reopened.getByRole('img', { name: 'H5 连接二维码' }).waitFor()
  await reopened.screenshot({ path: join(tmpdir(), 'pulse-device-pairing-electron.png') })
  const pairingUrl = new URL(await reopened.getByRole('textbox', { name: 'H5 连接地址' }).inputValue())
  const pairResponse = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'iPhone Mobile Safari' }, body: JSON.stringify({ code: pairingUrl.searchParams.get('code') }) })
  expect(pairResponse.status).toBe(200)
  const paired = await pairResponse.json() as { deviceId: string }
  const pairedCookie = pairResponse.headers.get('set-cookie')!.split(';')[0]!
  await reopened.getByText('H5', { exact: true }).waitFor({ timeout: 10000 })
  await reopened.getByRole('button', { name: '刷新二维码', exact: true }).click()
  await reopened.getByRole('img', { name: 'H5 连接二维码' }).waitFor()
  const nextPairingUrl = new URL(await reopened.getByRole('textbox', { name: 'H5 连接地址' }).inputValue())
  expect(nextPairingUrl.searchParams.get('code')).not.toBe(pairingUrl.searchParams.get('code'))
  const rePair = await fetch(base + '/api/pair', { method: 'POST', headers: { Cookie: pairedCookie, 'Content-Type': 'application/json', 'User-Agent': 'iPhone Mobile Safari' }, body: JSON.stringify({ code: nextPairingUrl.searchParams.get('code') }) }).then(r => r.json()) as { deviceId: string }
  expect(rePair.deviceId).toBe(paired.deviceId)
  expect(await server.listDevices()).toHaveLength(devicesBefore.length + 1)
  await reopened.getByRole('button', { name: '完成', exact: true }).click()
  await reopened.screenshot({ path: join(tmpdir(), 'pulse-device-types-electron.png') })
  await reopened.setViewportSize({ width: 390, height: 844 })
  await reopened.screenshot({ path: join(tmpdir(), 'pulse-device-types-mobile.png') })
  expect(await reopened.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  console.log(JSON.stringify({ electron: true, rememberedAfterRelaunch: before === after, duplicateRecordsAdded: 0, devicePairingDialog: true, h5PairingReused: true, aiBrowserToolsEnabled: host.getAutomationOptions().enabled, localPage: true, baidu: process.env.PULSE_MANUAL_BROWSER_EXTERNAL === '1' }))
 } catch (error) {
  if (desktop) { const page = await desktop.firstWindow(); console.log('Manual browser failure', await page.locator('body').innerText()); await page.screenshot({ path: join(tmpdir(), 'pulse-manual-browser-failure.png') }) }
  throw error
 } finally {
  await desktop?.close(); await server.stop(); await host.close()
  await new Promise<void>(resolve => website.close(() => resolve()))
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
 }
}, 120000)
