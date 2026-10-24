import {expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,copyFile,rm,realpath,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PulseRuntime} from '@hunterzhu/pulse-runtime'
import {captureCopy,finishCopy,copyChanges} from '../packages/server/src/task-controller/copy-evidence.js'
import {staleFileEvidence} from '../packages/server/src/task-controller/evidence-current.js'
import {buildTaskControllerProgram} from '../packages/server/src/task-controller/program.js'

async function fixture(work:(root:string)=>Promise<void>){
 const root=await realpath(await mkdtemp(join(tmpdir(),'pulse-copy-receipt-')))
 try{await mkdir(join(root,'input'));await mkdir(join(root,'output'));await writeFile(join(root,'input/a.bin'),Buffer.from([0,128,255,10]));await work(root)}
 finally{await rm(root,{recursive:true,force:true})}
}
it('records an actual binary copy and detects later source or destination changes',()=>fixture(async root=>{
 const before=await captureCopy(root,root,'cp',['-p','input/a.bin','output/'])
 await copyFile(join(root,'input/a.bin'),join(root,'output/a.bin'))
 const fileChanges=await finishCopy(root,before,{code:0}),body={code:0,fileChanges}
 expect(copyChanges(body)).toEqual([expect.objectContaining({source:'input/a.bin',path:'output/a.bin',beforeHash:null})])
 const runtime=new PulseRuntime()
 runtime.state.effects.set('effect-1',{id:'effect-1',kind:'tool',input:{name:'shell.exec'},outcome:{status:'succeeded'}}as any)
 runtime.state.results.set('result-1',{id:'result-1',producer:{kind:'effect',id:'effect-1'},summary:body}as any)
 expect(await staleFileEvidence(root,['result-1'],runtime)).toEqual([])
 await writeFile(join(root,'output/a.bin'),'external destination change')
 expect(await staleFileEvidence(root,['result-1'],runtime)).toEqual(['result-1'])
 await copyFile(join(root,'input/a.bin'),join(root,'output/a.bin'))
 await writeFile(join(root,'input/a.bin'),'external source change')
 expect(await staleFileEvidence(root,['result-1'],runtime)).toEqual(['result-1'])
}))
it.runIf(process.platform!=='win32')('preserves literal backslashes in POSIX filenames in portable copy receipts',()=>fixture(async root=>{
 const source='input/a\\b.bin',destination='output/a\\b.bin'
 await writeFile(join(root,source),Buffer.from([0,128,255,10]))
 const before=await captureCopy(root,root,'cp',[source,'output/'])
 await copyFile(join(root,source),join(root,destination))
 expect(copyChanges({code:0,fileChanges:await finishCopy(root,before,{code:0})})).toEqual([expect.objectContaining({source,path:destination,beforeHash:null})])
}))
it.each([{code:1},{code:null},{code:0,timedOut:true},{code:0,aborted:true},{code:0,truncated:true}])('never creates proof from an unsuccessful or uncertain command (%j)',result=>fixture(async root=>{
 const before=await captureCopy(root,root,'cp',['input/a.bin','output/a.bin'])
 await copyFile(join(root,'input/a.bin'),join(root,'output/a.bin'))
 expect(await finishCopy(root,before,result)).toBeUndefined()
}))
it('requires an unchanged source and an exact destination hash',()=>fixture(async root=>{
 const before=await captureCopy(root,root,'cp',['input/a.bin','output/a.bin'])
 await writeFile(join(root,'output/a.bin'),'wrong bytes')
 expect(await finishCopy(root,before,{code:0})).toBeUndefined()
 await copyFile(join(root,'input/a.bin'),join(root,'output/a.bin'))
 await writeFile(join(root,'input/a.bin'),'changed while command ran')
 expect(await finishCopy(root,before,{code:0})).toBeUndefined()
}))
it('does not invent a change when a destination is already identical',()=>fixture(async root=>{
 await copyFile(join(root,'input/a.bin'),join(root,'output/a.bin'))
 const before=await captureCopy(root,root,'cp',['input/a.bin','output/a.bin'])
 expect(await finishCopy(root,before,{code:0})).toMatchObject({entries:[]})
}))
it('declines unsupported flags, directories, symlinks and outside operands',()=>fixture(async root=>{
 expect(await captureCopy(root,root,'cp',['-R','input','output'])).toBeUndefined()
 expect(await captureCopy(root,root,'cp',['input','output'])).toBeUndefined()
 expect(await captureCopy(root, root, 'cp', ['../outside.bin', 'output/a.bin'])).toBeUndefined()
 expect(await captureCopy(root,root,'/untrusted/cp',['input/a.bin','output/a.bin'])).toBeUndefined()
 await symlink(join(root,'input/a.bin'),join(root,'input/link.bin'))
 expect(await captureCopy(root,root,'cp',['input/link.bin','output/a.bin'])).toBeUndefined()
}))
it('ignores model/stdout claims and malformed receipts',()=>{
 const entry={path:'output/a.bin',source:'input/a.bin',sourceHash:'a'.repeat(64),hash:'a'.repeat(64),beforeHash:null}
 const fileChanges={schemaVersion:1,operation:'copy',entries:[entry]}
 expect(copyChanges({code:0,stdout:JSON.stringify({fileChanges})})).toEqual([])
 expect(copyChanges({code:1,fileChanges})).toEqual([])
 expect(copyChanges({code:0,fileChanges:{...fileChanges,entries:[{...entry,sourceHash:'b'.repeat(64)}]}})).toEqual([])
 expect(copyChanges({code:0,fileChanges:{...fileChanges,entries:[{...entry,beforeHash:entry.hash}]}})).toEqual([])
})

it('observes absolute operands through a workspace root alias without expanding scope',()=>fixture(async root=>{
 const alias=join(root,'root-alias');await symlink(root,alias)
 const before=await captureCopy(alias,root,'cp',[join(alias,'input/a.bin'),join(alias,'output/a.bin')])
 await copyFile(join(root,'input/a.bin'),join(root,'output/a.bin'))
 expect(await finishCopy(alias,before,{code:0})).toMatchObject({entries:[expect.objectContaining({path:'output/a.bin'})]})
}))

it.each(['copy','move','copy-no-proof','copy-failed','move-no-change','legacy-copy','legacy-move']as const)('keeps receipt and compatibility boundaries: %s',async mode=>{
 const version=mode.startsWith('legacy')?'48':'49',move=mode.includes('move'),name=move?'fs.move':'shell.exec'
 const entry={source:'input/a.bin',path:'output/a.bin',sourceHash:'a'.repeat(64),hash:'a'.repeat(64),beforeHash:null}
 const value=move?{source:entry.source,destination:entry.path,hash:entry.hash,...(mode==='move-no-change'?{changed:false}:{})}:{code:mode==='copy-failed'?1:0,...(mode==='copy-no-proof'?{stdout:'copy complete'}:{fileChanges:{schemaVersion:1,operation:'copy',entries:[entry]}})}
 const program=buildTaskControllerProgram({version,system:'test',toolNames:[name,'fs.write'],approvalMode:'auto',maxTurns:24})
 let runtime:PulseRuntime,work=0
 runtime=new PulseRuntime({effectExecutor:async effect=>{
  if(effect.kind==='tool')return{value}
  const refs=[...runtime.state.results.values()].filter(r=>r.producer?.kind==='effect'&&runtime.state.effects.get(r.producer.id)?.kind==='tool').map(r=>r.id)
  if(effect.key.startsWith('plan'))return{value:{tasks:[{id:'deliver',kind:'edit',goal:'Copy input/a.bin to output/a.bin',check:'Actual bytes preserved',criterionIds:['criterion-1'],dependsOn:[]}]}}
  if(effect.key.startsWith('verify-stage'))return{value:{status:'passed',evidenceRefs:refs,note:'Current copy inspected'}}
  if(effect.key.startsWith('verify-task'))return{value:{criteria:[{criterionId:'criterion-1',status:'passed',evidenceRefs:refs,rationale:'Current delivered bytes checked'}]}}
  if(++work===1)return{value:{finishReason:'tool_calls',toolCalls:[{name,input:move?{source:'input/a.bin',destination:'output/a.bin'}:{command:'cp',args:['input/a.bin','output/a.bin']}}]}}
  return{value:{finishReason:'stop',text:'Done'}}
 }})
 const agentId=runtime.createAgent({goal:'Copy input/a.bin to output/a.bin',program,initialGlobal:{taskRecord:{schemaVersion:1,runId:'copy-boundary',objective:'Copy input/a.bin to output/a.bin',acceptanceCriteria:[{id:'criterion-1',description:'Exact copied bytes'}],status:'in_progress',replanCount:0,attempts:[],evidenceRefs:[],excludedRefs:[]}}}).agentId
 await runtime.start(agentId).outcome()
 const agent=runtime.state.agents.get(agentId)!,state=agent.globalVersions.get(agent.latestGlobalVersion)as any
 expect(state.taskOutcome.status==='accepted').toBe(mode==='copy'||mode==='move')
})
