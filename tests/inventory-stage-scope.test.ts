import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { isReadOnlyInventoryStage, stageRequiresFileChange, normalizeStageKinds } from '../packages/server/src/task-controller/state.js'

it.each([
  ['确认工作区现状：legacy 输入、dist-data/scripts/test 目录是否已有产物，避免覆盖已完成文件', 'fs.list 显示目录内容，并记录已存在的阶段产物', true],
  ['Read back existing output.json', 'fs.read confirms content', true],
  ['Inspect files and modify src/main.mjs', 'new behavior passes', false],
  ['Confirm output correctness', 'Run node --test test/output.test.mjs', false],
  ['Create output.json', 'file exists', false],
  ['编写 test/migration.test.mjs', 'npm test passes', false],
])('classifies inventory without suppressing requested writes or executable checks (%s)', (goal, check, expected) => {
  expect(isReadOnlyInventoryStage(goal, check, 'verify')).toBe(expected)
})

const metadataGoal='读取 src/price.mjs 与现有测试文件，确认当前 total(items) 实现、导出方式与测试运行命令（不修改测试）。'
const metadataCheck='列出 src/price.mjs 的现有实现与导出、测试文件路径及 package.json 中的测试脚本命令。'
it('distinguishes identifying a test command from executing it only in the new intent mode',()=>{
 expect(isReadOnlyInventoryStage(metadataGoal,metadataCheck,'verify')).toBe(false)
 expect(isReadOnlyInventoryStage(metadataGoal,metadataCheck,'verify',true)).toBe(true)
 expect(isReadOnlyInventoryStage(metadataGoal,'列出测试运行命令，然后运行 node --test test/price.test.mjs','verify',true)).toBe(false)
 expect(isReadOnlyInventoryStage('Read source and identify the test execution command','Record the command metadata','verify',true)).toBe(true)
})
it('requires a real rewrite despite dependency/import restrictions while retaining read-only prohibitions',()=>{
 const goal='重写 total(items)，校验 quantity 与 price 后按分累加；不引入任何依赖。',check='代码正确；无新增 import。'
 expect(stageRequiresFileChange(goal,check,'analyze',true,true,true,true)).toBe(false)
 expect(stageRequiresFileChange(goal,check,'analyze',true,true,true,true,true)).toBe(true)
 expect(normalizeStageKinds([{id:'fix',goal,check,kind:'analyze',criterionIds:['criterion-1'],dependsOn:[]}],true,true,true,true,true)[0]?.kind).toBe('edit')
 expect(stageRequiresFileChange('只分析重写方案，不修改任何文件',check,'edit',true,true,true,true,true)).toBe(false)
})

it.each(['legacy-baseline','metadata-only','post-fix-failure']as const)('does not run an unsolicited baseline in inventory or waive final tests: %s',async mode=>{
 const version=mode==='legacy-baseline'?'49':'50',testCalls:boolean[]=[],writes:string[]=[]
 let runtime:PulseRuntime,agentId='',metaTurns=0,fixTurns=0,fixed=false
 const current=()=>{const a=runtime.state.agents.get(agentId)!;return a.globalVersions.get(a.latestGlobalVersion)as any}
 const program=buildTaskControllerProgram({version,system:'test',toolNames:['fs.read','fs.write','shell.exec'],readOnlyToolNames:['fs.read'],approvalMode:'auto',maxTurns:32})
 runtime=new PulseRuntime({effectExecutor:async effect=>{
  const input=effect.input as any
  if(effect.kind==='tool'){
   if(input.name==='shell.exec'){testCalls.push(fixed);return{value:{code:fixed&&mode!=='post-fix-failure'?0:1,stdout:'actual fixture check',stderr:''}}}
   if(input.name==='fs.write'){fixed=true;writes.push(input.arguments.path);return{value:{path:input.arguments.path,hash:'b'.repeat(64)}}}
   return{value:{path:'src/price.mjs',content:'old source',hash:'a'.repeat(64),nextOffset:null}}
  }
  if(effect.key.startsWith('plan'))return{value:{tasks:[{id:'metadata',kind:'verify',goal:metadataGoal,check:metadataCheck,criterionIds:['criterion-1'],dependsOn:[]},{id:'fix',kind:'analyze',goal:'重写 src/price.mjs 并运行现有测试，不引入任何依赖',check:'node --test test/price.test.mjs 必须通过；无新增 import',criterionIds:['criterion-1'],dependsOn:['metadata']}]}}
  const refs=[...runtime.state.results.values()].filter(r=>r.producer?.kind==='effect'&&runtime.state.effects.get(r.producer.id)?.kind==='tool').map(r=>r.id)
  if(effect.key.startsWith('verify-stage'))return{value:{status:'passed',evidenceRefs:refs,note:'Stage contribution checked'}}
  if(effect.key.startsWith('verify-task'))return{value:{criteria:[{criterionId:'criterion-1',status:'passed',evidenceRefs:refs,rationale:'Optimistic model cannot waive actual test failure'}]}}
  const task=current().taskController.tasks.find((t:any)=>t.id===current().taskController.activeId)
  let tool:any
  if(task.id==='metadata'){
   if(++metaTurns===1)tool={name:'shell.exec',input:{command:'node',args:['--test','test/price.test.mjs']}}
   else if(metaTurns===2)tool={name:'fs.read',input:{path:'src/price.mjs'}}
  }else{
   if(++fixTurns===1)tool={name:'fs.write',input:{path:'src/price.mjs',content:'fixed fixture source'}}
   else if(fixTurns===2)tool={name:'shell.exec',input:{command:'node',args:['--test','test/price.test.mjs']}}
  }
  return{value:tool?{finishReason:'tool_calls',toolCalls:[tool]}:{finishReason:'stop',text:'Stage complete'}}
 }})
 agentId=runtime.createAgent({goal:'Fix src/price.mjs and pass the existing tests',program,initialGlobal:{taskRecord:{schemaVersion:1,runId:'metadata-boundary',objective:'Fix src/price.mjs and pass the existing tests',acceptanceCriteria:[{id:'criterion-1',description:'Fixed source and existing tests pass'}],status:'in_progress',replanCount:0,attempts:[],evidenceRefs:[],excludedRefs:[]}}}).agentId
 await runtime.start(agentId).outcome()
 expect(current().taskOutcome.status==='accepted').toBe(mode==='metadata-only')
 expect(testCalls).toEqual(mode==='legacy-baseline'?[false]:[true])
 expect(writes).toEqual(mode==='legacy-baseline'?[]:['src/price.mjs'])
})

it.each(['38', '39'] as const)('restricts inventory mutations only for v39, preserving v%s restoration', async version => {
  let runtime: PulseRuntime, agentId = '', workCalls = 0
  const mutations: string[] = []
  const global = () => { const agent = runtime.state.agents.get(agentId)!; return agent.globalVersions.get(agent.latestGlobalVersion) as any }
  const program = buildTaskControllerProgram({ version, system: 'test', toolNames: ['fs.list', 'fs.write', 'shell.exec'], readOnlyToolNames: ['fs.list'], approvalMode: 'auto', maxTurns: 24 })
  runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') {
      const name = (effect.input as any).name
      if (name !== 'fs.list') mutations.push(name)
      return { value: name === 'fs.list' ? { path: '.', entries: [] } : { path: 'scripts/generator.mjs', changed: true } }
    }
    if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: 'inventory', kind: 'verify', goal: 'Inspect existing workspace files', check: 'fs.list records current entries', dependsOn: [], criterionIds: ['criterion-1'] }] } }
    const stage = global().taskController.tasks[0]
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: stage.evidenceRefs, note: 'Existing state inspected.' } }
    if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: stage.evidenceRefs, rationale: 'Inspected actual directory state.' }] } }
    workCalls++
    if (workCalls === 1) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'scripts/generator.mjs', content: 'unrequested premature write' } }] } }
    if (workCalls === 2) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['scripts/generator.mjs'] } }] } }
    if (workCalls === 3) return { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.list', input: { path: '.' } }] } }
    return { value: { text: 'Existing workspace entries inspected.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Inspect existing workspace files', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Inspect existing workspace files', acceptanceCriteria: [{ id: 'criterion-1', description: 'Inspect current entries' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  expect(global().taskOutcome.status).toBe('accepted')
  expect(mutations).toEqual(version === '39' ? [] : ['fs.write', 'shell.exec'])
})
