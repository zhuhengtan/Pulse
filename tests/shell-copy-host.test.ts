import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createLocalHost} from '../packages/server/src/index.js'
import {acceptanceCriteriaFromObjective} from '../packages/server/src/task.js'
import {currentRequestText,suppliedRequestResults} from './helpers/provider-request.js'

afterEach(()=>vi.unstubAllGlobals())
it('accepts a real verified shell copy without manufacturing an fs.write receipt',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'pulse-copy-host-'))
 await mkdir(join(cwd,'input'));await mkdir(join(cwd,'output'));await writeFile(join(cwd,'input/a.txt'),'original bytes\n')
 const objective='Copy input/a.txt to output/a.txt and verify the bytes, preserving the input.'
 const ids=acceptanceCriteriaFromObjective(objective).map(c=>c.id);let work=0
 const reply=(value:any)=>Response.json({choices:[{message:typeof value==='string'?{content:value}:value,finish_reason:value.tool_calls?'tool_calls':'stop'}]})
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const request=JSON.parse(String(init.body)),text=currentRequestText(request.messages),refs=suppliedRequestResults(request.messages).map(r=>r.id)
  if(request.messages.some((m:any)=>m.content?.includes('You are the Pulse safety reviewer')))return reply('APPROVE')
  if(text.includes('Create an executable plan'))return reply(JSON.stringify({tasks:[{id:'copy',kind:'edit',goal:'Copy input/a.txt to output/a.txt preserving input',check:'Read and verify exact output bytes',criterionIds:ids,dependsOn:[]}]}))
  if(text.includes('Verify ONLY the active'))return reply(JSON.stringify({status:'passed',evidenceRefs:refs,note:'Real copy and actual read-back match input.'}))
  if(text.includes('Independently verify every ORIGINAL'))return reply(JSON.stringify({criteria:ids.map(criterionId=>({criterionId,status:'passed',evidenceRefs:refs,rationale:'Real copied bytes checked.'}))}))
  work++;const tool=work===1?{name:'shell_exec',args:{command:'cp',args:['-p','input/a.txt','output/a.txt']}}:work===2?{name:'fs_read',args:{path:'output/a.txt'}}:undefined
  return tool?reply({content:'',tool_calls:[{id:'copy-'+work,function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}):reply('Copy complete.')
 }))
 const host=createLocalHost({cwd,dataDir:join(cwd,'data'),provider:{provider:'openai-compatible',defaultModel:'fixture'},approvalMode:'auto',taskController:true,jarvis:{enabled:false},maxModelCalls:24})
 try{
  const c=await host.createConversation(),run=await host.sendMessage(c.id,{text:objective})
  for await(const event of run.events)if(event.type==='waiting'){
   const interactions=await run.pendingInteractions(),tools=interactions.flatMap((i:any)=>i.items).find((i:any)=>i.effectId===event.data!.effectId)?.input?.tools
   if(tools)expect(tools).toEqual([expect.objectContaining({toolName:'shell.exec',input:expect.objectContaining({command:'cp',args:['-p','input/a.txt','output/a.txt']})})])
   await run.reply(String(event.data!.effectId),{approved:true})
  }
  const outcome=await run.outcome(),task=await run.taskOutcome()
  const ops=JSON.parse(await readFile(join(cwd,'data/conversations',c.id,'runs',run.id,'operations.json'),'utf8')).operations
  const snapshot=JSON.parse(await readFile(join(cwd,'data/conversations',c.id,'runs',run.id,'runtime.json'),'utf8')).state.state
  const tools=snapshot.effects.filter(([,e]:any)=>e.kind==='tool').map(([id,e]:any)=>({id,name:e.input.name,outcome:e.outcome}))
  const bodies=snapshot.results.filter(([,r]:any)=>tools.some((t:any)=>t.outcome?.resultRef===r.id)).map(([id,r]:any)=>({id,value:r.value??r.summary}))
  expect(task,JSON.stringify({outcome,tools,bodies})).toMatchObject({status:'accepted'})
  expect(await readFile(join(cwd,'output/a.txt'),'utf8')).toBe('original bytes\n')
  expect(await readFile(join(cwd,'input/a.txt'),'utf8')).toBe('original bytes\n')
  expect(ops.filter((o:any)=>o.tool==='fs.write'||o.tool==='fs.move')).toHaveLength(0)
 }finally{await host.close();await rm(cwd,{recursive:true,force:true})}
// Windows cold sandbox setup precedes the short copy command.
},process.platform==='win32'?240_000:30_000)
