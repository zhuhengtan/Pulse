import {mkdir,readFile,writeFile,readdir,access} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {withBatchBudget} from './autonomy-budget.mjs'
import {withDevCallBudget} from './autonomy-dev-budget.mjs'

// The original handoff contract, executed through the existing development UI.
const batch=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-failed-rerun-20261023/live')
const id=process.argv[2]??'handoff-v28-rerun-1',out=join(batch,id),dataDir=resolve('.pulse-dev/h5/data'),base='http://127.0.0.1:7333'
const priorAttempt=process.env.PULSE_EVAL_HANDOFF_REUSE_ATTEMPT??process.env.PULSE_EVAL_HANDOFF_REBIND_ATTEMPT??process.env.PULSE_EVAL_HANDOFF_RETEST_ATTEMPT
const prior=priorAttempt?JSON.parse(await readFile(join(batch,priorAttempt,'ready.json'),'utf8')):undefined
const reusePristine=!!process.env.PULSE_EVAL_HANDOFF_REUSE_ATTEMPT
if(['PULSE_EVAL_HANDOFF_REUSE_ATTEMPT','PULSE_EVAL_HANDOFF_REBIND_ATTEMPT','PULSE_EVAL_HANDOFF_RETEST_ATTEMPT'].filter(key=>process.env[key]).length>1)throw Error('AMBIGUOUS_REPLAY_SETUP')
const workspace=reusePristine?prior.workspace:join(out,'workspace')
const prompt='请用 work.list 确认 Autonomy Handoff Fixture 项目，然后只启动一个工作会话：读取 input.json，将其中数字求和，新建 result.json，内容为 {"sum":10} 并独立读取输入和输出验证；不要修改 input.json。启动后告诉我工作会话 ID，不要启动第二个，也不要把启动成功说成任务已验收完成。'
await mkdir(out,{recursive:false})
if(reusePristine){
 if(!prior.originalService||!prior.assistant||await readFile(join(workspace,'input.json'),'utf8')!=='[2,3,5]\n'||await access(join(workspace,'result.json')).then(()=>true,()=>false)||execFileSync('git',['status','--porcelain'],{cwd:workspace,encoding:'utf8'}).trim())throw Error('REUSED_HANDOFF_FIXTURE_NOT_PRISTINE')
 await writeFile(join(out,'reused-fixture.json'),JSON.stringify({priorAttempt:process.env.PULSE_EVAL_HANDOFF_REUSE_ATTEMPT,workspace,projectId:prior.projectId,reason:'Prior assistant failed before starting any work; preserve the existing exact registered fixture and all old records without renaming projects or resetting files.'},null,2))
}else{
 await mkdir(workspace);await writeFile(join(workspace,'input.json'),'[2,3,5]\n')
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Pulse Evaluation','-c','user.email=eval@pulse.local','commit','-qm','Frozen handoff input']])execFileSync('git',args,{cwd:workspace})
}
await withBatchBudget(batch,id,async maxCalls=>withDevCallBudget(out,maxCalls,async()=>{
 const session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
 const headers={Origin:base,Cookie:session.headers.get('set-cookie'),'Content-Type':'application/json'}
 const request=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(base+path,{headers,method,...(body?{body:JSON.stringify(body)}:{})});if(!r.ok){const detail=await r.json().catch(()=>({}));throw Error(`HTTP_${r.status}:${path}:${String(detail.error??'').slice(0,200)}`)}return r.json()}
 const config=await request('/api/config');if(config.config.activeModel!=='deepseek/deepseek-flash')throw Error('UNEXPECTED_MODEL')
 const projects=await request('/api/projects'),list=Array.isArray(projects)?projects:projects.projects
 const matches=list.filter(p=>p.name==='Autonomy Handoff Fixture')
 if(prior?matches.length!==1||matches[0].id!==prior.projectId||matches[0].cwd!==prior.workspace:matches.length>0)throw Error('AMBIGUOUS_EXISTING_HANDOFF_PROJECT')
 if(prior&&!reusePristine){
  const previous=JSON.parse(await readFile(join(batch,priorAttempt,'result.json'),'utf8'))
  if(!prior.originalService||!prior.assistant||typeof previous.passed!=='boolean'||(process.env.PULSE_EVAL_HANDOFF_RETEST_ATTEMPT?previous.passed!==true:previous.passed!==false))throw Error('REBIND_REQUIRES_MATCHING_RETAINED_ATTEMPT')
  for(const run of previous.runs)if((await request(`/api/runs/${run.runId}/state`)).state==='running')throw Error('PRIOR_ATTEMPT_STILL_RUNNING')
  await writeFile(join(out,'project-before-rebind.json'),JSON.stringify(matches[0],null,2))
 }
 const project=prior?(reusePristine?matches[0]:await request(`/api/projects/${prior.projectId}`,{cwd:workspace,folders:[workspace]},'PATCH')):await request('/api/projects',{name:'Autonomy Handoff Fixture',cwd:workspace})
 if(prior&&!reusePristine)await writeFile(join(out,'fixture-rebind.json'),JSON.stringify({priorAttempt,previousWorkspace:prior.workspace,workspace,projectId:project.id,note:'Only the evaluation project registration points to this fresh original seed. Previous workspaces, artifacts, conversations, runs, scores and input bytes are retained; no previous business artifact is reset or repaired. Reruns use the unchanged original prompt, fixture bytes and acceptance criteria.'},null,2))
 const records=async()=>{const rows=[];for(const c of await readdir(join(dataDir,'conversations')).catch(()=>[]))for(const r of await readdir(join(dataDir,'conversations',c,'runs')).catch(()=>[])){const dir=join(dataDir,'conversations',c,'runs',r);rows.push({conversationId:c,runId:r,dir})}return rows}
 const baseline=new Set((await records()).map(r=>r.runId)),assistant=await request('/api/assistant'),info=await request('/api/session')
 const files={},snapshot=async d=>{for(const e of await readdir(d,{withFileTypes:true})){const p=join(d,e.name);if(e.isDirectory())await snapshot(p);else if(/\.(ts|js|mjs|json)$/.test(p))files[p]=createHash('sha256').update(await readFile(p)).digest('hex')}}
 for(const p of ['runtime','server','tool-sdk','adapters'])for(const sub of ['src','dist'])await snapshot(`packages/${p}/${sub}`)
 await writeFile(join(out,'source-freeze.json'),JSON.stringify({files},null,2))
 await writeFile(join(out,'freeze.json'),JSON.stringify({prompt,model:config.config.activeModel,serverPid:info.serverPid,originalService:true,baselineRunIds:[...baseline]},null,2))
 await writeFile(join(out,'ready.json'),JSON.stringify({conversationId:assistant.conversation.id,prompt,projectId:project.id,workspace,dataDir,maxCalls,assistant:true,originalService:true},null,2));console.log('READY_HANDOFF')
 const startedAt=Date.now();let rows=[]
 while(Date.now()-startedAt<(JSON.parse(await readFile(join(batch,'budget.json'),'utf8')).schemaVersion===2?Infinity:1200000)){
  rows=[]
  for(const row of (await records()).filter(r=>!baseline.has(r.runId))){
   const read=async name=>JSON.parse(await readFile(join(row.dir,name),'utf8'))
   const input=await read('input.json').catch(()=>null)
   if(!input||!(input.assistantChat&&input.goal===prompt||input.jarvisWorkspace===workspace||input.cwd===workspace))continue
   rows.push({...row,input,outcome:await read('outcome.json').catch(()=>null),usage:await read('usage.json').catch(()=>null),task:await read('task-outcome.json').catch(()=>null)})
  }
  await writeFile(join(out,'active-runs.json'),JSON.stringify(rows.map(({dir,input,outcome,usage,task,...r})=>({...r,assistantChat:input.assistantChat,settled:!!outcome})),null,2))
  if(rows.length&&rows.every(r=>r.outcome&&r.usage)){
   let running=false;for(const row of rows)if((await request(`/api/runs/${row.runId}/state`)).state==='running')running=true
   if(!running){
    const work=rows.filter(r=>!r.input.assistantChat)
    // An assistant that did not start work is an observed failure, not a timeout.
    const deliveryRoot=work[0]&&await access(work[0].input.cwd).then(()=>work[0].input.cwd,()=>workspace)||workspace
    const artifact=JSON.parse(await readFile(join(deliveryRoot,'result.json'),'utf8').catch(()=>'null'))
    const original=(await readFile(join(workspace,'input.json'),'utf8'))==='[2,3,5]\n'&&(await readFile(join(deliveryRoot,'input.json'),'utf8'))==='[2,3,5]\n'
    const sourceChanges=[];for(const[path,hash]of Object.entries(files))if(await readFile(path).then(b=>createHash('sha256').update(b).digest('hex'),()=>null)!==hash)sourceChanges.push(path)
    const modelCalls=rows.reduce((n,r)=>n+r.usage.modelCalls,0)
    const result={id,modelCalls,durationMs:Date.now()-startedAt,starts:work.length,artifact,originalInputPreserved:original,sourceChanges,runs:rows.map(({dir,...r})=>r),passed:work.length===1&&artifact?.sum===10&&original&&work[0].task?.status==='accepted'&&sourceChanges.length===0}
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log('RESULT',JSON.stringify({passed:result.passed,modelCalls}));return{modelCalls,passed:result.passed,result:join(out,'result.json')}
   }
  }
  await new Promise(r=>setTimeout(r,500))
 }
 throw Error('HANDOFF_NOT_SETTLED')
}),'handoff')
