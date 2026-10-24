import {createServer} from 'node:http'
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile,readdir,appendFile,access} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {withBatchBudget} from './autonomy-budget.mjs'
import {withDevCallBudget} from './autonomy-dev-budget.mjs'
import {nativePreferenceConfirmation,nativeProfileConfirmation} from './autonomy-native-ui.mjs'
const batch=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-20261023/live'),id=process.argv[2]??'browser-preferences-electron-1',kind=process.argv[3]??'browser',out=join(batch,id),workspace=join(out,'workspace'),dataDir=resolve('.pulse-dev/h5/data'),base='http://127.0.0.1:7333'
if(await access(out).then(()=>true,()=>false))throw Error('ATTEMPT_EXISTS')
await mkdir(workspace,{recursive:true})
for(const args of [['init','-q'],['-c','user.name=Pulse Evaluation','-c','user.email=eval@pulse.local','commit','--allow-empty','-qm','Frozen UI benchmark workspace']])execFileSync('git',args,{cwd:workspace})
await withBatchBudget(batch,id,async maxCalls=>withDevCallBudget(out,maxCalls,async()=>{
 let writes=[];const startedAt=Date.now();let website
 try{
  if(kind==='browser-original'){
   website=createServer(async(req,res)=>{
    if(req.method==='POST'&&req.url==='/save'){let body='';for await(const chunk of req)body+=chunk;const entry={at:new Date().toISOString(),body};writes.push(entry);await appendFile(join(out,'side-effects.jsonl'),JSON.stringify(entry)+'\n');res.end('ok');return}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>Pulse Browser Acceptance</title><h1>Profile</h1><label>Name<input aria-label="Name"></label><button onclick="fetch(\'/save\',{method:\'POST\',body:document.querySelector(\'input\').value}).then(()=>document.querySelector(\'output\').textContent=\'Saved: \'+document.querySelector(\'input\').value)">Save</button><output></output>')
   });await new Promise(r=>website.listen(0,'127.0.0.1',r))
  }
  if(kind==='browser'){
   website=createServer(async(req,res)=>{
    if(req.method==='POST'&&req.url==='/apply'){let body='';for await(const chunk of req)body+=chunk;const entry={at:new Date().toISOString(),body};writes.push(entry);await appendFile(join(out,'side-effects.jsonl'),JSON.stringify(entry)+'\n');res.end('ok');return}
    res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<title>Pulse Preferences Acceptance</title><h1>本地显示偏好测试</h1><label>显示名<input aria-label="显示名"></label><label><input type="checkbox" aria-label="显示摘要">显示摘要</label><button onclick="fetch(\'/apply\',{method:\'POST\',body:JSON.stringify({name:document.querySelector(\'input\').value,summary:document.querySelector(\'[type=checkbox]\').checked})}).then(()=>document.querySelector(\'output\').textContent=\'已应用：\'+document.querySelector(\'input\').value+\'；摘要：\'+(document.querySelector(\'[type=checkbox]\').checked?\'开启\':\'关闭\'))">应用一次</button><output></output>')
   });await new Promise(r=>website.listen(0,'127.0.0.1',r))
  }
  const url=website?`http://127.0.0.1:${website.address().port}`:undefined
  const prompt=kind==='browser-original'?`使用当前内置浏览器打开 ${url}，将 Name 填为 Pulse自主验收，点击一次 Save，然后重新观察确认页面显示 Saved: Pulse自主验收。只通过浏览器真实界面操作，不要使用HTTP请求替代，也不要改业务页面、安装或启动外部浏览器。报告验证结果。`:kind==='browser'?`用当前内置浏览器打开 ${url} ，将显示名设为“Pulse界面复核”，开启“显示摘要”，点击一次“应用一次”，随后重新观察并报告页面显示的完整确认文本。只能通过真实浏览器界面操作；不要用 HTTP 请求、脚本或文件修改替代，不要安装或启动外部浏览器，不要重复提交。`:kind==='computer-focus'?'使用已启用的 computer 桌面能力列出窗口，选择并置前标题为 Pulse 的 Electron 窗口，然后观察并报告窗口标题和三个实际可见控件。允许只为查看该窗口而执行 computer.selectWindow；不要点击其他控件、键入、执行系统脚本或安装软件。报告必须依据实际截图或可访问性信息；若窗口不可见或权限不足，准确说明阻塞。':'使用已启用的 computer 桌面能力，查看当前 Pulse Electron 窗口，报告窗口标题和界面上三个可见控件。只读观察，不要点击、键入、切换其他应用或安装软件。如果缺少视觉模型或系统授权，请准确报告阻塞，不能猜测界面内容。'
  const s=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}});const headers={Origin:base,Cookie:s.headers.get('set-cookie'),'Content-Type':'application/json'}
  const request=async(path,body)=>{const r=await fetch(base+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`HTTP_${r.status}:${path}`);return r.json()}
  const project=await request('/api/projects',{name:`自主执行现场测试（保留） ${id}`,cwd:workspace});const conv=await request('/api/conversations',{title:`现场测试 · ${id}`,projectId:project.id})
  const files={};const snapshot=async d=>{for(const e of await readdir(d,{withFileTypes:true})){const p=join(d,e.name);if(e.isDirectory())await snapshot(p);else if(/\.(ts|js|mjs|json)$/.test(p))files[p]=createHash('sha256').update(await readFile(p)).digest('hex')}}
  for(const p of ['runtime','server','tool-sdk','adapters'])for(const sub of ['src','dist'])await snapshot(`packages/${p}/${sub}`)
  for(const p of ['scripts/eval/autonomy-native-ui.mjs','scripts/eval/autonomy-electron-automation.mjs'])files[p]=createHash('sha256').update(await readFile(p)).digest('hex')
  await writeFile(join(out,'source-freeze.json'),JSON.stringify({files},null,2));await writeFile(join(out,'freeze.json'),JSON.stringify({prompt,kind,url,maxCalls,evaluator:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),requirement:kind==='browser'?'Exactly one authorized POST and independent visible confirmation; tool trace must use native browser.':'Read-only desktop observation with genuine visual evidence; capability blocker is not completion.'},null,2));await writeFile(join(out,'ready.json'),JSON.stringify({conversationId:conv.id,prompt,workspace,dataDir,maxCalls,originalService:true},null,2));console.log('READY',conv.id,prompt)
  let cancelled=false
  while(Date.now()-startedAt<(JSON.parse(await readFile(join(batch,'budget.json'),'utf8')).schemaVersion===2?Infinity:1200000)){
   const runs=join(dataDir,'conversations',conv.id,'runs');const ids=await readdir(runs).catch(()=>[]);if(ids.length>1)throw Error('DUPLICATE_RUN')
   if(ids[0]){const runId=ids[0],p=join(runs,runId);const budget=JSON.parse(await readFile(join(p,'model-budget.json'),'utf8').catch(()=>'{}'));if(!cancelled&&budget.limit!==undefined&&budget.limit>maxCalls&&budget.used>=maxCalls){cancelled=true;await request(`/api/runs/${runId}/cancel`,{})}
    try{
     const outcome=JSON.parse(await readFile(join(p,'outcome.json'),'utf8')),task=JSON.parse(await readFile(join(p,'task-outcome.json'),'utf8').catch(e=>{if(e.code==='ENOENT'&&outcome.status==='failed')return JSON.stringify({status:'failed',blockers:[outcome.error],missingTaskOutcome:true});throw e})),usage=JSON.parse(await readFile(join(p,'usage.json'),'utf8'))
     const preliminary={id,kind,conversationId:conv.id,runId,modelCalls:usage.modelCalls,taskOutcome:task,finalAnswer:outcome.text,usage,writes,cancelledByBudget:cancelled,durationMs:Date.now()-startedAt}
     await writeFile(join(out,'run-result.json'),JSON.stringify(preliminary,null,2));console.log('AWAIT_INDEPENDENT_UI_EVIDENCE',runId)
     let evidence;for(let n=0;n<600;n++){try{evidence=JSON.parse(await readFile(join(out,'ui-evidence.json'),'utf8'));break}catch{}await new Promise(r=>setTimeout(r,1000))}
     const frozenFiles={...files};for(const key of Object.keys(files))delete files[key]
     for(const p of ['runtime','server','tool-sdk','adapters'])for(const sub of ['src','dist'])await snapshot(`packages/${p}/${sub}`)
     for(const p of ['scripts/eval/autonomy-native-ui.mjs','scripts/eval/autonomy-electron-automation.mjs'])files[p]=createHash('sha256').update(await readFile(p)).digest('hex')
     const sourceChanges=[...new Set([...Object.keys(files),...Object.keys(frozenFiles)])].filter(p=>files[p]!==frozenFiles[p])
     await writeFile(join(out,'source-freeze-end.json'),JSON.stringify({files,sourceChanges},null,2))
     const value=kind==='browser'&&writes.length===1?JSON.parse(writes[0].body):null;const desktopVerified=['computer','computer-focus'].includes(kind)&&evidence?.independentReview?.passed===true&&evidence.independentReview.observedTitle==='Pulse'&&evidence.independentReview.matchedControls?.length>=3&&typeof evidence.independentReview.observationScreenshotSha256==='string'&&evidence.independentReview.observedVia==='computer.observe';const verification={passed:desktopVerified||(kind==='browser-original'&&writes.length===1&&writes[0].body==='Pulse自主验收'&&nativeProfileConfirmation(evidence?.ax,url))||kind==='browser'&&value?.name==='Pulse界面复核'&&value?.summary===true&&nativePreferenceConfirmation(evidence?.ax,url),writes,independentUI:['computer','computer-focus'].includes(kind)?desktopVerified:!!evidence,evidenceProvided:!!evidence,sourceUnchanged:sourceChanges.length===0,note:['computer','computer-focus'].includes(kind)?desktopVerified?'Desktop evidence independently matched against the actual computer.observe screenshot.':'No independently matched Pulse observation screenshot; see ui-evidence.json for the actual blocker.':undefined}
     const result={...preliminary,verification,passed:verification.passed&&verification.sourceUnchanged&&task.status==='accepted'};await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log('RESULT',JSON.stringify(result));return{modelCalls:usage.modelCalls,passed:result.passed,result:join(out,'result.json')}
    }catch(e){if(e.code!=='ENOENT')throw e}
   }await new Promise(r=>setTimeout(r,200))
  }throw Error('UI_RUN_NOT_SETTLED')
 }finally{if(website)await new Promise(r=>website.close(r))}
}),process.env.PULSE_EVAL_TASK_KEY??id)
