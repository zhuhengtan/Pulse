import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createLocalHost, H5Server } from '../../packages/server/dist/index.js'
import { loadHostModelConfig, waitForEvaluatorApproval, replyToWaitingEvent } from '../../tests/real-task/runner.mjs'
import { withBatchBudget } from './autonomy-budget.mjs'

const batch = resolve(process.argv[2] ?? '.pulse-dev/autonomy-20261022/live'), id = process.argv[3] ?? 'browser-1'
const out = join(batch,id), workspace = join(out,'workspace'), dataDir = join(out,'data')
await mkdir(out,{recursive:false}); await mkdir(workspace)
const require = createRequire(new URL('../../packages/server/package.json',import.meta.url))
const pw = createRequire(require.resolve('@playwright/mcp'))('playwright')
await withBatchBudget(batch,id,async maxCalls=>{
  const config=await loadHostModelConfig(); if(config.activeModel!=='deepseek/deepseek-flash')throw Error('UNEXPECTED_MODEL')
  const host=createLocalHost({cwd:workspace,dataDir,provider:config.provider,activeModel:config.activeModel,approvalMode:'auto',...(config.approvalReview?{approvalReview:{...config.approvalReview,manualOnRejection:true}}:{}),taskController:true,maxModelCalls:maxCalls,maxRuntimeMs:600000,enabledCapabilityPacks:['browser'],allowNetwork:true,networkHosts:['127.0.0.1'],jarvis:{enabled:false}})
  const h5=new H5Server(host,{dataDir,host:'127.0.0.1',port:0})
  let writes=[],desktop,handle; const events=[],approvals=[],startedAt=Date.now()
  const website=createServer(async(req,res)=>{
    if(req.method==='POST'&&req.url==='/save'){let body='';for await(const c of req)body+=c;writes.push(body);res.end('ok');return}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>Pulse Browser Acceptance</title><h1>Profile</h1><label>Name<input aria-label="Name"></label><button onclick="fetch(\'/save\',{method:\'POST\',body:document.querySelector(\'input\').value}).then(()=>document.querySelector(\'output\').textContent=\'Saved: \'+document.querySelector(\'input\').value)">Save</button><output></output>')
  })
  try{
    await h5.start();await new Promise(r=>website.listen(0,'127.0.0.1',r))
    const url=`http://127.0.0.1:${website.address().port}`
    const prompt=`使用当前内置浏览器打开 ${url}，将 Name 填为 Pulse自主验收，点击一次 Save，然后重新观察确认页面显示 Saved: Pulse自主验收。只通过浏览器真实界面操作，不要使用HTTP请求替代，也不要改业务页面、安装或启动外部浏览器。报告验证结果。`
    await writeFile(join(out,'freeze.json'),JSON.stringify({prompt,evaluator:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),serverBuild:createHash('sha256').update(await readFile(new URL('../../packages/server/dist/index.js',import.meta.url))).digest('hex')},null,2))
    const env={...process.env,PULSE_DESKTOP_USER_DATA:join(out,'electron'),PULSE_DESKTOP_DATA_DIR:dataDir,PULSE_HOME:join(out,'home'),PULSE_DESKTOP_DEV_URL:'http://127.0.0.1:5174/work/new?workspace=preview'};delete env.ELECTRON_RUN_AS_NODE
    desktop=await pw._electron.launch({executablePath:createRequire(new URL('../../packages/desktop/package.json',import.meta.url))('electron'),args:[resolve('packages/desktop')],env,timeout:25000})
    const page=await desktop.firstWindow();await page.getByRole('heading',{name:'工具',exact:true}).waitFor()
    for(let i=0;i<100&&!host.automation.nativeBrowserAvailable;i++)await new Promise(r=>setTimeout(r,100))
    if(!host.automation.nativeBrowserAvailable)throw Error('NATIVE_BROWSER_NOT_CONNECTED')
    const conv=await host.createConversation({cwd:workspace,title:id,approvalPolicy:'delegate'})
    handle=await host.sendMessage(conv.id,{text:prompt})
    await writeFile(join(out,'identity.json'),JSON.stringify({conversationId:conv.id,runId:handle.id}))
    for await(const event of handle.events){
      events.push(event)
      if(event.type==='observation'&&(event.data.kind==='model'||event.data.tool))console.log(JSON.stringify({kind:event.data.kind,tool:event.data.tool,status:event.data.status}))
      if(event.type==='waiting'&&event.data?.effectId){const receipt=await waitForEvaluatorApproval(join(batch,'approvals'),event,workspace);approvals.push(receipt);await replyToWaitingEvent(handle,event,receipt.reply)}
    }
    const outcome=await handle.outcome(),taskOutcome=await handle.taskOutcome(),usage=await handle.usage()
    const dom=await desktop.evaluate(async({webContents},url)=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().startsWith(url));return wc?await wc.executeJavaScript('JSON.stringify({title:document.title,value:document.querySelector("input").value,output:document.querySelector("output").textContent})'):null},url)
    const parsed=dom?JSON.parse(dom):null
    await page.screenshot({path:join(out,'desktop.png')})
    const verification={passed:writes.length===1&&writes[0]==='Pulse自主验收'&&parsed?.output==='Saved: Pulse自主验收',writes,dom:parsed,windows:await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)}
    const result={id,modelCalls:usage.modelCalls,durationMs:Date.now()-startedAt,runtimeStatus:outcome.status,taskOutcome,usage,approvals:approvals.length,verification,passed:verification.passed&&taskOutcome?.status==='accepted'}
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({id,passed:result.passed,modelCalls:usage.modelCalls,verification}))
    return {modelCalls:usage.modelCalls,passed:result.passed,result:join(out,'result.json')}
  }finally{
    await writeFile(join(out,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'))
    await desktop?.close().catch(()=>{});await h5.stop().catch(()=>{});await host.close().catch(()=>{});await new Promise(r=>website.close(r))
  }
})
