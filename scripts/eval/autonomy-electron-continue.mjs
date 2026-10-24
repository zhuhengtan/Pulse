import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {withBatchBudget} from './autonomy-budget.mjs'
import {withDevCallBudget} from './autonomy-dev-budget.mjs'
const batch=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-20261023/live'),[previousId,id,taskKey]=process.argv.slice(2),out=join(batch,id)
const previous=JSON.parse(await readFile(join(batch,previousId,'ready.json'),'utf8')),before=JSON.parse(await readFile(join(batch,previousId,'result.json'),'utf8'))
if(taskKey!=='cold')throw Error('UNSUPPORTED_CONTINUATION_GRADER')
await mkdir(out,{recursive:false})
const prompt='继续完成原任务。先核对已有产物和执行记录，只做尚未完成的工作，避免重复副作用。'
await withBatchBudget(batch,id,async maxCalls=>withDevCallBudget(out,maxCalls,async()=>{
 const base='http://127.0.0.1:7333',s=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}}),headers={Origin:base,Cookie:s.headers.get('set-cookie'),'Content-Type':'application/json'}
 const request=async path=>{const r=await fetch(base+path,{headers});if(!r.ok)throw Error(`HTTP_${r.status}`);return r.json()}
 const runs=join(previous.dataDir,'conversations',previous.conversationId,'runs'),oldIds=await readdir(runs),freeze={}
 const checkpoint=JSON.parse(await readFile(join(batch,previousId,'cold-boundary.json'),'utf8'))
 for(const name of ['produce.mjs','verify.test.mjs','receipt.txt','side-effects.log'])freeze[name]=createHash('sha256').update(await readFile(join(checkpoint.cwd,name))).digest('hex')
 await writeFile(join(out,'freeze.json'),JSON.stringify({previousId,oldIds,freeze,originalPrompt:previous.prompt,prompt,continuedAfterEvaluatorCancellation:true},null,2))
 await writeFile(join(out,'ready.json'),JSON.stringify({...previous,prompt,maxCalls,previousId,oldIds},null,2));console.log('READY',previous.conversationId)
 const started=Date.now()
 while(Date.now()-started<1200000){
  const ids=(await readdir(runs)).filter(id=>!oldIds.includes(id));if(ids.length>1)throw Error('UNEXPECTED_ADDITIONAL_RUN')
  if(ids[0]){
   const p=join(runs,ids[0]);if(await access(join(p,'task-outcome.json')).then(()=>true,()=>false)){
    const state=await request(`/api/runs/${ids[0]}/state`);if(state.state==='running'){await new Promise(r=>setTimeout(r,200));continue}
    const input=JSON.parse(await readFile(join(p,'input.json'),'utf8')),usage=JSON.parse(await readFile(join(p,'usage.json'),'utf8')),taskOutcome=JSON.parse(await readFile(join(p,'task-outcome.json'),'utf8'))
    const root=await access(input.cwd).then(()=>input.cwd,()=>previous.workspace)
    const unchanged=(await Promise.all(Object.entries(freeze).map(async([name,h])=>await readFile(join(root,name)).then(b=>createHash('sha256').update(b).digest('hex')===h,()=>false)))).every(Boolean)
    const record=JSON.parse(await readFile(join(p,'task-record.json'),'utf8'));const originalContractRetained=JSON.stringify(record).includes('produce.mjs')&&JSON.stringify(record).includes('DELIVERY.md')
    const delivery=await readFile(join(root,'DELIVERY.md'),'utf8').catch(()=>null)
    const result={id,previousId,conversationId:previous.conversationId,runId:ids[0],modelCalls:usage.modelCalls,taskOutcome,deliveryRoot:root,unchanged,originalContractRetained,delivery,durationMs:Date.now()-started,passed:unchanged&&originalContractRetained&&!!delivery&&taskOutcome.status==='accepted',note:'Supplementary continuation; original cancelled cold attempt remains partial. No business artifact was edited by evaluator.'}
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log('RESULT',result.passed,result.modelCalls);return {modelCalls:result.modelCalls,passed:result.passed,result:join(out,'result.json')}
   }
  }
  await new Promise(r=>setTimeout(r,200))
 }throw Error('CONTINUATION_NOT_SETTLED')
}),taskKey)
