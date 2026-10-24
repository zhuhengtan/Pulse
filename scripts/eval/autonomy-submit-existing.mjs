import {readFile,writeFile,readdir,access} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'

// Submit only an evaluator-prepared original case to the resident dev service.
// Stable request IDs recover uncertain submission results without a second run.
const batch=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-failed-rerun-20261023/live')
const id=process.argv[2],resume=process.argv[3]==='resume',out=join(batch,id),base='http://127.0.0.1:7333'
const ready=JSON.parse(await readFile(join(out,'ready.json'),'utf8'))
if(!ready.originalService||resolve(ready.dataDir)!==resolve('.pulse-dev/h5/data'))throw Error('ORIGINAL_DEV_DATA_REQUIRED')
const ledger=JSON.parse(await readFile(join(batch,'budget.json'),'utf8'))
if(!ledger.attempts.some(a=>a.id===id&&a.state==='reserved'))throw Error('PREPARED_AUTHORIZED_ATTEMPT_REQUIRED')
const input=resume?JSON.parse(await readFile(join(out,'resume-ready.json'),'utf8')):ready
const requestId=`eval-${id}${resume?'-resume':''}`,name=resume?'resume-submission':'submission'
const intentPath=join(out,`${name}-intent.json`),intentExists=await access(intentPath).then(()=>true,()=>false)
const existing=await readdir(join(ready.dataDir,'conversations',ready.conversationId,'runs')).catch(()=>[])
if(!ready.assistant&&!intentExists&&existing.length!==(resume?1:0))throw Error('INSPECT_EXISTING_RUNS_BEFORE_SUBMISSION')
const hash=createHash('sha256').update(input.prompt).digest('hex')
if(intentExists){const old=JSON.parse(await readFile(intentPath,'utf8'));if(old.requestId!==requestId||old.promptSha256!==hash)throw Error('SUBMISSION_INTENT_MISMATCH')}
else await writeFile(intentPath,JSON.stringify({requestId,conversationId:ready.conversationId,promptSha256:hash,transport:'original-development-service-api',uiInputAcceptance:false,at:new Date().toISOString()},null,2))
const s=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
if(!s.ok)throw Error('DEV_SESSION_UNAVAILABLE')
const headers={Origin:base,Cookie:s.headers.get('set-cookie'),'Content-Type':'application/json'}
if(resume){const state=await fetch(base+`/api/runs/${input.firstRunId}/state`,{headers}).then(r=>r.json());if(state.state==='running')throw Error('INTERRUPTED_RUN_NOT_SETTLED')}
const response=await fetch(base+(ready.assistant?'/api/assistant/messages':`/api/conversations/${ready.conversationId}/messages`),{method:'POST',headers,body:JSON.stringify({text:input.prompt,requestId})})
const receipt=await response.json()
await writeFile(join(out,`${name}-receipt.json`),JSON.stringify({status:response.status,...receipt},null,2))
if(!response.ok)throw Error(`SUBMISSION_HTTP_${response.status}`)
console.log(JSON.stringify(receipt))
