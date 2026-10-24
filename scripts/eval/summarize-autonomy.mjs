import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root=resolve(process.argv[2]??'.pulse-dev/autonomy-20261022'),batch=join(root,'live')
const ledger=JSON.parse(await readFile(join(batch,'budget.json'),'utf8'))
const rows=[]
for(const a of ledger.attempts){
  let result
  try{result=JSON.parse(await readFile(a.result?.result??join(batch,a.id,'result.json'),'utf8'))}catch{}
  const status=result?.taskOutcome?.status??result?.taskOutcomeStatus??result?.runs?.find(r=>!r.input?.assistantChat)?.task?.status??null
  let approvals=typeof result?.approvals==='number'?result.approvals:result?.evaluatorApprovals?.length??null
  try { const ui=(await readFile(join(batch,a.id,'ui-approvals.jsonl'),'utf8')).trim().split('\n').filter(Boolean); approvals=ui.length } catch {}
  const verifier=result?.verification?.passed??null
  rows.push({id:a.id,taskKey:a.taskKey??a.id.replace(/-\d+$/,''),state:a.state,calls:a.charged,passed:a.result?.passed??false,taskStatus:status,graderPassed:verifier,approvals,durationMs:result?.durationMs??null,acceptedButGraderFailed:status==='accepted'&&verifier===false,result:a.result?.result??null})
}
const receipts=[]
for(const p of await readdir(join(batch,'approvals')).catch(()=>[]))if(p.endsWith('.receipt.json')){
 const d=JSON.parse(await readFile(join(batch,'approvals',p),'utf8'));receipts.push({runId:d.runId,effectId:d.effectId,approved:d.reply.approved,digest:d.requestSha256,source:p})
}
for(const dir of await readdir(batch,{withFileTypes:true}))if(dir.isDirectory()){
 try{for(const line of (await readFile(join(batch,dir.name,'ui-approvals.jsonl'),'utf8')).trim().split('\n').filter(Boolean)){const d=JSON.parse(line);receipts.push({runId:d.runId,effectId:d.effectId,approved:d.approved,digest:d.requestSha256??d.rawInput?.digest,source:dir.name+'/ui-approvals.jsonl'})}}catch{}
}
const cohorts={}
for(const [name,filter] of [['focused',r=>!r.id.startsWith('round-')&&!r.id.includes('-trial-')&&!r.id.includes('-electron-')],['visible-development',r=>r.id.includes('-electron-dev-')],['visible-harness-failure',r=>r.id.includes('-electron-')&&!r.id.includes('-electron-dev-')],['long-first',r=>r.id.startsWith('round-autonomy-20261022-')],['long-repair',r=>r.id.startsWith('round-autonomy-repair-20261022-')],['general',r=>r.id.includes('-trial-')]]){
 const selected=rows.filter(filter);cohorts[name]={attempts:selected.length,settled:selected.filter(r=>r.state==='recorded').length,recordedPassed:selected.filter(r=>r.passed).length,unassistedCompleted:selected.filter(r=>r.passed&&r.taskStatus==='accepted'&&!r.id.startsWith('cold-')&&r.approvals===0).length,approvalAssistedCompleted:selected.filter(r=>r.passed&&r.taskStatus==='accepted'&&!r.id.startsWith('cold-')&&r.approvals>0).length,calls:selected.reduce((n,r)=>n+r.calls,0),acceptedButGraderFailed:selected.filter(r=>r.acceptedButGraderFailed).map(r=>r.id)}
}
const summary={generatedAt:new Date().toISOString(),limit:ledger.limit,charged:rows.reduce((n,r)=>n+r.calls,0),reservedCalls:rows.filter(r=>r.state!=='recorded').reduce((n,r)=>n+r.calls,0),simulatedApprovals:receipts.length,approved:receipts.filter(r=>r.approved).length,denied:receipts.filter(r=>!r.approved).length,cohorts,rows,receipts,limitations:['Focused includes expected capability blockage and partial cold recovery; recordedPassed is not business completion.','No best-of selection. Original failed attempts and evaluator failures remain.','Approval-assisted completion is distinct from autonomous recovery; source fixes between focused attempts require explicit attribution.']}
const dataset=JSON.parse(await readFile('evals/tasks.v1.json','utf8'))
summary.generalFirstRound=dataset.tasks.map(spec=>{
 const row=rows.find(r=>r.id===`${spec.id}-trial-1`||r.id===`${spec.id}-electron-dev-1`)
 return {caseId:spec.id,category:spec.category,attempt:row?.id??null,passed:row?.passed??false,calls:row?.calls??null,cohort:row?.id.includes('-electron-dev-')?'visible-development':row?'general':null}
})
for(const [name,c] of Object.entries(cohorts)){
 const selected=rows.filter(r=>name==='visible-development'?r.id.includes('-electron-dev-'):name==='general'?r.id.includes('-trial-'):name==='long-first'?r.id.startsWith('round-autonomy-20261022-'):name==='long-repair'?r.id.startsWith('round-autonomy-repair-20261022-'):name==='focused'?!r.id.startsWith('round-')&&!r.id.includes('-trial-')&&!r.id.includes('-electron-'):r.id.includes('-electron-')&&!r.id.includes('-electron-dev-'))
 c.knownDurationMs=selected.reduce((n,r)=>n+(r.durationMs??0),0)
 c.durationUnknown=selected.filter(r=>r.durationMs===null).length
 c.knownApprovalInterruptions=selected.reduce((n,r)=>n+(r.approvals??0),0)
 c.approvalCountUnknown=selected.filter(r=>r.approvals===null).length
}
await writeFile(join(root,'metrics.json'),JSON.stringify(summary,null,2))
const table=['| 尝试 | 调用 | 任务状态 | 独立验收 | 人工批准次数 | 耗时秒 |','|---|---:|---|---|---:|---:|',...rows.map(r=>`| ${r.id} | ${r.calls}${r.state!=='recorded'?' (预留)':''} | ${r.taskStatus??'未知/未产生'} | ${r.passed?'记录通过':'未通过/未完成'} | ${r.approvals??'见收据'} | ${r.durationMs===null?'未知':Math.round(r.durationMs/1000)} |`)]
await writeFile(join(root,'ATTEMPTS.md'),`# 全部尝试\n\n生成时间 ${summary.generatedAt}。调用收费 ${summary.charged}/${ledger.limit}，其中预留 ${summary.reservedCalls}；模拟人工决定 ${receipts.length}（批准 ${summary.approved}，拒绝 ${summary.denied}）。\n\n能力缺失通过仅表示安全阻塞正确；冷恢复仅核心机制通过。两者不能直接算作完整业务完成。\n\n${table.join('\n')}\n`)
console.log(JSON.stringify({charged:summary.charged,reservedCalls:summary.reservedCalls,simulatedApprovals:receipts.length,cohorts}))
