import {verifyResearchDate} from './autonomy-research-date.mjs'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile,readdir,access,cp,stat} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {execFileSync} from 'node:child_process'
import {withBatchBudget} from './autonomy-budget.mjs'
import {withMissingBrowserCapability} from './autonomy-dev-capabilities.mjs'
import {focusedCases} from './autonomy-focused-cases.mjs'
import {pathToFileURL} from 'node:url'
import {withDevCallBudget} from './autonomy-dev-budget.mjs'
const acceptanceV2=process.env.PULSE_EVAL_ACCEPTANCE_V2==='1'
const base='http://127.0.0.1:7333',batch=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-20261022/live'),caseId=process.argv[2]??'files-01',id=process.argv[3]??`${caseId}-electron-dev-1`,out=join(batch,id),workspace=join(out,'workspace'),dataDir=resolve('.pulse-dev/h5/data')
const scenarioPath=caseId.startsWith('long:')?join('tests/real-task',caseId.slice(5)):null
const spec=scenarioPath?JSON.parse(await readFile(join(scenarioPath,'scenario.json'),'utf8')):focusedCases[caseId]??JSON.parse(await readFile('evals/tasks.v1.json','utf8')).tasks.find(t=>t.id===caseId)
if(!spec)throw Error('UNKNOWN_EXISTING_CASE')

if(await access(join(out,'ready.json')).then(()=>true,()=>false))throw Error('ATTEMPT_ALREADY_EXISTS')
await mkdir(workspace,{recursive:true})
if(scenarioPath)await cp(join(scenarioPath,'seed'),workspace,{recursive:true})
for(const [p,c] of Object.entries(spec.fixtures??{})){await mkdir(dirname(join(workspace,p)),{recursive:true});await writeFile(join(workspace,p),c)}
for(const args of [['init','-q'],['add','.'],['-c','user.name=Pulse Evaluation','-c','user.email=eval@pulse.local','commit','--allow-empty','-qm','Frozen benchmark input']])execFileSync('git',args,{cwd:workspace})
const capabilityScope=execute=>caseId==='capability-block'?withMissingBrowserCapability(out,execute):execute()
await withBatchBudget(batch,id,async maxCalls=>capabilityScope(()=>withDevCallBudget(out,maxCalls,async()=>{
 const session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
 if(!session.ok)throw Error('DEV_SESSION_UNAVAILABLE')
 const headers={Origin:base,Cookie:session.headers.get('set-cookie'),'Content-Type':'application/json'}
 const request=async(path,body)=>{const r=await fetch(base+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`HTTP_${r.status}:${path}`);return r.json()}
 const info=await request('/api/session'),config=await request('/api/config')
 if(config.config.activeModel!=='deepseek/deepseek-flash')throw Error('UNEXPECTED_MODEL')
 const project=await request('/api/projects',{name:`自主执行现场测试（保留） ${caseId}`,cwd:workspace})
 const conv=await request('/api/conversations',{title:`现场测试 · ${caseId}`,projectId:project.id})
 await writeFile(join(out,'ready.json'),JSON.stringify({conversationId:conv.id,workspace,dataDir,prompt:spec.prompt,maxCalls,serverPid:info.serverPid,originalService:true}))
 await writeFile(join(out,'freeze.json'),JSON.stringify({spec,serverPid:info.serverPid,version:info.serverVersion,model:config.config.activeModel,configuredMaxCalls:config.config.maxModelCalls??256,acceptanceVersion:acceptanceV2?2:1,dateTimeZone:acceptanceV2?'Asia/Shanghai':undefined,externalCancelThreshold:maxCalls,note:'Original resident development environment. The evaluator temporarily narrows only the development model budget and restores it; source and build hashes are recorded.'},null,2))
 const files={}
 const seedCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim()
 await writeFile(join(out,'seed-commit.json'),JSON.stringify({commit:seedCommit,workspace,note:'Frozen original fixture tree retained in local Git object database before model calls'},null,2))
 const snapshot=async dir=>{for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await snapshot(p);else if(/\.(?:ts|tsx|js|mjs|cjs|json|css|html|swift|py|ps1)$/.test(p))files[p]=createHash('sha256').update(await readFile(p)).digest('hex')}}
 for(const p of ['runtime','server','tool-sdk','adapters'])for(const sub of ['src','dist'])await snapshot(`packages/${p}/${sub}`)
 for(const p of ['packages/web/src','packages/desktop/src','native/desktop-helper'])await snapshot(p)
 for(const p of ['evals/tasks.v1.json','scripts/eval/grade.mjs','scripts/eval/autonomy-focused-cases.mjs',...(acceptanceV2?['scripts/eval/autonomy-research-date.mjs','scripts/eval/autonomy-electron-existing.mjs']:[]),...(scenarioPath?[join(scenarioPath,'scenario.json'),join(scenarioPath,'verify.mjs')]:[])])files[p]=createHash('sha256').update(await readFile(p)).digest('hex')
 await writeFile(join(out,'source-freeze.json'),JSON.stringify({files},null,2))
 console.log('READY',conv.id)
 const startedAt=Date.now(),runs=join(dataDir,'conversations',conv.id,'runs');let cancelled=false
 while(Date.now()-startedAt<(JSON.parse(await readFile(join(batch,'budget.json'),'utf8')).schemaVersion===2?Infinity:1200000)){
  const ids=await readdir(runs).catch(()=>[])
  if(ids.length>(spec.simulateInterruptAfterTools?2:1))throw Error('UNEXPECTED_ADDITIONAL_RUN')
  if(ids[0]){
   const ordered=await Promise.all(ids.map(async runId=>({runId,created:(await stat(join(runs,runId))).birthtimeMs})))
   ordered.sort((a,b)=>a.created-b.created||ids.indexOf(a.runId)-ids.indexOf(b.runId))
   const firstRunId=ordered[0].runId
   if(spec.simulateInterruptAfterTools&&ids.length===1){
    const runtime=JSON.parse(await readFile(join(runs,firstRunId,'runtime.json'),'utf8').catch(()=>'null'))
    const completedTools=runtime?.state?.state?.effects?.filter(([,e])=>e.kind==='tool'&&['succeeded','failed'].includes(e.state)).length??0
    if(completedTools>=spec.simulateInterruptAfterTools&&!await access(join(out,'interruption-ready.json')).then(()=>true,()=>false)){
     await writeFile(join(out,'interruption-ready.json'),JSON.stringify({runId:firstRunId,completedTools,requestedAfterTools:spec.simulateInterruptAfterTools,action:'Stop through original Electron, wait for settlement, then submit exact resumePrompt',resumePrompt:spec.resumePrompt},null,2))
     console.log('AWAIT_UI_INTERRUPT',firstRunId,completedTools)
    }
    const firstOutcome=await readFile(join(runs,firstRunId,'outcome.json'),'utf8').then(JSON.parse).catch(()=>null)
    if(firstOutcome){
     if(firstOutcome.status!=='cancelled'&&firstOutcome.error?.code!=='RUN_CANCELLED')console.log('FIRST_RUN_SETTLED',firstOutcome.status)
     const firstState=await request(`/api/runs/${firstRunId}/state`)
     if(firstState.state!=='running')await writeFile(join(out,'resume-ready.json'),JSON.stringify({conversationId:conv.id,prompt:spec.resumePrompt,firstRunId,firstOutcome},null,2))
    }
    await new Promise(r=>setTimeout(r,100));continue
   }
   const runId=ordered.at(-1).runId,p=join(runs,runId)
   const budget=JSON.parse(await readFile(join(p,'model-budget.json'),'utf8').catch(()=>'{}'))
   if(!cancelled&&budget.limit!==undefined&&budget.limit>maxCalls&&budget.used>=maxCalls){cancelled=true;await request(`/api/runs/${runId}/cancel`,{})}
   try{
    const outcome=JSON.parse(await readFile(join(p,'outcome.json'),'utf8')),usage=JSON.parse(await readFile(join(p,'usage.json'),'utf8')),task=JSON.parse(await readFile(join(p,'task-outcome.json'),'utf8').catch(e=>{if(e.code==='ENOENT'&&outcome.status==='failed')return JSON.stringify({status:'failed',blockers:[outcome.error],missingTaskOutcome:true});throw e})),input=JSON.parse(await readFile(join(p,'input.json'),'utf8'))
    // Host outcome files precede workspace merge/cleanup. Grade only after the
    // resident server has finished that transition, never from a disappearing cwd.
    const state=await request(`/api/runs/${runId}/state`)
    if(state.state==='running'){await new Promise(r=>setTimeout(r,200));continue}
    const deliveryRoot=await access(input.cwd).then(()=>input.cwd,()=>workspace)
    let verification
    try{
     if(scenarioPath)verification=await(await import(pathToFileURL(resolve(scenarioPath,'verify.mjs')).href)).verify(deliveryRoot)
     else if(focusedCases[caseId]){
      const runtime=JSON.parse(await readFile(join(p,'runtime.json'),'utf8'))
      const events=runtime.state.state.effects.filter(([,e])=>e.kind==='tool'&&e.state==='succeeded').map(([,e])=>({type:'observation',data:{tool:e.input.name}}))
      verification=await spec.verify(deliveryRoot,events)
     }
     else verification=JSON.parse(execFileSync(process.execPath,['scripts/eval/grade.mjs','--dataset','evals/tasks.v1.json','--task',caseId,'--workspace',deliveryRoot],{encoding:'utf8'}))
    }catch(error){verification={passed:false,error:String(error.message)}}
    const immutableTests=await Promise.all(Object.entries(spec.fixtures??{}).filter(([p])=>p.startsWith('test/')).map(async([p,c])=>await readFile(join(deliveryRoot,p),'utf8').catch(()=>null)===c))
    if(immutableTests.some(v=>!v))verification={...verification,passed:false,immutableTests:false}
    const sourceUnchanged=caseId.startsWith('files-')?(await Promise.all(Object.entries(spec.fixtures??{}).map(async ([p,c])=>await readFile(join(deliveryRoot,p),'utf8').catch(()=>null)===c))).every(Boolean):null
    const sourceChanges=[]
    for(const [path,hash] of Object.entries(files))if(await readFile(path).then(b=>createHash('sha256').update(b).digest('hex'),()=>null)!==hash)sourceChanges.push(path)
    // Retain the complete audit, but pure renderer edits do not change a CLI
    // task's execution semantics. Shared server/automation code stays in scope.
    const uiOnlyChanges=sourceChanges.filter(p=>p.startsWith('packages/web/src/'))
    const executionSourceChanges=sourceChanges.filter(p=>!uiOnlyChanges.includes(p))
    await writeFile(join(out,'source-freeze-end.json'),JSON.stringify({sourceChanges,uiOnlyChanges,executionSourceChanges},null,2))
    const priorRuns=await Promise.all(ordered.slice(0,-1).map(async({runId})=>({runId,usage:JSON.parse(await readFile(join(runs,runId,'usage.json'),'utf8')),outcome:JSON.parse(await readFile(join(runs,runId,'outcome.json'),'utf8'))})))
    const independentAcceptance=acceptanceV2?await verifyResearchDate({spec,legacy:verification,workspace:deliveryRoot,runDir:p,hostAccepted:task.status==='accepted',timeZone:'Asia/Shanghai'}).catch(error=>({acceptanceVersion:2,applicable:spec.category==='research',passed:false,reason:String(error.message)})):undefined
    const legacyPassed=verification.passed&&sourceUnchanged!==false&&executionSourceChanges.length===0&&(verification.expectedBlocked?task.status!=='accepted':task.status==='accepted')
    const result={id,conversationId:conv.id,runId,priorRuns,serverPid:info.serverPid,modelCalls:usage.modelCalls+priorRuns.reduce((n,r)=>n+r.usage.modelCalls,0),durationMs:Date.now()-startedAt,taskOutcome:task,finalAnswer:outcome.text,verification,sourceUnchanged,productSourceUnchanged:sourceChanges.length===0,executionSourceUnchanged:executionSourceChanges.length===0,cancelledByBudget:cancelled,deliveryRoot,...(acceptanceV2?{schemaVersion:2,acceptanceVersion:2,legacyPassed,independentAcceptance}:{}),passed:(independentAcceptance?.applicable?independentAcceptance.passed:verification.passed)&&sourceUnchanged!==false&&executionSourceChanges.length===0&&(verification.expectedBlocked?task.status!=='accepted':task.status==='accepted')}
    if(independentAcceptance)await writeFile(join(out,'independent-acceptance-v2.json'),JSON.stringify(independentAcceptance,null,2))
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log('RESULT',JSON.stringify(result));return {modelCalls:result.modelCalls,passed:result.passed,result:join(out,'result.json')}
   }catch(e){if(e.code!=='ENOENT')throw e}
  }
  await new Promise(r=>setTimeout(r,100))
 }
 throw Error('UI_RUN_NOT_SETTLED')
})),process.env.PULSE_EVAL_TASK_KEY??id.replace('-dev-','-'))
