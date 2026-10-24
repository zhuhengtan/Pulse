import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'


import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'

it.runIf(process.env.PULSE_WORKSPACE_BROWSER_LIVE === '1')('browses without a project, closes the last tab and never opens an external window', async () => {
 const require = createRequire(new URL('../../packages/server/package.json', import.meta.url))
 const playwright = createRequire(require.resolve('@playwright/mcp'))('playwright')
 const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-workspace-browser-'))), dataDir = join(root, 'data')
 vi.stubEnv('PULSE_BROWSER_EXECUTABLE', playwright.chromium.executablePath())
 const host = createLocalHost({ cwd: root, dataDir, allowNetwork: true, enabledCapabilityPacks: [] })
 const server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
 const website = createServer((request, response) => { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end(`<title>Page ${request.url === '/two' ? 'Two' : 'One'}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>@media(max-width:600px){body{background:rgb(240,240,255)}}</style><h1>Embedded browser</h1><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('h1').textContent='Clicked '+document.querySelector('input').value">Apply</button><a href="/two" target="_blank">Popup</a>`) })
 let desktop: any
 try {
  const serverInfo = await server.start(); await new Promise<void>(resolve => website.listen(0,'127.0.0.1',resolve))
  const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(root,'electron'), PULSE_DESKTOP_DATA_DIR: dataDir, PULSE_HOME: join(root,'home'), PULSE_DESKTOP_DEV_URL: 'http://127.0.0.1:5174/work/new?workspace=preview' }
  delete env.ELECTRON_RUN_AS_NODE
  desktop = await playwright._electron.launch({ executablePath: createRequire(new URL('../../packages/desktop/package.json',import.meta.url))('electron'), args: [fileURLToPath(new URL('../../packages/desktop',import.meta.url))], env, timeout: 25000 })
  const page = await desktop.firstWindow()
  await page.getByRole('heading',{name:'工具',exact:true}).waitFor()
  await page.getByRole('button',{name:'关闭 新标签页 标签',exact:true}).click()
  await expect.poll(() => page.getByRole('complementary',{name:'独立工作区'}).count()).toBe(0)
  await page.getByRole('button',{name:'工作区',exact:true}).click()
  const address = `http://127.0.0.1:${(website.address() as {port:number}).port}`
  async function navigate(suffix: string) {
   await page.getByRole('textbox',{name:'浏览器地址'}).fill(address + suffix)
   await page.getByRole('button',{name:'前往',exact:true}).click()
  }
  await expect.poll(()=>host.automation.nativeBrowserAvailable).toBe(true)
  await navigate('/one')
  await page.getByRole('tab',{name:'Page One',exact:true}).waitFor({timeout:30000})
  const live = () => host.automation.list().filter(item=>item.state!=='closed')
  expect(live()).toHaveLength(1); expect(live()[0]?.projectId).toBeUndefined()
  expect(live()[0]?.tabs?.items).toHaveLength(1)
  expect(live()[0]?.mode).toBe('native')
  expect(await page.locator('.automation-frame').count()).toBe(0)
  const nativePage = (expression: string) => desktop.evaluate(async ({webContents}:any, expression:string) => {
   const native = webContents.getAllWebContents().find((wc:any)=>wc.getURL().includes('/one'))
   if(!native) throw new Error('NATIVE_PAGE_MISSING')
   return native.executeJavaScript(expression)
  }, expression)
  await expect.poll(()=>nativePage('innerWidth')).toBeGreaterThan(300)
  const rect = await page.getByLabel('原生网页视口').boundingBox()
  expect(Math.abs(await nativePage('innerWidth')-rect.width)).toBeLessThanOrEqual(1)
  expect(await nativePage('typeof window.pulseDesktop')).toBe('undefined')
  expect(await nativePage('typeof require')).toBe('undefined')
  await page.setViewportSize({width:1100,height:850})
  await expect.poll(async()=>Math.abs(await nativePage('innerWidth')-(await page.getByLabel('原生网页视口').boundingBox()).width)).toBeLessThanOrEqual(1)
  // Browser Use goes through the session manager and changes this exact native DOM.
  const id = live()[0]!.id, owner = 'test-native-agent'
  await host.automation.control(id,'resume',owner)
  // Standalone manual sessions retain their device owner; use that owner for the agent API.
  const agentOwner = live()[0]!.owner
  let observation = await host.automation.observe(id,agentOwner) as any
  const ref = String(observation.text).match(/\[(e[^\]]+)\] text(?:box| field) Name/i)?.[1]
  expect(ref, observation.text).toBeTruthy()
  await host.automation.act(id,observation.frameId,{type:'element',ref,operation:'fill',value:'Native'},'fill-native',agentOwner)
  expect(await nativePage("document.querySelector('input').value")).toBe('Native')
  observation = await host.automation.observe(id,agentOwner) as any
  const button = String(observation.text).match(/\[(e[^\]]+)\] button Apply/)?.[1]
  await host.automation.act(id,observation.frameId,{type:'element',ref:button,operation:'click'},'click-native',agentOwner)
  await expect.poll(()=>nativePage("document.querySelector('h1').textContent")).toBe('Clicked Native')
  await page.getByRole('button',{name:'接管',exact:true}).click()
  await expect.poll(()=>live()[0]?.state).toBe('human')
  await nativePage("document.querySelector('a').click()")
  await page.getByRole('tab',{name:'Page Two',exact:true}).waitFor()
  expect(await desktop.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().length)).toBe(1)
  await page.getByRole('button',{name:'关闭网页 Page Two',exact:true}).click()
  await expect.poll(()=>live()[0]?.tabs?.items.length).toBe(1)
  await page.getByRole('button',{name:'新建标签页',exact:true}).click()
  await navigate('/two')
  await page.getByRole('tab',{name:'Page Two',exact:true}).waitFor({timeout:20000})
  expect(live()[0]?.tabs?.items).toHaveLength(2)
  expect(live()[0]?.tabs?.items.some(item=>item.url==='about:blank')).toBe(false)
  await expect.poll(()=>desktop.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].contentView.children.filter((view:any)=>view.getVisible()).length)).toBe(1)
  await writeFile(join(tmpdir(),'pulse-native-browser-tabs.png'),Buffer.from(await desktop.evaluate(async ({BrowserWindow}:any)=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')),'base64'))
  await page.getByRole('button',{name:'关闭网页 Page Two',exact:true}).click()
  await expect.poll(()=>live()[0]?.tabs?.items.length,{timeout:10000}).toBe(1)
  await page.getByRole('button',{name:'关闭网页 Page One',exact:true}).click()
  await expect.poll(()=>page.getByRole('complementary',{name:'独立工作区'}).count(),{timeout:15000}).toBe(0)
  expect(live()).toHaveLength(0)
  await new Promise(resolve=>setTimeout(resolve,2500))
  expect(live()).toHaveLength(0)
  await expect.poll(()=>desktop.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].contentView.children.length)).toBe(0)
  await page.getByRole('button',{name:'工作区',exact:true}).click()
  await page.getByRole('tablist',{name:'工作窗口标签'}).getByRole('tab',{name:'新标签页',exact:true}).waitFor()
  expect(await page.getByRole('tablist',{name:'工作窗口标签'}).getByRole('tab').count()).toBe(1)
  expect(live()).toHaveLength(0)
  await navigate('/one')
  await page.getByRole('tab',{name:'Page One',exact:true}).waitFor({timeout:20000})
  const state = live()[0]!, control = await host.automation.control(state.id,'takeover',state.controller!)
  await expect(host.automation.manualCommand(state.id,'navigate',{url:`http://127.0.0.2:${serverInfo.port}/`},control.controller!,String(control.lease))).rejects.toThrow('BROWSER_NETWORK_NOT_ALLOWED')
  await expect(host.automation.manualCommand(state.id,'navigate',{url:'file:///etc/passwd'},control.controller!,String(control.lease))).rejects.toThrow('BROWSER_NETWORK_NOT_ALLOWED')
  await page.getByRole('button',{name:'新建标签页',exact:true}).click()
  await page.getByRole('button',{name:'关闭工作区',exact:true}).click()
  await expect.poll(()=>live().length,{timeout:15000}).toBe(0)
  await expect.poll(()=>page.getByRole('complementary',{name:'独立工作区'}).count()).toBe(0)
  console.log(JSON.stringify({electron:true,noProject:true,nativeView:true,samePageAutomation:true,responsiveViewport:true,noInitialBlankTab:true,closeLastHidesPanel:true,closeAllStopsSessions:true,noRespawn:true}))
 } catch(error) { if(desktop) console.log('NATIVE_TEST_DIAGNOSTIC', await desktop.evaluate(({webContents,BrowserWindow}:any)=>({windows:BrowserWindow.getAllWindows().length, pages:webContents.getAllWebContents().map((wc:any)=>({type:wc.getType(),url:wc.getURL()}))})), await (await desktop.firstWindow()).locator('[role=alert]').allTextContents()); throw error
 } finally {
  await desktop?.close(); await server.stop(); await host.close()
  await new Promise<void>(resolve=>website.close(()=>resolve()))
  vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})
 }
},100000)
