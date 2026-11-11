import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { PulseRuntime, FileRuntimePersistenceBackend } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { buildTaskControllerProgram as legacy } from '../packages/server/src/task-controller/program-v57.js'
import { emptyReliability, excludeEvidence, mergeReliability, observeCycle, observeEnvironment, progressFacts } from '../packages/server/src/task-controller/reliability.js'
import { checkTarget, environmentBlock } from '../packages/server/src/task-controller/stage-checks.js'
import { controllerFromGlobal, initialController, recoverUnmetGoal, unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'
import { failureRecord } from '../packages/server/src/task-controller/recovery.js'

const task = () => ({ id:'edit',kind:'edit' as const,goal:'Update app.ts',check:'app.ts contains the requested change',criterionIds:['c'],dependsOn:[],status:'running' as const,attempts:1,evidenceRefs:['old','unrelated'],contextRefs:['old'],hostCheckRefs:{old:'old',valid:'unrelated'} })
const context = (entries: Record<string,{tool:string;args?:object;value:unknown;status?:string}>) => ({ results: {
  meta:(ref:string)=>entries[ref] ? {effectKind:'tool',toolName:entries[ref].tool,toolArguments:entries[ref].args??{},outcomeStatus:entries[ref].status??'succeeded',ref} : undefined,
  read:(ref:string)=>entries[ref]?.value, summary:(ref:string)=>entries[ref]?.value,
} }) as any
const cycle = () => ({seen:[],processed:[],noProgress:0,phase:'work' as const})

it('excludes stale facts from all current evidence surfaces, including persisted child merges', () => {
  const state=initialController(64);state.tasks=[task()];state.priorTasks=[{...task(),id:'prior'}];state.evidenceIndex=['old','unrelated']
  excludeEvidence(state,['old'])
  expect(state.tasks[0]).toMatchObject({evidenceRefs:['unrelated'],contextRefs:[],hostCheckRefs:{valid:'unrelated'}})
  expect(state.priorTasks[0]?.evidenceRefs).toEqual(['unrelated'])
  const restored=controllerFromGlobal(JSON.parse(JSON.stringify({taskController:state})))!
  restored.tasks[0]!.evidenceRefs.push('old')
  mergeReliability(restored,state.reliability)
  expect(restored.tasks[0]!.evidenceRefs).toEqual(['unrelated'])
  expect(restored.reliability?.excludedRefs).toEqual(['old'])
})
it('persists correction at four, one alternative at eight, and blocking at twelve without progress', () => {
  let current=cycle()
  for(let i=1;i<=12;i++) {
    current=observeCycle(current,`round-${i}`,[]) as any
    expect(current.phase).toBe(i>=12?'blocked':i>=8?'alternative':i>=4?'correct':'work')
    expect(observeCycle(current,`round-${i}`,[])).toEqual(current)
  }
  const state=initialController(64);state.tasks=[{...task(),status:'blocked',failure:failureRecord('NO_PROGRESS','no progress')}];state.reliability={...emptyReliability(),cycles:{c:current}}
  expect(unmetGoalCanChangeApproach(state)).toBe(false)
  recoverUnmetGoal(state)
  expect(controllerFromGlobal(JSON.parse(JSON.stringify({taskController:state})))?.reliability?.cycles.c?.noProgress).toBe(12)
})
it('counts new read coverage and file versions, never duplicate receipt IDs or failed patch proposals', () => {
  const ctx=context({a:{tool:'fs.read',args:{path:'app.ts'},value:{path:'app.ts',hash:'h1',offset:0,nextOffset:100,content:'a'}},b:{tool:'fs.read',args:{path:'app.ts'},value:{path:'app.ts',hash:'h1',offset:0,nextOffset:100,content:'a'}},c:{tool:'fs.read',value:{path:'app.ts',hash:'h1',offset:100,nextOffset:null,content:'b'}},d:{tool:'fs.read',value:{path:'app.ts',hash:'h2',offset:0,nextOffset:100,content:'c'}},patch:{tool:'fs.apply_patches',status:'failed',value:{path:'app.ts',hash:'h3'}}})
  let current=observeCycle(cycle(),'1',progressFacts(ctx,['a']))
  current=observeCycle(current,'2',progressFacts(ctx,['b','patch']))
  expect(current.noProgress).toBe(1)
  current=observeCycle(current,'3',progressFacts(ctx,['c']));expect(current.noProgress).toBe(0)
  current=observeCycle(current,'4',progressFacts(ctx,['d']));expect(current.noProgress).toBe(0)
})
it('ignores changing duration, timestamps and pid in otherwise identical successful check output', () => {
  const ctx=context({a:{tool:'shell.exec',args:{command:'vitest',args:['run','x.test.ts']},value:{code:0,stdout:'3 passed 12ms\nStart at 12:00:00\npid=12'}},b:{tool:'shell.exec',args:{command:'vitest',args:['run','x.test.ts']},value:{code:0,stdout:'3 passed 25ms\nStart at 13:00:00\npid=13'}}})
  expect(progressFacts(ctx,['a'])).toEqual(progressFacts(ctx,['b']))
})
it('recognizes equivalent runners and limits one alternative for a repeated environment blocker', () => {
  const first={command:'npx',args:['-y','vitest','run','tests/api.test.ts']}, second={command:'node',args:['/workspace/node_modules/vitest/vitest.mjs','run','tests/api.test.ts']}
  expect(checkTarget(first)).toBe(checkTarget(second))
  expect(checkTarget({command:'C:\\tools\\npx.cmd',args:['--no-install','vitest','run','tests/api.test.ts']})).toBe(checkTarget(second))
  const value={code:1,stderr:"EPERM: operation not permitted, chmod '/tmp/pulse-ipc-501'"}
  expect(environmentBlock(first,value,'succeeded')?.key).toBe(environmentBlock(second,value,'succeeded')?.key)
  const ctx=context({a:{tool:'shell.exec',args:first,value},b:{tool:'shell.exec',args:second,value}}),ledger=emptyReliability()
  expect(observeEnvironment(ledger,ctx,['a'])).toBeUndefined()
  expect(observeEnvironment(ledger,ctx,['a'])).toBeUndefined()
  const restored=JSON.parse(JSON.stringify(ledger))
  expect(observeEnvironment(restored,ctx,['b'])).toContain('CHECK_ENVIRONMENT_BLOCKED')
})
it('ties background receipts to the original check instead of treating a new process ID as progress', () => {
  const args={command:'vitest',args:['run','api.test.ts']}
  const ctx=context({
    startA:{tool:'shell.start',args,value:{processId:'a'}},doneA:{tool:'shell.poll',args:{processId:'a'},value:{processId:'a',code:0,output:'3 passed 12ms'}},
    startB:{tool:'shell.start',args,value:{processId:'b'}},doneB:{tool:'shell.poll',args:{processId:'b'},value:{processId:'b',code:0,output:'3 passed 25ms'}},
    failedA:{tool:'shell.poll',args:{processId:'a'},value:{processId:'a',code:1,output:'listen EPERM'}},failedB:{tool:'shell.poll',args:{processId:'b'},value:{processId:'b',code:1,output:'listen EPERM'}},
    unchanged:{tool:'fs.apply_patch',value:{path:'a.ts',hash:'new-receipt-same-content',changed:false,alreadyApplied:true}},
  })
  expect(progressFacts(ctx,['startA','doneA'])).toEqual(progressFacts(ctx,['startB','doneB']))
  expect(progressFacts(ctx,['unchanged'])).toEqual([])
  const ledger=emptyReliability()
  expect(observeEnvironment(ledger,ctx,['startA','failedA'])).toBeUndefined()
  expect(observeEnvironment(ledger,ctx,['startA','failedA','startB','failedB'])).toContain('CHECK_ENVIRONMENT_BLOCKED')
})
it('distinguishes ordinary assertion failures, configuration discovery blocks, and successful checks', () => {
  const invocation={command:'node',args:['build.mjs']}
  expect(environmentBlock(invocation,{code:1,stderr:'Expected true, received false'},'succeeded')).toBeUndefined()
  expect(environmentBlock(invocation,{code:1,stderr:"EPERM: operation not permitted, open '/private/package.json'"},'succeeded')?.reason).toContain('configuration-read')
  expect(environmentBlock(invocation,{code:0,stderr:'EPERM fixture negative assertion passed'},'succeeded')).toBeUndefined()
})

describe('actual controller execution and persistence',()=>{
  it.each([1,2] as const)('stops repeated investigations with completed evidence retained (context protocol %s)',async protocol=>{
    let reads=0
    let runtime:PulseRuntime
    runtime=new PulseRuntime({effectExecutor:async effect=>{
      if(effect.kind==='tool'){reads++;return{value:{path:'app.ts',hash:'fixed-hash',offset:0,nextOffset:null,content:'unchanged'}}}
      if(effect.key.startsWith('plan'))return{value:{tasks:[{id:'edit',kind:'edit',goal:'Update app.ts',check:'app.ts has the requested change',criterionIds:['c'],dependsOn:[]}]}}
      if(effect.key.startsWith('verify'))return{value:{status:'needs_work',evidenceRefs:[],note:'No edit performed',criteria:[{criterionId:'c',status:'not_met',evidenceRefs:[],rationale:'No edit performed'}]}}
      return{value:{text:'',toolCalls:[{name:'fs.read',input:{path:'app.ts'}}],finishReason:'tool_calls'}}
    }})
    const program=buildTaskControllerProgram({system:'test',toolNames:['fs.read','fs.apply_patches'],readOnlyToolNames:['fs.read'],approvalMode:'auto',maxTurns:64,contextProtocolVersion:protocol})
    const {agentId}=runtime.createAgent({goal:'Update app.ts',program,initialGlobal:{taskRecord:{schemaVersion:1,runId:'fixture',objective:'Update app.ts',acceptanceCriteria:[{id:'c',description:'Update app.ts'}],status:'in_progress',replanCount:0,attempts:[],evidenceRefs:[],excludedRefs:[]}}})
    try{
      await runtime.start(agentId).outcome()
      expect(reads, JSON.stringify([...runtime.state.effects.values()].slice(-4).map(e=>({key:e.key,error:e.outcome?.error})))).toBeGreaterThan(0)
      expect(reads).toBeLessThan(20)
      const agent=runtime.state.agents.get(agentId)!,global=agent.globalVersions.get(agent.latestGlobalVersion) as any
      expect(global.taskOutcome.status).toBe('incomplete')
      expect(Object.values(global.taskController.reliability.cycles).some((c:any)=>c.phase==='blocked')).toBe(true)
      expect([...global.taskController.tasks,...global.taskController.priorTasks].flatMap((t:any)=>t.evidenceRefs).length).toBeGreaterThan(0)
      expect(global.taskController.usedTurns).toBeLessThan(32)
    }finally{await runtime.shutdown()}
  })
  it.each(['57','58'])('restores the saved v%s program without rebinding it or replaying settled effects',async version=>{
    const root=await mkdtemp(join(tmpdir(),'pulse-v58-restore-')),backend=new FileRuntimePersistenceBackend(join(root,'runtime.json'))
    const options={system:'fixture',toolNames:[],approvalMode:'auto' as const,maxTurns:16}
    const program=(version==='57'?legacy:buildTaskControllerProgram)(options)
    const runtime=new PulseRuntime()
    try{
      const state=initialController(16)
      if(version==='58')state.reliability={...emptyReliability(),excludedRefs:['old-read'],cycles:{c:{seen:['file-version-1'],processed:['round-1','round-2'],noProgress:7,phase:'correct'}}}
      const {agentId,laneId}=runtime.createAgent({goal:'fixture',program,initialGlobal:{taskController:state} as any})
      await runtime.persist(backend)
      const restored=await PulseRuntime.restore(backend,{programs:[legacy(options),buildTaskControllerProgram(options)]})
      try{
        expect(restored.state.lanes.get(laneId)?.resume.programVersion).toBe(version);expect(restored.state.agents.has(agentId)).toBe(true);expect(restored.state.effects.size).toBe(0)
        const agent=restored.state.agents.get(agentId)!,global=agent.globalVersions.get(agent.latestGlobalVersion)
        expect(controllerFromGlobal(global)?.reliability).toEqual(state.reliability)
      }finally{await restored.shutdown()}
    }finally{await runtime.shutdown();await rm(root,{recursive:true,force:true})}
  })
  it('preserves frozen source bytes in a real Git autocrlf checkout',async()=>{
    const path='packages/server/src/task-controller/program-v57.ts'
    const source=await readFile(path)
    const attributes=await readFile('.gitattributes')
    const root=await mkdtemp(join(tmpdir(),'pulse-frozen-checkout-'))
    const env={...process.env}
    for(const key of Object.keys(env))if(key.toUpperCase().startsWith('GIT_'))delete env[key]
    env.GIT_CONFIG_NOSYSTEM='1';env.GIT_ATTR_NOSYSTEM='1'
    env.GIT_CONFIG_GLOBAL=join(root,'empty-config')
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,env,stdio:'pipe'})
    try{
      await writeFile(env.GIT_CONFIG_GLOBAL,'')
      await mkdir(join(root,dirname(path)),{recursive:true})
      await writeFile(join(root,'.gitattributes'),attributes)
      await writeFile(join(root,path),source)
      await writeFile(join(root,'control.ts'),source)
      git('init','--quiet')
      git('config','--local','core.autocrlf','true')
      git('config','--local','core.safecrlf','false')
      git('config','--local','core.attributesFile',env.GIT_CONFIG_GLOBAL)
      git('add','--','.gitattributes',path,'control.ts')
      await rm(join(root,path));await rm(join(root,'control.ts'))
      git('checkout-index','--all','--force')
      // The unpinned control proves Git really performed Windows-style conversion.
      expect(await readFile(join(root,'control.ts'),'utf8')).toBe(source.toString('utf8').replaceAll('\n','\r\n'))
      expect(await readFile(join(root,path))).toEqual(source)
      const frozen=await readFile(join(root,path),'utf8')
      expect(createHash('sha256').update(frozen.replace("'./stage-checks-v57.js'","'./stage-checks.js'")).digest('hex')).toBe('ae5ab459c6ef69cedeeb01f775560c6ce058783018749686128dc0e0baf1dced')
    }finally{await rm(root,{recursive:true,force:true})}
  })
  it('freezes the exact v57 handler source instead of relabeling the v58 implementation',async()=>{
    const frozen=await readFile('packages/server/src/task-controller/program-v57.ts','utf8')
    expect(createHash('sha256').update(frozen.replace("'./stage-checks-v57.js'","'./stage-checks.js'")).digest('hex')).toBe('ae5ab459c6ef69cedeeb01f775560c6ce058783018749686128dc0e0baf1dced')
    expect(legacy({system:'fixture',toolNames:[],approvalMode:'auto',maxTurns:16}).version).toBe('57')
  })
})
