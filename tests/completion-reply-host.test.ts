import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(()=>vi.unstubAllGlobals())
const message=(content:any)=>Response.json({choices:[{message:typeof content==='string'?{content}:content,finish_reason:content.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})
async function fixture(mode:'success'|'failure'|'incomplete'|'cancelled'|'tools'='success', maxModelCalls=32) {
  const root=await mkdtemp(join(tmpdir(),'pulse-final-reply-host-')),request='1. 起草项目介绍\n2. 起草配置说明',ids=acceptanceCriteriaFromObjective(request).map(c=>c.id)
  let summaries=0,work=0,calls=0
  const primaryTexts=['项目用途：保留用户任务。','配置建议：使用独立数据目录。']
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    if(!String(input).startsWith('http://127.0.0.1:12345/'))return nativeFetch(input,init)
    calls++
    const body=JSON.parse(String(init?.body)),text=currentRequestText(body.messages),refs=suppliedRequestResults(body.messages).map(r=>r.id)
    if(text.includes("You write Pulse's final user-facing reply")) {
      summaries++;expect(body.tools??[]).toEqual([]);expect(text).toContain('settled status');expect(text).not.toContain('stage-hidden-1')
      if(mode==='failure')return Response.json({error:{message:'temporarily unavailable'}},{status:503})
      if(mode==='tools')return message({content:'',tool_calls:[{id:'unexpected-write',function:{name:'fs_write',arguments:JSON.stringify({path:'must-not-exist.txt',content:'unauthorized'})}}]})
      return message(mode==='incomplete'?'用途分析已完成，配置验证仍受阻，不能确认全部完成。':primaryTexts.join('\n'))
    }
    if(text.includes('Create an executable plan')&&text.includes('\"recoveryCriterionIds\":[\"criterion-2\"]'))return message(JSON.stringify({tasks:[{id:'stage-hidden-2',kind:'analyze',goal:'起草配置说明',check:'回复包含配置建议',criterionIds:[ids.at(-1)],dependsOn:[]}]}))
    if(text.includes('Create an executable plan'))return message(JSON.stringify({tasks:[{id:'stage-hidden-1',kind:'analyze',goal:'起草项目介绍',check:'回复包含项目用途说明',criterionIds:[ids[0]],dependsOn:[]},{id:'stage-hidden-2',kind:'analyze',goal:'起草配置说明',check:'回复包含配置建议',criterionIds:[ids.at(-1)],dependsOn:['stage-hidden-1']}]}))
    if(text.includes('Verify ONLY the active'))return message(JSON.stringify({status:mode==='incomplete'&&work>=2?'blocked':'passed',evidenceRefs:refs.slice(-1),note:mode==='incomplete'?'配置验证受环境限制':'已核对原始回答'}))
    if(text.includes('Independently verify every ORIGINAL'))return message(JSON.stringify({criteria:ids.map(criterionId=>({criterionId,status:mode==='incomplete'?'unverifiable':'passed',evidenceRefs:refs,rationale:mode==='incomplete'?'配置验证受环境限制':'实际回答已提供'}))}))
    if(mode==='cancelled')return message({content:'',tool_calls:[{id:'ask',function:{name:'ask_input',arguments:JSON.stringify({prompt:'请选择配置'})}}]})
    work++
    return message(primaryTexts.join('\n'))
  }))
  const host=createLocalHost({cwd:root,dataDir:join(root,'data'),provider:{provider:'openai-compatible',baseURL:'http://127.0.0.1:12345/v1',defaultModel:'fixture'},taskController:true,approvalMode:'ask',jarvis:{enabled:false},maxModelCalls})
  const c=await host.createConversation(),run=await host.sendMessage(c.id,{text:request})
  return{host,root,c,run,count:()=>({summaries,calls}),directory:join(root,'data','conversations',c.id,'runs',run.id),close:async()=>{await host.close();await rm(root,{recursive:true,force:true})}}
}
const nativeFetch=globalThis.fetch
it('publishes one natural reply to the event stream, saved history and outcome while retaining the audit',async()=>{
  const f=await fixture()
  try {
    const events=[];for await(const e of f.run.events)events.push(e)
    const [outcome,again]=await Promise.all([f.run.outcome(),f.run.outcome()])
    expect(outcome.text).toBe('项目用途：保留用户任务。\n配置建议：使用独立数据目录。');expect(again).toEqual(outcome)
    expect(events.filter(e=>e.type==='text').map(e=>e.data)).toEqual([outcome.text])
    const history=await f.host.getConversationMessages(f.c.id)
    expect(history.filter(m=>m.role==='assistant')).toHaveLength(1);expect(history.at(-1)?.text).toBe(outcome.text)
    expect((await f.run.taskOutcome())?.status).toBe('accepted');expect(f.count().summaries).toBe(1)
    const audit=JSON.parse(await readFile(join(f.directory,'completion-report.json'),'utf8'))
    expect(audit.text).toContain('stage-hidden-1');expect(audit.taskOutcome.status).toBe('accepted')
    const ledger=JSON.parse(await readFile(join(f.directory,'model-budget.json'),'utf8'))
    expect(ledger.purposes['completion-summary']).toBe(1);expect((await f.run.usage()).modelCalls).toBe(f.count().calls)
    expect(JSON.parse(await readFile(join(f.directory,'outcome.json'),'utf8')).text).toBe(outcome.text)
    const server=new H5Server(f.host,{host:'127.0.0.1',port:0,dataDir:join(f.root,'data')})
    try {
      const base=`http://127.0.0.1:${(await server.start()).port}`
      const paired=await nativeFetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
      const view=await nativeFetch(`${base}/api/conversations/${f.c.id}/messages`,{headers:{Cookie:paired.headers.get('set-cookie')!,Origin:base}}).then(r=>r.json())
      expect(view).toEqual(expect.arrayContaining([expect.objectContaining({ text: outcome.text })]))
    }finally{await server.stop()}
  }finally{await f.close()}
})
it('makes only one provider attempt on a failed summary and preserves original prose in the fallback',async()=>{
  const f=await fixture('failure')
  try {
    const outcome=await f.run.outcome()
    expect(f.count().summaries).toBe(1);expect(outcome.text).toContain('项目用途：保留用户任务。');expect(outcome.text).toContain('配置建议：使用独立数据目录。')
    expect(outcome.text).not.toMatch(/stage-hidden|criterion-|逐项验收/);expect((await f.run.taskOutcome())?.status).toBe('accepted')
  }finally{await f.close()}
})
it('preserves an incomplete verdict and its concrete blocker',async()=>{
  const f=await fixture('incomplete')
  try {
    const outcome=await f.run.outcome();expect(outcome.text).toContain('配置验证受环境限制')
    expect(outcome.text).not.toMatch(/stage-hidden|criterion-|逐项验收/);expect((await f.run.taskOutcome())?.status).not.toBe('accepted')
    expect(JSON.parse(await readFile(join(f.directory,'completion-report.json'),'utf8')).text).toContain('stage-hidden')
  }finally{await f.close()}
})
it('does not start the optional presentation model after cancellation',async()=>{
  const f=await fixture('cancelled')
  try {
    for await(const event of f.run.events)if(event.type==='waiting'){await f.run.cancel('USER_REQUESTED');break}
    const outcome=await f.run.outcome();expect(outcome.status).toBe('cancelled');expect(f.count().summaries).toBe(0)
    expect(outcome.text).toContain('取消');expect(outcome.text).not.toMatch(/stage-hidden|criterion-/)
  }finally{await f.close()}
})
it('uses the final-verification result when there is no remaining model budget',async()=>{
  const f=await fixture('success',4)
  try {
    const outcome=await f.run.outcome()
    expect((await f.run.taskOutcome())?.status).toBe('accepted')
    expect(f.count()).toEqual({summaries:0,calls:4})
    expect(outcome.text).toContain('项目用途：保留用户任务。');expect(outcome.text).not.toContain('stage-hidden')
    expect((await f.run.usage()).modelCalls).toBe(4)
    expect(JSON.parse(await readFile(join(f.directory,'completion-reply.json'),'utf8')).source).toBe('fallback')
  }finally{await f.close()}
})
it('never executes a tool requested by the optional presentation model',async()=>{
  const f=await fixture('tools')
  try {
    const outcome=await f.run.outcome()
    expect(f.count().summaries).toBe(1);expect((await f.run.taskOutcome())?.status).toBe('accepted')
    await expect(readFile(join(f.root,'must-not-exist.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'})
    expect(outcome.text).toContain('项目用途：保留用户任务。')
  }finally{await f.close()}
})
