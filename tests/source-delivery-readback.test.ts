import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

it.each(['passed','conflict','changed','missing','coverage','metadata-invalid'] as const)('audits complete persisted body rather than a worker summary: %s',async mode=>{
 let agentId='',work=0,audits=0,pages=0
 const body='A'.repeat(mode==='coverage'?200000:3100)+'ACTUAL_BODY_TAIL'
 const program=buildTaskControllerProgram({version:'28',system:'test',toolNames:['fs.write','web.fetch','fs.read'],approvalMode:'auto',maxTurns:24,modelBudgetView:()=>({limit:24,used:8,workAllowed:audits===0,verificationAllowed:true,finalAllowed:true})})
 const runtime=new PulseRuntime({effectExecutor:async effect=>{
  const input=effect.input as any
  if(effect.kind==='tool'){
   if(input.name==='web.fetch')return{value:{content:'Primary source: accurate claim',url:'https://source.example/'}}
   if(input.name==='fs.write')return{value:{path:'report.md',hash:'a'.repeat(64)}}
   if(input.name==='fs.read'){
    pages++;if(mode==='missing')throw Error('ENOENT')
    const offset=input.arguments.offset,next=Math.min(offset+3000,body.length)
    return{value:{path:'report.md',offset,content:body.slice(offset,next),hash:mode==='changed'&&pages===2?'b'.repeat(64):'a'.repeat(64),truncated:mode==='metadata-invalid'?false:next<body.length,nextOffset:next<body.length?next:null}}
   }
  }
  const refs=[...runtime.state.results.values()].filter(r=>r.producer?.kind==='effect'&&runtime.state.effects.get(r.producer.id)?.kind==='tool').map(r=>r.id)
  if(effect.key?.startsWith('plan'))return{value:{tasks:[{id:'report',kind:'analyze',goal:'Save and explain the factual report',check:'Correct complete report',criterionIds:['criterion-1'],dependsOn:[]}]}}
  if(effect.key?.startsWith('verify-stage'))return{value:{status:'passed',evidenceRefs:refs,note:'Report saved'}}
  if(effect.key?.startsWith('verify-task'))return{value:{criteria:[{criterionId:'criterion-1',status:'passed',evidenceRefs:refs,rationale:'Optimistic stage assessment'}]}}
  if(effect.key?.startsWith('verify-sources')){
   audits++
   const evidence=input.inputs.results.map((ref:string)=>runtime.state.results.get(ref)?.value as any)
   const reads=evidence.filter((r:any)=>r?.path==='report.md'&&typeof r.content==='string')
   expect(reads.map((r:any)=>r.content).join('')).toBe(body)
   const readRefs=input.inputs.results.filter((ref:string)=>{const value=runtime.state.results.get(ref)?.value as any;return typeof value?.content==='string'&&value?.path==='report.md'})
   return{value:{criteria:[{criterionId:'criterion-1',status:'passed',evidenceRefs:[...readRefs,...input.inputs.results.filter((ref:string)=>(runtime.state.results.get(ref)?.value as any)?.url)],rationale:'Actual body read'}],findings:mode==='conflict'?[{criterionId:'criterion-1',claim:'Wrong claim in actual body',status:'contradicted',evidenceRefs:[...readRefs,...input.inputs.results.filter((ref:string)=>(runtime.state.results.get(ref)?.value as any)?.url)],rationale:'Actual file contradicts primary source'}]:[]}}
  }
  work++
  if(work<=2)return{value:{text:'',toolCalls:[{name:work===1?'web.fetch':'fs.write',input:work===1?{url:'https://source.example/'}:{path:'report.md',content:body.slice(0,5000)},toolCallId:`work-${work}`}],finishReason:'tool_calls'}}
  return{value:{text:'The report is correct (worker summary, not actual file contents).',finishReason:'stop'}}
 }})
 agentId=runtime.createAgent({goal:'Save an accurate report from primary sources',program,initialGlobal:{taskRecord:{schemaVersion:1,runId:'readback',objective:'Save an accurate report from primary sources',acceptanceCriteria:[{id:'criterion-1',description:'Accurate complete report'}],status:'in_progress',replanCount:0,attempts:[],evidenceRefs:[],excludedRefs:[]}}}).agentId
 const outcome=await runtime.start(agentId).outcome()
 const agent=runtime.state.agents.get(agentId)!,state=agent.globalVersions.get(agent.latestGlobalVersion) as any
 expect(state.taskOutcome,JSON.stringify(outcome)).toBeDefined()
 expect(state.taskOutcome.status).toBe(mode==='passed'?'accepted':'incomplete')
 expect(audits).toBe(mode==='passed'||mode==='conflict'?1:0)
 if(mode==='coverage'){expect(pages).toBeGreaterThan(2);expect(pages).toBeLessThanOrEqual(64)}else expect(pages).toBe(mode==='missing'||mode==='metadata-invalid'?1:2)
 if(mode==='passed')expect(state.taskOutcome.criteria[0].evidenceRefs).toEqual(expect.arrayContaining(state.taskController.sourceDelivery.refs))
 if(mode==='changed'||mode==='missing'||mode==='metadata-invalid')expect(state.taskOutcome.criteria[0].rationale).toContain('SOURCE_DELIVERY_READ_UNAVAILABLE')
 if(mode==='coverage')expect(state.taskOutcome.criteria[0].rationale).toContain('SOURCE_DELIVERY_COVERAGE_INSUFFICIENT')
})
