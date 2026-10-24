import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createLocalHost } from '../../packages/server/dist/index.js'
import { loadHostModelConfig, waitForEvaluatorApproval, replyToWaitingEvent } from '../../tests/real-task/runner.mjs'
import { withBatchBudget } from './autonomy-budget.mjs'

const batch=resolve(process.argv[2]??'.pulse-dev/autonomy-20261022/live'), id=process.argv[3]??'cold-1',phase=process.argv[4]
const out=join(batch,id),workspace=join(out,'workspace'),dataDir=join(out,'data'),identityPath=join(out,'identity.json')
const prompt='请运行 node produce.mjs 恰好一次，产生 receipt.txt 和追加 side-effects.log，然后运行 node --test verify.test.mjs 验证。保留已有内容，不修改这两个脚本，不重复执行 produce.mjs，最后新建 DELIVERY.md 简述真实结果。遇到进程中断时先检查已有产物和日志，只完成未完成步骤。'
const seed={
  'produce.mjs': "import {appendFileSync,writeFileSync} from 'node:fs';appendFileSync('side-effects.log','produced\\n');writeFileSync('receipt.txt','cold-process-acceptance\\n');console.log('produced');\n",
  'verify.test.mjs': "import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';test('one write',()=>{assert.equal(readFileSync('receipt.txt','utf8'),'cold-process-acceptance\\n');assert.equal(readFileSync('side-effects.log','utf8'),'produced\\n')});\n",
}
if(!phase){
  await mkdir(out,{recursive:false});await mkdir(workspace)
  for(const [path,content]of Object.entries(seed))await writeFile(join(workspace,path),content)
  await writeFile(join(out,'freeze.json'),JSON.stringify({prompt,seed,evaluator:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),build:createHash('sha256').update(await readFile(new URL('../../packages/server/dist/index.js',import.meta.url))).digest('hex')},null,2))
  await withBatchBudget(batch,id,async maxCalls=>{
    await writeFile(join(out,'limit.json'),JSON.stringify({maxCalls}))
    const launch=phase=>new Promise((res,rej)=>{const p=spawn(process.execPath,[new URL(import.meta.url).pathname,batch,id,phase],{stdio:'inherit'});p.on('error',rej);p.on('exit',code=>res({code,pid:p.pid}))})
    const first=await launch('start')
    if(first.code!==77)throw Error('COLD_BOUNDARY_NOT_REACHED')
    const before={receipt:await readFile(join(workspace,'receipt.txt'),'utf8'),log:await readFile(join(workspace,'side-effects.log'),'utf8')}
    await writeFile(join(out,'before-resume.json'),JSON.stringify({first,...before},null,2))
    const second=await launch('resume')
    const result=JSON.parse(await readFile(join(out,'result.json'),'utf8'))
    const unchanged=(await Promise.all(Object.entries(seed).map(async([p,c])=>await readFile(join(workspace,p),'utf8')===c))).every(Boolean)
    result.cold={first,second,differentProcess:first.pid!==second.pid,checkpointBefore:before,seedUnchanged:unchanged}
    result.passed=result.passed&&unchanged&&first.pid!==second.pid
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2))
    return {modelCalls:result.modelCalls,passed:result.passed,result:join(out,'result.json')}
  })
}else{
  const config=await loadHostModelConfig(),{maxCalls}=JSON.parse(await readFile(join(out,'limit.json'),'utf8'))
  const host=createLocalHost({cwd:workspace,dataDir,provider:config.provider,activeModel:config.activeModel,approvalMode:'auto',...(config.approvalReview?{approvalReview:{...config.approvalReview,manualOnRejection:true}}:{}),taskController:true,maxModelCalls:maxCalls,maxRuntimeMs:600000,jarvis:{enabled:false}})
  let handle,identity
  try{
    if(phase==='start'){const conv=await host.createConversation({cwd:workspace,title:id,approvalPolicy:'delegate'});handle=await host.sendMessage(conv.id,{text:prompt});identity={conversationId:conv.id,runId:handle.id};await writeFile(identityPath,JSON.stringify(identity))}
    else{identity=JSON.parse(await readFile(identityPath,'utf8'));handle=await host.resumeRun(identity.conversationId)}
    for await(const event of handle.events){
      await appendFile(join(out,`events-${phase}.jsonl`),JSON.stringify(event)+'\n')
      if(event.type==='observation'&&(event.data.kind==='model'||event.data.tool))console.log(JSON.stringify({phase,kind:event.data.kind,tool:event.data.tool,status:event.data.status}))
      if(event.type==='waiting'&&event.data?.effectId){
        if(phase==='start'&&await readFile(join(workspace,'receipt.txt'),'utf8').catch(()=>null)){
          // Exit this evaluator process only. The suspended human effect and prior
          // settled write are already durable; no model is running at this boundary.
          await writeFile(join(out,'cold-boundary.json'),JSON.stringify({pid:process.pid,event,budget:JSON.parse(await readFile(join(dataDir,'conversations',identity.conversationId,'runs',identity.runId,'model-budget.json'),'utf8'))},null,2))
          process.exit(77)
        }
        const receipt=await waitForEvaluatorApproval(join(batch,'approvals'),event,workspace)
        await replyToWaitingEvent(handle,event,receipt.reply)
      }
    }
    const outcome=await handle.outcome(),taskOutcome=await handle.taskOutcome(),usage=await handle.usage()
    const sideEffects=await readFile(join(workspace,'side-effects.log'),'utf8').catch(()=>null),receipt=await readFile(join(workspace,'receipt.txt'),'utf8').catch(()=>null),delivery=await readFile(join(workspace,'DELIVERY.md'),'utf8').catch(()=>null)
    const result={pid:process.pid,modelCalls:usage.modelCalls,usage,runtimeStatus:outcome.status,taskOutcome,sideEffects,receipt,delivery,passed:sideEffects==='produced\n'&&receipt==='cold-process-acceptance\n'&&Boolean(delivery)&&taskOutcome?.status==='accepted'}
    await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({phase,passed:result.passed,calls:result.modelCalls}))
  }finally{await host.close()}
}
