import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { stageRequiresFileChange, normalizeStageKinds } from '../packages/server/src/task-controller/state.js'

it('distinguishes UI edits from code delivery without changing legacy classification', () => {
  const goal='在浏览器中填入 Name，点击 Save 并重新 browser.observe'
  expect(stageRequiresFileChange(goal,'页面显示 Saved','edit',true,true)).toBe(false)
  expect(stageRequiresFileChange(goal,'页面显示 Saved','edit',true,false)).toBe(true)
  expect(stageRequiresFileChange('修复浏览器 src/form.mjs 的保存逻辑','测试通过','edit',true,true)).toBe(true)
  expect(stageRequiresFileChange('为浏览器新增校验脚本','检查输入','edit',true,true)).toBe(true)
  expect(normalizeStageKinds([{id:'ui',kind:'edit',goal,check:'页面显示 Saved',criterionIds:['c'],dependsOn:[]}],true,true)[0]?.kind).not.toBe('edit')
})

it('executes observe, GUI mutation and fresh observe without demanding an unrelated file write', async () => {
  let agentId='',turn=0, clicks=0,observations=0
  const state=()=>{const a=runtime.state.agents.get(agentId)!;return (a.globalVersions.get(a.latestGlobalVersion) as any).taskController}
  const program=buildTaskControllerProgram({system:'test',toolNames:['fs.write','browser.observe','browser.act'],readOnlyToolNames:['browser.observe'],approvalMode:'auto',maxTurns:24})
  const runtime=new PulseRuntime({effectExecutor:async effect=>{
    if(effect.kind==='tool'){
      const name=(effect.input as any).name
      if(name==='fs.write')throw Error('UNRELATED_FILE_WRITE')
      if(name==='browser.act')clicks++;else observations++
      return {value:{text:clicks?'Saved':'Name Save',clicks}}
    }
    if(effect.key?.startsWith('plan'))return {value:{tasks:[{id:'ui',kind:'edit',goal:'在浏览器中填写后点击 Save 并重新观察',check:'真实页面显示 Saved',dependsOn:[],criterionIds:['c']}]}}
    if(effect.key?.startsWith('verify-stage'))return {value:{status:clicks===1&&observations===2?'passed':'needs_work',evidenceRefs:state().tasks[0].evidenceRefs,note:'UI evidence'}}
    if(effect.key?.startsWith('verify-task'))return {value:{criteria:[{criterionId:'c',status:'passed',evidenceRefs:state().tasks[0].evidenceRefs,rationale:'UI checked'}]}}
    turn++;return {value:turn<=3?{finishReason:'tool_calls',toolCalls:[{name:turn===2?'browser.act':'browser.observe',input:{}}]}:{finishReason:'stop',text:'Saved verified'}}
  }})
  agentId=runtime.createAgent({goal:'在浏览器中点击 Save',program,initialGlobal:{taskRecord:{schemaVersion:1,runId:'ui',objective:'在浏览器中点击 Save',acceptanceCriteria:[{id:'c',description:'点击 Save 并验证'}],status:'in_progress',replanCount:0,attempts:[],evidenceRefs:[],excludedRefs:[]}}}).agentId
  const result=await runtime.start(agentId).outcome()
  expect(result,JSON.stringify(result)).toMatchObject({status:'succeeded'})
  expect(clicks).toBe(1);expect(observations).toBe(2)
})


it('keeps delegated file reads in work instead of gating work.start on assistant reads', async () => {
  const { assistantChatAllowedToolNames, assistantWorkStartRequested } = await import('../packages/server/src/index.js')
  const names = ['work.list', 'work.start', 'fs.read']
  const prompt = '请用 work.list 确认项目，然后只启动一个工作会话：读取 input.json 并生成 result.json。不要启动第二个。'
  expect(assistantChatAllowedToolNames(names, prompt, new Set(['work.list']), true, false, true)).toEqual(['work.start'])
  expect(assistantChatAllowedToolNames(names, prompt, new Set(['work.list']), true, false, false)).toEqual(['fs.read'])
  expect(assistantWorkStartRequested('不要启动工作会话，请读取 input.json')).toBe(false)
  expect(assistantChatAllowedToolNames(names, '读取 input.json', new Set(), true, false, true)).toEqual(['fs.read'])
})

it('keeps a later input-preservation constraint from disabling an earlier delegation in assistant v5', async () => {
  const { assistantChatAllowedToolNames, assistantWorkStartRequested } = await import('../packages/server/src/index.js')
  const names = ['work.list', 'work.start', 'fs.read']
  const prompt = '请用 work.list 确认 Autonomy Handoff Fixture 项目，然后只启动一个工作会话：读取 input.json，将其中数字求和，新建 result.json，内容为 {"sum":10} 并独立读取输入和输出验证；不要修改 input.json。启动后告诉我工作会话 ID，不要启动第二个，也不要把启动成功说成任务已验收完成。'
  expect(assistantChatAllowedToolNames(names, prompt, new Set(['work.list']), true, false, true, true)).toEqual(['work.start'])
  // Saved v4 runs retain their original tool scheduling semantics.
  expect(assistantChatAllowedToolNames(names, prompt, new Set(['work.list']), true, false, true)).toEqual(['fs.read'])
  for (const denied of ['不要启动工作会话，请读取 input.json', '禁止执行以下操作：启动工作会话', 'Do not start a work session; read input.json']) {
    expect(assistantWorkStartRequested(denied, true)).toBe(false)
  }
  expect(assistantChatAllowedToolNames(names, prompt, new Set(['work.list', 'work.start']), true, false, true, true)).not.toContain('work.start')
})

it.each(['28', '29'] as const)('keeps recovery-chain evidence semantics versioned for controller %s', async version => {
  let agentId = '', plans = 0, inherited = false
  const turns = new Map<string, number>()
  const program = buildTaskControllerProgram({ version, system: 'test', toolNames: ['read'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 64 })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    const lane = runtime.state.lanes.get(effect.ownerLaneId)!
    const agent = runtime.state.agents.get(agentId)!
    const global = agent.globalVersions.get(agent.latestGlobalVersion) as any
    const state = (lane.context.state as any).taskControllerChain ?? global.taskController
    if (plans > 1 && (lane.context.state as any).taskControllerChain) {
      const prior = state.priorTasks.flatMap((t: any) => t.evidenceRefs)
      const supplied = (effect.input as any).inputs?.results ?? []
      inherited ||= prior.some((ref: string) => supplied.includes(ref) && lane.visibleResultRefs?.has(ref))
    }
    if (effect.kind === 'tool') return { value: { content: 'retained source evidence' } }
    if (effect.key?.startsWith('plan')) {
      plans++
      return { value: { tasks: plans === 1 ? [
        { id: 'stable', kind: 'analyze', goal: 'Read stable source', check: 'Report stable field', dependsOn: [], criterionIds: ['c1'] },
        { id: 'invalid', kind: 'analyze', goal: 'Read invalid target', check: 'Report requested field', dependsOn: [], criterionIds: ['c2'] },
      ] : [{ id: 'corrected', kind: 'analyze', goal: 'Read corrected target', check: 'Report requested field', dependsOn: [], criterionIds: ['c2'] }] } }
    }
    const task = state.tasks.find((t: any) => t.id === state.activeId)
    if (effect.key?.startsWith('verify-stage')) return { value: { status: task.id === 'invalid' ? 'blocked' : 'passed', evidenceRefs: task.evidenceRefs, note: task.id === 'invalid' ? 'INVALID_TOOL_INPUT: target was invalid; use the corrected source.' : 'Requested field verified.' } }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: ['c1', 'c2'].map(id => ({ criterionId: id, status: 'passed', evidenceRefs: state.tasks.filter((t: any) => t.status === 'passed' && t.criterionIds.includes(id)).flatMap((t: any) => t.evidenceRefs), rationale: 'Original read evidence is available.' })) } }
    const count = (turns.get(lane.id) ?? 0) + 1; turns.set(lane.id, count)
    return { value: count % 2 === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: task.goal } }] } : { finishReason: 'stop', text: 'Field read and reported.' } }
  } })
  agentId = runtime.createAgent({ goal: 'Read and report both fields; correct an invalid source if needed', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'recovery', objective: 'Read and report both fields', acceptanceCriteria: [{ id: 'c1', description: 'Read stable source' }, { id: 'c2', description: 'Read corrected source' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  const outcome = await runtime.start(agentId).outcome()
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'succeeded' })
  const taskOutcome = (runtime.state.agents.get(agentId)!.globalVersions.get(runtime.state.agents.get(agentId)!.latestGlobalVersion) as any).taskOutcome
  if (version === '29') {
    expect(plans).toBe(2)
    expect(inherited).toBe(true)
    expect(taskOutcome, JSON.stringify(taskOutcome)).toMatchObject({ status: 'accepted' })
  } else {
    expect(inherited).toBe(false)
    expect(taskOutcome.status).not.toBe('accepted')
  }
})

it('retains a settled confirmation as acceptance evidence even when a stage cites only its read', async () => {
  let agentId = '', turn = 0, humanRef = '', verifiedHuman = false
  const program = buildTaskControllerProgram({ version: '30', system: 'test', toolNames: ['read', 'ask.confirm'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 32 })
  const runtime = new PulseRuntime({ builtinHumanEffects: true, effectExecutor: async effect => {
    const agent = runtime.state.agents.get(agentId)!
    const state = (agent.globalVersions.get(agent.latestGlobalVersion) as any).taskController
    if (effect.kind === 'tool') return { value: { content: 'original retained receipt' } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'confirm', kind: 'analyze', goal: 'Read the receipt and ask for confirmation', check: 'Deliver the explicit human decision', criterionIds: ['c'], dependsOn: [] }] } }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: state.tasks[0].evidenceRefs.filter((ref: string) => runtime.state.results.get(ref)?.producer.kind === 'effect' && runtime.state.effects.get(runtime.state.results.get(ref)!.producer.id)?.kind === 'tool'), note: 'Receipt checked; decision collected.' } }
    if (effect.key?.startsWith('verify-task')) {
      const refs = (effect.input as any).inputs.results
      verifiedHuman = refs.includes(humanRef)
      return { value: { criteria: [{ criterionId: 'c', status: verifiedHuman ? 'passed' : 'unverifiable', evidenceRefs: verifiedHuman ? [humanRef] : [], rationale: 'Only the actual settled human reply proves confirmation.' }] } }
    }
    turn++
    return { value: turn === 1 ? { toolCalls: [{ name: 'read', input: {} }], finishReason: 'tool_calls' } : turn === 2 ? { toolCalls: [{ name: 'ask.confirm', input: { prompt: 'Continue after the retained write?', decisionId: 'one-write', decisionScope: 'original-receipt' } }], finishReason: 'tool_calls' } : { text: 'Explicit decision retained.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Read the receipt and collect explicit confirmation.', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'human-proof', objective: 'Read the receipt and collect explicit confirmation.', acceptanceCriteria: [{ id: 'c', description: 'Collect explicit confirmation.' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.waitForIdle()
  const human = [...runtime.state.effects.values()].find(effect => effect.kind === 'human' && !effect.outcome)!
  expect(human.input).toMatchObject({ toolName: 'ask.confirm', type: 'choice' })
  const session = runtime.start(agentId)
  await session.reply(human.id, { value: 'confirm' })
  humanRef = runtime.state.effects.get(human.id)!.outcome!.resultRef!
  await session.outcome()
  expect(verifiedHuman).toBe(true)
  const agent = runtime.state.agents.get(agentId)!
  expect((agent.globalVersions.get(agent.latestGlobalVersion) as any).taskOutcome.status).toBe('accepted')
})

it.each(['29', '30'] as const)('version %s handles incidental reads before a response-only delivery', async version => {
  let agentId = '', turns = 0
  const state = () => { const a = runtime.state.agents.get(agentId)!; return (a.globalVersions.get(a.latestGlobalVersion) as any).taskController }
  const program = buildTaskControllerProgram({ version, system: 'test', toolNames: ['read'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 24 })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') return { value: { content: 'already observed source' } }
    if (effect.key?.startsWith('plan')) return { value: { tasks: [{ id: 'response', kind: 'analyze', goal: 'Rewrite the response using the retained observation', check: 'Deliver corrected wording', criterionIds: ['c'], dependsOn: [] }] } }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: [state().tasks[0].candidateRef], note: 'Corrected response delivered.' } }
    if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: [state().tasks[0].candidateRef], rationale: 'The requested response is present.' }] } }
    turns++
    return { value: turns === 1 ? { toolCalls: [{ name: 'read', input: {} }], finishReason: 'tool_calls' } : { text: 'Corrected response.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Rewrite the response using the retained observation.', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'response-proof', objective: 'Rewrite the response using the retained observation.', acceptanceCriteria: [{ id: 'c', description: 'Deliver corrected wording.' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  const a = runtime.state.agents.get(agentId)!
  expect((a.globalVersions.get(a.latestGlobalVersion) as any).taskOutcome.status).toBe(version === '30' ? 'accepted' : 'incomplete')
})

it('supplies already-passed observation evidence to a new corrective delivery chain', async () => {
  let agentId = '', plans = 0, reviews = 0, inherited = false
  const turns = new Map<string, number>()
  const program = buildTaskControllerProgram({ version: '30', system: 'test', toolNames: ['read'], readOnlyToolNames: ['read'], approvalMode: 'auto', maxTurns: 48 })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    const lane = runtime.state.lanes.get(effect.ownerLaneId)!
    const a = runtime.state.agents.get(agentId)!
    const root = (a.globalVersions.get(a.latestGlobalVersion) as any).taskController
    const state = (lane.context.state as any).taskControllerChain ?? root
    if (effect.kind === 'tool') return { value: { content: 'actual original observation' } }
    if (effect.key?.startsWith('plan')) {
      plans++
      return { value: { tasks: plans === 1 ? [{ id: 'observed', kind: 'analyze', goal: 'Read the original observation', check: 'Report the observation', criterionIds: ['c1'], dependsOn: [] }, { id: 'independent', kind: 'analyze', goal: 'Read independent source', check: 'Report the source', criterionIds: ['c2'], dependsOn: [] }] : [{ id: 'wording', kind: 'analyze', goal: 'Correct the response wording', check: 'Use the original observation', criterionIds: ['c1'], dependsOn: [] }] } }
    }
    const task = state.tasks.find((t: any) => t.id === state.activeId)
    if (plans > 1 && (lane.context.state as any).taskControllerChain && (effect.input as any).inputs?.results) {
      const refs = root.tasks.filter((t: any) => t.status === 'passed').flatMap((t: any) => t.evidenceRefs)
      inherited ||= refs.some((ref: string) => (effect.input as any).inputs.results.includes(ref) && lane.visibleResultRefs?.has(ref))
    }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: plans > 1 ? [task.candidateRef] : task.evidenceRefs, note: 'Delivery verified.' } }
    if (effect.key?.startsWith('verify-task')) {
      reviews++
      return { value: { criteria: ['c1', 'c2'].map(id => ({ criterionId: id, status: id === 'c1' && reviews === 1 ? 'not_met' : 'passed', evidenceRefs: state.tasks.filter((t: any) => t.status === 'passed' && t.criterionIds.includes(id)).flatMap((t: any) => t.evidenceRefs), rationale: reviews === 1 ? 'The response wording needs correction; preserve the actual read.' : 'Corrected response and original source are supplied.' })) } }
    }
    const n = (turns.get(effect.ownerLaneId) ?? 0) + 1; turns.set(effect.ownerLaneId, n)
    return { value: plans === 1 && n === 1 ? { toolCalls: [{ name: 'read', input: {} }], finishReason: 'tool_calls' } : { text: 'Corrected response.', finishReason: 'stop' } }
  } })
  agentId = runtime.createAgent({ goal: 'Read two sources and report their observed fields.', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'passed-context', objective: 'Read two sources and report their observed fields.', acceptanceCriteria: [{ id: 'c1', description: 'Report the first observed field.' }, { id: 'c2', description: 'Report the second observed field.' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } }).agentId
  await runtime.start(agentId).outcome()
  expect(plans).toBe(2)
  expect(inherited).toBe(true)
  const a = runtime.state.agents.get(agentId)!
  expect((a.globalVersions.get(a.latestGlobalVersion) as any).taskOutcome.status).toBe('accepted')
})

it('keeps historical inspection nouns from forcing another file mutation in v31', () => {
  const goals = [
    '读回文件核验三项原始标准：创建路径、内容要素完整性、解释性内容标注为摘要',
    'Confirm the edit touched only migrations/002_add_updated_at.sql and left all other workspace files unchanged.',
  ]
  for (const goal of goals) {
    expect(stageRequiresFileChange(goal, 'Inspect existing output', 'edit', true, true, true)).toBe(true)
    expect(stageRequiresFileChange(goal, 'Inspect existing output', 'edit', true, true, true, true)).toBe(false)
  }
  for (const goal of ['Read input.json and create output.json', '检查 src/main.mjs 然后修改错误实现', 'Verify the change and then write report.md']) {
    expect(stageRequiresFileChange(goal, 'Deliver requested files', 'edit', true, true, true, true)).toBe(true)
  }
})
