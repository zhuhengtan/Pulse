import {readFile,readdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const out=resolve(process.env.PULSE_EVAL_BATCH??'.pulse-dev/autonomy-failed-rerun-20261023/live',process.argv[2])
const ready=JSON.parse(await readFile(join(out,'ready.json'),'utf8'))
const runs=join(ready.dataDir,'conversations',ready.conversationId,'runs')
for(const runId of await readdir(runs).catch(()=>[])){
 const root=join(runs,runId),runtime=await readFile(join(root,'runtime.json'),'utf8').then(JSON.parse).catch(()=>null)
 const budget=await readFile(join(root,'model-budget.json'),'utf8').then(JSON.parse).catch(()=>null)
 const pending=runtime?.state?.state?.effects.filter(([,e])=>e.kind==='human'&&['running','queued'].includes(e.state))??[]
 const outcome=await readFile(join(root,'task-outcome.json'),'utf8').then(JSON.parse).catch(()=>null)
 console.log(JSON.stringify({runId,calls:budget?.used,taskStatus:outcome?.status,pending:pending.map(([id,e])=>({effectId:id,state:e.state,input:e.input}))},null,2))
 const frames=new Set(pending.flatMap(([,e])=>e.input?.tools?.map(t=>t.input?.frameId).filter(Boolean)??[]))
 if(frames.size)for(const file of await readdir(join(root,'runtime-results')).catch(()=>[])){
  const result=JSON.parse(await readFile(join(root,'runtime-results',file),'utf8'))
  if(frames.has(result.value?.frameId))console.log(JSON.stringify({observationRef:result.ref,frameId:result.value.frameId,title:result.value.title,url:result.value.url,text:result.value.text},null,2))
 }
}
