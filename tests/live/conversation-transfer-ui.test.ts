import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it } from 'vitest'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'
import { H5ProjectCatalog } from '../../packages/server/src/h5/projects.js'
it.runIf(process.env.PULSE_TRANSFER_UI_LIVE === '1')('downloads and imports work conversations on desktop and hides transfer controls on mobile', async () => {
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url))
const { dirname } = await import('node:path')
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/mcp/package.json'))] }))
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'pulse-browser-transfer-'))
const sourceRoot = join(root,'source'), targetRoot = join(root,'target')
for (const cwd of [sourceRoot,targetRoot]) {
 await mkdir(cwd); await writeFile(join(cwd,'note.txt'),'browser transfer fixture\n')
 await exec('git',['init','-q',cwd]); await exec('git',['-C',cwd,'add','.']); await exec('git',['-C',cwd,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial'])
}
const sourceData=join(root,'source-data'), targetData=join(root,'target-data')
const source=createLocalHost({cwd:sourceRoot,dataDir:sourceData,taskController:false,approvalMode:'ask',mockResponse:'这是一条可跨机查看的历史回复。'})
const target=createLocalHost({cwd:targetRoot,dataDir:targetData,taskController:false,approvalMode:'ask',mockResponse:'已接续新消息。'})
const sourceProject=await new H5ProjectCatalog(sourceData).add('源机项目',sourceRoot)
await new H5ProjectCatalog(targetData).add('目标机项目',targetRoot)
const conversation=await source.createConversation({title:'跨机调试示例',projectId:sourceProject.id})
const run=await source.sendMessage(conversation.id,{text:'导出这段会话，保留调试记录。'})
await run.outcome()
const sourceServer=new H5Server(source,{dataDir:sourceData,port:0,host:'127.0.0.1'}), targetServer=new H5Server(target,{dataDir:targetData,port:0,host:'127.0.0.1'})
const sourceInfo=await sourceServer.start(),targetInfo=await targetServer.start()
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:960}})
const errors=[];page.on('pageerror',error=>errors.push(error.message))
try {
 await page.goto(`http://127.0.0.1:${sourceInfo.port}/work/${conversation.id}`)
 await page.getByRole('button',{name:'导出会话',exact:true}).waitFor()
 await page.getByText('这是一条可跨机查看的历史回复。',{exact:true}).waitFor()
 await page.waitForFunction(()=>!document.querySelector('[aria-label="导出会话"]').disabled)
 await page.screenshot({path:'/tmp/pulse-transfer-desktop.png',fullPage:true})
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出会话',exact:true}).click()
 const download=await downloadPromise;await download.saveAs('/tmp/pulse-transfer-browser.zip')
 if(!download.suggestedFilename().endsWith('.zip'))throw new Error('ZIP filename missing')
 await page.goto(`http://127.0.0.1:${targetInfo.port}/work/new`)
 await page.getByRole('button',{name:'导入会话',exact:true}).click()
 await page.getByLabel('选择会话压缩包').setInputFiles('/tmp/pulse-transfer-browser.zip')
 await page.getByText('导入工作会话',{exact:true}).waitFor()
 await page.getByRole('combobox',{name:'目标项目',exact:true}).click()
 await page.getByText('目标机项目',{exact:true}).last().click()
 await page.getByText('检查通过。导入后可查看历史或继续发送新消息。',{exact:true}).waitFor()
 await page.locator('.ant-select-dropdown:visible').waitFor({state:'hidden'})
 await page.screenshot({path:'/tmp/pulse-transfer-import.png',fullPage:true})
 await page.getByRole('button',{name:'导入并查看',exact:true}).click()
 await page.getByText('这是一条可跨机查看的历史回复。',{exact:true}).waitFor()
 await page.getByRole('dialog',{name:'导入工作会话',exact:true}).waitFor({state:'hidden'})
 if(!page.url().includes(conversation.id))throw new Error('Imported conversation not opened')
 await page.setViewportSize({width:390,height:844})
 await page.getByRole('button',{name:'导出会话',exact:true}).waitFor({state:'hidden'})
 await page.waitForFunction(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)
 if(overflow){await page.screenshot({path:'/tmp/pulse-transfer-mobile-overflow.png',fullPage:true});console.log('overflow',await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,c:e.className?.toString(),x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).filter(e=>e.right>innerWidth+1&&e.width>0).slice(0,18)})));throw new Error('Mobile horizontal overflow')}
 await page.screenshot({path:'/tmp/pulse-transfer-mobile.png',fullPage:true})
 await page.getByRole('button',{name:'历史对话',exact:true}).click()
 await page.getByRole('button',{name:'导入会话',exact:true}).waitFor({state:'hidden'})
 await page.screenshot({path:'/tmp/pulse-transfer-mobile-history.png',fullPage:true})
 if(errors.length)throw new Error(errors.join('\n'))
 console.log(JSON.stringify({ok:true,root,sourcePort:sourceInfo.port,targetPort:targetInfo.port,conversationId:conversation.id,download:download.suggestedFilename(),screenshots:4,pageErrors:errors},null,2))
}finally{await browser.close();await sourceServer.stop();await targetServer.stop();await source.close();await target.close();await rm(root,{recursive:true,force:true})}
}, 60_000)
