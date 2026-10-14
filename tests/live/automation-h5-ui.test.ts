import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'

it.runIf(process.env.PULSE_H5_AUTOMATION_LIVE === '1')('controls a real browser from desktop and mobile H5', async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-auto-ui-'))
 let typed=''
 const fixture=createServer(async(req,res)=>{if(req.url==='/typed'){typed='';for await(const chunk of req)typed+=chunk.toString();res.end('ok');return}res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>H5 Input Test</title><input aria-label="Target" style="position:absolute;left:40px;top:40px;width:300px;height:60px" oninput="fetch(\'/typed\',{method:\'POST\',body:this.value})">')})
 await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve))
 const target=`http://127.0.0.1:${(fixture.address() as {port:number}).port}/`
 const host=createLocalHost({cwd:root,dataDir:root,allowNetwork:true,networkHosts:['127.0.0.1'],approvalMode:'auto',enabledCapabilityPacks:['browser'],automation:{browser:{channel:'chrome'}}})
 await host.init()
 const server=new H5Server(host,{dataDir:root,host:'127.0.0.1',port:0})
 const info=await server.start(),base=`http://127.0.0.1:${info.port}`
 const require=createRequire(new URL('../../packages/server/package.json',import.meta.url))
 const {chromium}=require(require.resolve('playwright',{paths:[dirname(require.resolve('@playwright/mcp/package.json'))]}))
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},hasTouch:true})
  const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.request.post(`${base}/api/session/local`,{headers:{Origin:base}})
  const project=await (await page.request.post(`${base}/api/projects`,{headers:{Origin:base},data:{cwd:root,name:'Automation Test'}})).json()
  await page.request.post(`${base}/api/conversations`,{headers:{Origin:base},data:{title:'Automation Fixture',projectId:project.id}})
  await page.goto(base)
  await page.getByRole('tab',{name:'工作',exact:true}).click()
  await page.getByRole('button',{name:'工作区',exact:true}).click()
  await page.getByRole('button',{name:'自动化',exact:true}).click()
  await page.getByRole('button',{name:'打开浏览器',exact:true}).click()
  await page.getByRole('button',{name:'接管',exact:true}).click()
  await page.getByLabel('浏览器网址').fill(target)
  await page.getByRole('button',{name:'打开网址',exact:true}).click()
  await expect.poll(()=>host.automation.list()[0]?.url,{timeout:20000}).toBe(target)
  const image=page.getByRole('img',{name:'主机当前界面'})
  await image.waitFor({state:'visible'})
  await expect.poll(()=>image.evaluate((element:HTMLImageElement)=>element.complete&&element.naturalWidth>0)).toBe(true)
  const bounds=await image.boundingBox()
  await image.click({position:{x:bounds!.width*100/1280,y:bounds!.height*70/800}})
  await page.getByLabel('输入到主机').fill('H5 接管验收')
  await page.getByRole('button',{name:'发送文本',exact:true}).click()
  await expect.poll(()=>typed,{timeout:20000}).toBe('H5 接管验收')
  expect(await page.locator('.workbench-panel').count()).toBe(1)
  await page.waitForTimeout(1200)
  await page.screenshot({path:'/private/tmp/pulse-h5-automation-desktop.png'})
  await page.setViewportSize({width:390,height:844})
  await page.waitForTimeout(500)
  const mobileBounds=await image.boundingBox()
  await page.touchscreen.tap(mobileBounds!.x+mobileBounds!.width*100/1280,mobileBounds!.y+mobileBounds!.height*70/800)
  await page.getByLabel('快捷键').fill('ControlOrMeta+a')
  await page.getByRole('button',{name:'发送按键',exact:true}).click()
  await page.getByLabel('输入到主机').fill('手机触控验收')
  await page.getByRole('button',{name:'发送文本',exact:true}).click()
  await expect.poll(()=>typed,{timeout:20000}).toBe('手机触控验收')
  await page.screenshot({path:'/private/tmp/pulse-h5-automation-mobile.png'})
  await page.getByRole('button',{name:'交还 AI',exact:true}).click()
  await expect.poll(()=>host.automation.list()[0]?.state).toBe('ai')
  expect(errors).toEqual([])
 }finally{await browser.close();await server.stop();await host.close();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
},90000)
