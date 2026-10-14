import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { AutomationSessionManager } from '../../packages/server/src/automation/manager.js'

it.runIf(process.env.PULSE_EXTENSION_LIVE === '1')('attaches through the official extension to an isolated existing browser and preserves its session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-extension-live-'))
  const extension=process.env.PULSE_EXTENSION_PATH
  if(!extension)throw new Error('PULSE_EXTENSION_PATH_REQUIRED')
  const profile=join(root,'profile')
  const require=createRequire(new URL('../../packages/server/package.json',import.meta.url))
  const mcpRoot=dirname(require.resolve('@playwright/mcp/package.json'))
  const {chromium}=require(require.resolve('playwright',{paths:[mcpRoot]}))
  const executable=process.env.PULSE_EXTENSION_BROWSER??chromium.executablePath()
  const fixture=createServer((req,res)=>{
    if(req.url==='/login')res.setHeader('Set-Cookie','pulse_fixture=synthetic-login; HttpOnly; Path=/; Max-Age=3600')
    res.setHeader('content-type','text/html; charset=utf-8')
    const authenticated=req.url==='/login'||req.headers.cookie?.includes('pulse_fixture=synthetic-login')
    res.end(`<title>Extension Session Fixture</title><h1>${authenticated?'Synthetic session retained':'Missing session'}</h1><label>Message<input aria-label="Message"></label>`)
  })
  await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  const context=await chromium.launchPersistentContext(profile,{executablePath:executable,headless:false,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]})
  const manager=new AutomationSessionManager(root,{browser:{mode:'existing',args:[resolve(mcpRoot,'cli.js'),'--extension','--browser','chromium','--executable-path',executable,'--user-data-dir',profile,'--profile-dir-name','Default','--caps','vision','--image-responses','allow','--output-dir',join(root,'downloads')]}},true,undefined,['127.0.0.1'])
  try {
    await mkdir(join(root,'downloads'))
    const page=await context.newPage()
    const base=`http://127.0.0.1:${(fixture.address() as {port:number}).port}`
    await page.goto(base+'/login')
    await page.goto(base+'/account')
    await page.bringToFront()
    const session=await manager.open('browser','extension-live',root,'existing')
    const connectionPage=context.waitForEvent('page')
    const observation=manager.observe(session.id,'extension-live')
    void observation.catch(()=>undefined)
    const connect=await connectionPage
    await connect.waitForURL('chrome-extension://**/connect.html**')
    await connect.locator('.tab-item').filter({hasText:'Extension Session Fixture'}).getByRole('button',{name:'Allow & select'}).click()
    let frame=await observation
    for(let attempt=0;attempt<3;attempt++) {
      expect(frame.title).toBe('Extension Session Fixture')
      expect(String(frame.text).includes('Synthetic session retained')).toBe(true)
      const ref=String(frame.text).match(/textbox "Message" \[ref=(\w+)\]/)?.[1]
      expect(Boolean(ref)).toBe(true)
      try { await manager.act(session.id,String(frame.frameId),{type:'element',ref:ref!,operation:'fill',value:'扩展连接验收'},'fill-'+attempt,'extension-live');break }
      catch(error) {if(!(error instanceof Error)||error.message!=='AUTOMATION_GEOMETRY_CHANGED'||attempt===2)throw error;frame=await manager.observe(session.id,'extension-live')}
    }
    await expect.poll(()=>page.getByLabel('Message').inputValue()).toBe('扩展连接验收')
    await manager.close()
    expect(page.isClosed()).toBe(false)
    await page.reload()
    expect(await page.getByRole('heading').textContent()).toBe('Synthetic session retained')
  } catch(error) {
    // Extension connection URLs can contain its disposable authentication token.
    const message=error instanceof Error?error.message:String(error)
    throw new Error(message.replace(/chrome-extension:\/\/[^\s)]+/g,'[extension-connection-url]'))
  } finally {await manager.close();await context.close();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
},90000)
