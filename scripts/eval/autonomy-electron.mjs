// Visible, UI-submitted run using the unchanged general-task fixture and grader.
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createLocalHost,H5Server,createBuiltinSkillCapabilityPack,createSkillCapabilityPack} from '../../packages/server/dist/index.js'
import {loadHostModelConfig} from '../../tests/real-task/runner.mjs'
import {withBatchBudget} from './autonomy-budget.mjs'
const batch=resolve('.pulse-dev/autonomy-20261022/live'),id='files-01-electron-1',out=join(batch,id),workspace=join(out,'workspace'),dataDir=join(out,'data')
const spec=JSON.parse(await readFile('evals/tasks.v1.json','utf8')).tasks.find(t=>t.id==='files-01')
await mkdir(workspace,{recursive:true});execFileSync('git',['init','-q'],{cwd:workspace})
for(const [p,c] of Object.entries(spec.fixtures)){await mkdir(dirname(join(workspace,p)),{recursive:true});await writeFile(join(workspace,p),c)}
const hash=b=>createHash('sha256').update(b).digest('hex'),files={}
async function snap(p){for(const e of await readdir(p,{withFileTypes:true})){const n=join(p,e.name);if(e.isDirectory())await snap(n);else if(/\.(ts|js|mjs|json)$/.test(n))files[n]=hash(await readFile(n))}}
for(const pkg of ['runtime','server','tool-sdk','adapters'])for(const d of ['src','dist'])await snap(`packages/${pkg}/${d}`)
for(const p of ['evals/tasks.v1.json','scripts/eval/grade.mjs','scripts/eval/autonomy-electron.mjs'])files[p]=hash(await readFile(p))
await writeFile(join(out,'freeze.json'),JSON.stringify({prompt:spec.prompt,files,fixtures:spec.fixtures},null,2))
await withBatchBudget(batch,id,async maxCalls=>{
 const c=await loadHostModelConfig();if(c.activeModel!=='deepseek/deepseek-flash')throw Error('UNEXPECTED_MODEL')
 const host=createLocalHost({cwd:workspace,dataDir,provider:c.provider,activeModel:c.activeModel,approvalMode:'auto',...(c.approvalReview?{approvalReview:{...c.approvalReview,manualOnRejection:true}}:{}),taskController:true,maxModelCalls:maxCalls,maxRuntimeMs:600000,allowNetwork:false,capabilityPacks:[createBuiltinSkillCapabilityPack(),createSkillCapabilityPack({trustedRoots:[]})],enabledCapabilityPacks:['builtin-skills','skills'],jarvis:{enabled:false}})
 const server=new H5Server(host,{dataDir,port:0,host:'127.0.0.1'}),startedAt=Date.now()
 try{
  const conv=await host.createConversation({cwd:workspace,title:'现场测试 · CSV 文件转换',approvalPolicy:'delegate'})
  const {port}=await server.start()
  await writeFile(join(out,'ready.json'),JSON.stringify({port,conversationId:conv.id,dataDir,workspace,maxCalls,prompt:spec.prompt}))
  console.log('READY',JSON.stringify({port,conversationId:conv.id,maxCalls}))
  const runs=join(dataDir,'conversations',conv.id,'runs');let runId,result
  while(Date.now()-startedAt<1200000){
   const ids=await readdir(runs).catch(()=>[])
   if(ids.length>1)throw Error('UNEXPECTED_ADDITIONAL_RUN')
   if(ids[0]){runId=ids[0];const p=join(runs,runId);try{
    const outcome=JSON.parse(await readFile(join(p,'outcome.json'),'utf8')),usage=JSON.parse(await readFile(join(p,'usage.json'),'utf8')),task=JSON.parse(await readFile(join(p,'task-outcome.json'),'utf8'))
    const verification=JSON.parse(execFileSync(process.execPath,['scripts/eval/grade.mjs','--dataset','evals/tasks.v1.json','--task','files-01','--workspace',workspace],{encoding:'utf8'}))
    const sourceUnchanged=await readFile(join(workspace,'input/contacts.txt'),'utf8')===spec.fixtures['input/contacts.txt']
    result={id,conversationId:conv.id,runId,modelCalls:usage.modelCalls,durationMs:Date.now()-startedAt,taskOutcome:task,finalAnswer:outcome.text,verification,sourceUnchanged,passed:verification.passed&&sourceUnchanged&&task.status==='accepted'};break
   }catch(e){if(e.code!=='ENOENT')throw e}}
   await new Promise(r=>setTimeout(r,300))
  }
  if(!result)throw Error('UI_RUN_NOT_SETTLED')
  await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log('RESULT',JSON.stringify(result))
  return {modelCalls:result.modelCalls,passed:result.passed,result:join(out,'result.json')}
 }finally{await server.stop();await host.close()}
},id)
