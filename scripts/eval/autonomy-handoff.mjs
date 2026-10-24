import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createLocalHost, H5Server } from '../../packages/server/dist/index.js'
import { currentRecoveryBuild } from '../../packages/server/dist/recovery-contract.js'
import { loadHostModelConfig, waitForEvaluatorApproval } from '../../tests/real-task/runner.mjs'
import { withBatchBudget } from './autonomy-budget.mjs'

const batch=resolve(process.argv[2]??'.pulse-dev/autonomy-20261022/live'),id=process.argv[3]??'handoff-1',out=join(batch,id),workspace=join(out,'workspace'),dataDir=join(out,'data')
await mkdir(out,{recursive:false});await mkdir(workspace);await writeFile(join(workspace,'input.json'),'[2,3,5]\n')
for(const args of [['init','-q'],['config','user.name','Pulse Evaluation'],['config','user.email','eval@pulse.local'],['add','.'],['commit','-qm','frozen input']])execFileSync('git',args,{cwd:workspace})
await withBatchBudget(batch,id,async maxCalls=>{
  if(maxCalls<8)throw Error('INSUFFICIENT_HANDOFF_BUDGET')
  const config=await loadHostModelConfig(), allowance=Math.floor(maxCalls/2),ref=config.activeModel
  const host=createLocalHost({cwd:workspace,dataDir,provider:config.provider,providerProfiles:{deepseek:config.provider},providerModels:{[ref]:{provider:'deepseek',model:config.provider.defaultModel}},activeModel:ref,assistantModel:ref,approvalMode:'auto',...(config.approvalReview?{approvalReview:{...config.approvalReview,manualOnRejection:true}}:{}),maxModelCalls:allowance,maxRuntimeMs:600000,jarvis:{enabled:false}})
  const server=new H5Server(host,{dataDir,port:0,host:'127.0.0.1'})
  let starts=0;const start=server.startWorkFromAssistant.bind(server)
  server.startWorkFromAssistant=(...args)=>{if(starts++!==0)throw Error('EVALUATOR_SINGLE_WORK_BUDGET');return start(...args)}
  const approvals=[],seen=new Set(),startedAt=Date.now()
  const records=async()=>{const rows=[];for(const c of await readdir(join(dataDir,'conversations')).catch(()=>[]))for(const r of await readdir(join(dataDir,'conversations',c,'runs')).catch(()=>[])){const dir=join(dataDir,'conversations',c,'runs',r);const read=async name=>JSON.parse(await readFile(join(dir,name),'utf8'));rows.push({conversationId:c,runId:r,dir,input:await read('input.json').catch(()=>null),outcome:await read('outcome.json').catch(()=>null),usage:await read('usage.json').catch(()=>null),task:await read('task-outcome.json').catch(()=>null)})}return rows}
  try{
    const {port}=await server.start(),base=`http://127.0.0.1:${port}`
    const session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}}),headers={Cookie:session.headers.get('set-cookie'),Origin:base,'Content-Type':'application/json'}
    const request=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`HTTP_${r.status}:${path}`);return r.json()}
    await request('/api/projects',{name:'Autonomy Handoff Fixture',cwd:workspace})
    const prompt='请用 work.list 确认 Autonomy Handoff Fixture 项目，然后只启动一个工作会话：读取 input.json，将其中数字求和，新建 result.json，内容为 {"sum":10} 并独立读取输入和输出验证；不要修改 input.json。启动后告诉我工作会话 ID，不要启动第二个，也不要把启动成功说成任务已验收完成。'
    await writeFile(join(out,'freeze.json'),JSON.stringify({prompt,build:currentRecoveryBuild(),model:ref,allowancePerRun:allowance},null,2))
    const receipt=await request('/api/assistant/messages',{requestId:'handoff-evaluation-'+id,text:prompt});await writeFile(join(out,'request-receipt.json'),JSON.stringify(receipt,null,2))
    let rows=[]
    while(Date.now()-startedAt<600000){
      rows=await records()
      for(const row of rows.filter(r=>!r.outcome)){
        const state=await request(`/api/runs/${row.runId}/state`).catch(()=>null)
        const event=state?.waiting
        if(event?.data?.effectId&&!seen.has(event.data.effectId+row.runId)){
          seen.add(event.data.effectId+row.runId)
          const persisted=JSON.parse(await readFile(join(row.dir,'runtime.json'),'utf8'));const raw=persisted.state.state.effects.find(([,e])=>e.id===event.data.effectId)?.[1]?.input;if(!raw)throw Error('APPROVAL_OPERATION_NOT_VISIBLE');
          const approval=await waitForEvaluatorApproval(join(batch,'approvals'),{...event,data:{...event.data,input:raw},runId:row.runId},row.input.cwd);approvals.push(approval)
          await request(`/api/runs/${row.runId}/reply`,{effectId:event.data.effectId,...approval.reply})
        }
      }
      if(rows.length&&rows.every(r=>r.outcome)&&(starts===0||rows.length>=2))break
      await new Promise(r=>setTimeout(r,300))
    }
    if(rows.some(r=>!r.outcome)||!rows.length)throw Error('HANDOFF_NOT_SETTLED')
    await new Promise(r=>setTimeout(r,500))
    rows=await records()
    const work=rows.filter(r=>!r.input.assistantChat),deliveryRoot=work[0]?.input?.cwd??workspace
    const artifact=JSON.parse(await readFile(join(deliveryRoot,'result.json'),'utf8').catch(()=> 'null'))
    const original=(await readFile(join(workspace,'input.json'),'utf8'))==='[2,3,5]\n'&&(await readFile(join(deliveryRoot,'input.json'),'utf8'))==='[2,3,5]\n'
    if(rows.some(r=>!Number.isInteger(r.usage?.modelCalls)))throw Error('HANDOFF_USAGE_UNKNOWN')
    const modelCalls=rows.reduce((n,r)=>n+r.usage.modelCalls,0)
    const result={id,modelCalls,durationMs:Date.now()-startedAt,starts,artifact,originalInputPreserved:original,runs:rows.map(({dir,...r})=>r),approvals:approvals.length,passed:starts===1&&artifact?.sum===10&&original&&work.length===1&&work[0].task?.status==='accepted'}
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({id,modelCalls,passed:result.passed,starts}))
    return{modelCalls,passed:result.passed,result:join(out,'result.json')}
  }finally{await server.stop();await host.close()}
})
