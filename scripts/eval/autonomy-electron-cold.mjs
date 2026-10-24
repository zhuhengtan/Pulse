import {mkdir,readFile,writeFile,readdir,access} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {withBatchBudget} from './autonomy-budget.mjs'
import {withDevCallBudget} from './autonomy-dev-budget.mjs'
const base='http://127.0.0.1:7333',batch=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-20261023/live'),id=process.argv[2]??'cold-electron-1',out=join(batch,id),workspace=join(out,'workspace'),dataDir=resolve('.pulse-dev/h5/data')
const prompt='请先运行 node produce.mjs 恰好一次，产生 receipt.txt 和追加 side-effects.log。首次写入完成后，必须调用 ask.confirm 等待我确认，确认前不要验证或继续写文件。获得确认后运行 node --test verify.test.mjs 验证，最后新建 DELIVERY.md 简述真实结果。保留已有内容，不修改这两个脚本，不重复执行 produce.mjs。遇到进程中断时先检查已有产物和日志，只完成未完成步骤。'
const seed={
 'produce.mjs':`import {appendFileSync,writeFileSync} from 'node:fs';appendFileSync('side-effects.log','produced\\n');writeFileSync('receipt.txt','cold-process-acceptance\\n');console.log('produced');\n`,
 'verify.test.mjs':`import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';test('one write',()=>{assert.equal(readFileSync('receipt.txt','utf8'),'cold-process-acceptance\\n');assert.equal(readFileSync('side-effects.log','utf8'),'produced\\n')});\n`,
}
await mkdir(out,{recursive:false});await mkdir(workspace)
for(const[p,c]of Object.entries(seed))await writeFile(join(workspace,p),c)
for(const args of [['init','-q'],['add','.'],['-c','user.name=Pulse Evaluation','-c','user.email=eval@pulse.local','commit','-qm','Frozen cold recovery fixture']])execFileSync('git',args,{cwd:workspace})
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
await withBatchBudget(batch,id,async maxCalls=>withDevCallBudget(out,maxCalls,async()=>{
 let headers
 const connect=async()=>{const r=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}});if(!r.ok)throw Error('DEV_SESSION_UNAVAILABLE');headers={Origin:base,Cookie:r.headers.get('set-cookie'),'Content-Type':'application/json'}}
 const request=async(path,body)=>{if(!headers)await connect();let r=await fetch(base+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});if(r.status===401){await connect();r=await fetch(base+path,{headers})}if(!r.ok)throw Error(`HTTP_${r.status}:${path}`);return r.json()}
 const info=await request('/api/session'),config=await request('/api/config');if(config.config.activeModel!=='deepseek/deepseek-flash')throw Error('UNEXPECTED_MODEL')
 const project=await request('/api/projects',{name:'自主执行现场测试（保留）冷恢复',cwd:workspace}),conv=await request('/api/conversations',{title:'现场测试 · 冷进程恢复',projectId:project.id})
 await writeFile(join(out,'ready.json'),JSON.stringify({conversationId:conv.id,workspace,dataDir,prompt,maxCalls,serverPid:info.serverPid,originalService:true}))
 const files={}
 const snapshot=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const p=join(directory,entry.name);if(entry.isDirectory())await snapshot(p);else if(/\.(?:ts|js|mjs|json|swift|rs)$/.test(p))files[p]=await hash(p)}}
 for(const name of ['runtime','server','tool-sdk','adapters','cli'])for(const sub of ['src','dist'])await snapshot(`packages/${name}/${sub}`)
 for(const p of ['scripts/eval/autonomy-electron-cold.mjs','scripts/eval/autonomy-dev-budget.mjs','scripts/eval/autonomy-budget.mjs'])files[p]=await hash(p)
 await writeFile(join(out,'evaluator-source.mjs'),await readFile(new URL(import.meta.url)))
 await writeFile(join(out,'freeze.json'),JSON.stringify({prompt,seed,files,serverPid:info.serverPid,note:'Adds an explicit ask.confirm checkpoint to the historical cold scenario; conservatively inherits the old cold task budget.'},null,2));console.log('READY',conv.id)
 const runs=join(dataDir,'conversations',conv.id,'runs'),start=Date.now();let checkpoint,cancelled=false
 while(Date.now()-start<(JSON.parse(await readFile(join(batch,'budget.json'),'utf8')).schemaVersion===2?Infinity:1200000)){
  const ids=await readdir(runs).catch(()=>[]);if(ids.length>1)throw Error('UNEXPECTED_ADDITIONAL_RUN')
  if(ids[0]){const runId=ids[0],p=join(runs,runId),input=JSON.parse(await readFile(join(p,'input.json'),'utf8').catch(()=>'{}'));if(input.cwd){
   const budget=JSON.parse(await readFile(join(p,'model-budget.json'),'utf8').catch(()=>'{}'))
   if(!checkpoint){const runtime=JSON.parse(await readFile(join(p,'runtime.json'),'utf8').catch(()=>'{}')),pending=runtime.state?.state?.effects?.find(([,e])=>e.kind==='human'&&e.state!=='succeeded'&&e.state!=='failed'&&e.input?.kind==='ask')
    const receipt=await readFile(join(input.cwd,'receipt.txt'),'utf8').catch(()=>null),log=await readFile(join(input.cwd,'side-effects.log'),'utf8').catch(()=>null)
    if(pending&&receipt==='cold-process-acceptance\n'&&log==='produced\n'){checkpoint={runId,serverPid:info.serverPid,budget,receipt,log,effectId:pending[0],input:pending[1].input,cwd:input.cwd};await writeFile(join(out,'cold-boundary.json'),JSON.stringify(checkpoint,null,2));console.log('COLD_BOUNDARY',runId)}
   }
   if(!cancelled&&budget.limit!==undefined&&budget.limit>maxCalls&&budget.used>=maxCalls){try{await request(`/api/runs/${runId}/cancel`,{});cancelled=true}catch{}}
   if(await access(join(p,'task-outcome.json')).then(()=>true,()=>false)){
    let state;try{state=await request(`/api/runs/${runId}/state`)}catch{await new Promise(r=>setTimeout(r,250));continue}if(state.state==='running'){await new Promise(r=>setTimeout(r,250));continue}
    const taskOutcome=JSON.parse(await readFile(join(p,'task-outcome.json'),'utf8')),usage=JSON.parse(await readFile(join(p,'usage.json'),'utf8')),after=await request('/api/session'),root=await access(input.cwd).then(()=>input.cwd,()=>workspace)
    const receipt=await readFile(join(root,'receipt.txt'),'utf8').catch(()=>null),log=await readFile(join(root,'side-effects.log'),'utf8').catch(()=>null),delivery=await readFile(join(root,'DELIVERY.md'),'utf8').catch(()=>null),seedUnchanged=(await Promise.all(Object.entries(seed).map(async([p,c])=>await readFile(join(root,p),'utf8').catch(()=>null)===c))).every(Boolean)
    const sourceUnchanged=(await Promise.all(Object.entries(files).map(async([p,h])=>await hash(p)===h))).every(Boolean),differentProcess=after.serverPid!==info.serverPid
    const result={id,conversationId:conv.id,runId,modelCalls:usage.modelCalls,durationMs:Date.now()-start,taskOutcome,checkpoint,serverPidAfter:after.serverPid,differentProcess,receipt,log,delivery,seedUnchanged,sourceUnchanged,cancelledByBudget:cancelled,passed:Boolean(checkpoint&&differentProcess&&sourceUnchanged&&seedUnchanged&&receipt==='cold-process-acceptance\n'&&log==='produced\n'&&delivery&&taskOutcome.status==='accepted')}
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log('RESULT',JSON.stringify({passed:result.passed,calls:result.modelCalls}));return{modelCalls:result.modelCalls,passed:result.passed,result:join(out,'result.json')}
   }
  }}await new Promise(r=>setTimeout(r,250))
 }throw Error('UI_RUN_NOT_SETTLED')
}),'cold')
