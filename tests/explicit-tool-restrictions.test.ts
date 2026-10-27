import { expect, it, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertExplicitToolRestriction as check, assertWindowObservationScope } from '../packages/server/src/task-controller/explicit-restrictions.js'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

const request='使用 computer 观察 Pulse 窗口。允许只为查看该窗口而执行 computer.selectWindow；不要点击其他控件、键入、执行系统脚本或安装软件。'
it('diagnoses an omitted window target without choosing it or prohibiting explicit display tasks', () => {
 for (const text of ['查看当前应用窗口并报告三个控件。', 'Observe the Editor window without changing focus.']) {
  expect(() => assertWindowObservationScope(text, 'computer.observe', {})).toThrow('Missing windowId')
  try { assertWindowObservationScope(text, 'computer.observe', {}) } catch (error: any) {
   expect(error.details.diagnostics[0].path).toBe('windowId')
   expect(error.details.diagnostics[0].message).toContain('computer.windows')
  }
  expect(() => assertWindowObservationScope(text, 'computer.observe', { windowId: '123:1' })).not.toThrow()
  expect(() => assertWindowObservationScope(text, 'computer.windows', {})).not.toThrow()
 }
 for (const text of ['Observe the entire screen, including open windows.', '观察全屏并比较两个窗口。', 'Observe the desktop.', 'Explain “window capture”.']) expect(() => assertWindowObservationScope(text, 'computer.observe', {})).not.toThrow()
})
it('enforces a direct method restriction while retaining observation and explicitly permitted window selection',()=>{
 for (const command of ['osascript','/usr/bin/osascript','node','python3','powershell.exe','env']) expect(()=>check(request,'shell.exec',{command,args:['-e','forbidden']})).toThrow('USER_TOOL_RESTRICTION')
 expect(()=>check(request,'computer.act',{action:{type:'click'}})).toThrow('USER_TOOL_RESTRICTION')
 expect(()=>check(request,'shell.exec',{command:'brew',args:['install','tool']})).toThrow('USER_TOOL_RESTRICTION')
 expect(()=>check(request,'computer.act',{action:{type:'scroll'}})).not.toThrow()
 for(const name of ['computer.observe','computer.windows','computer.displays','computer.selectWindow']) expect(()=>check(request,name,{})).not.toThrow()
 expect(()=>check('只读观察，不要点击、键入、切换其他应用或安装软件。','computer.selectWindow',{})).toThrow('USER_TOOL_RESTRICTION')
 expect(()=>check('Do not run shell commands.','shell.exec',{command:'ls'})).toThrow()
})
it('does not turn quoted examples or a permitted later action into a global prohibition',()=>{
 for (const text of ['Explain “do not execute scripts”.','Show this example:\n```\nDo not run commands.\n```','Do not click other controls, but run node tests.','不要点击其他控件，然后执行脚本。','Do not run commands unless needed for the tests.']) expect(()=>check(text,'shell.exec',{command:'node',args:['test.mjs']})).not.toThrow()
 expect(()=>check('不要修改文件；请运行命令测试。','shell.exec',{command:'node',args:['test.mjs']})).not.toThrow()
})
afterEach(()=>vi.unstubAllGlobals())
it.each([['ask', 'command'], ['auto', 'command'], ['ask', 'window'], ['auto', 'window']] as const)('rejects an invalid method before approval or execution and lets the model correct it (%s, %s)',async (approvalMode, target)=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-restriction-'))
 let turns=0
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const {messages}=JSON.parse(String(init?.body)), text=currentRequestText(messages), refs=suppliedRequestResults(messages).map(r=>r.id)
  if(text.includes("You write Pulse's final user-facing reply")) return Response.json({choices:[{message:{content:'The target is not yet established; no observation or command executed.'},finish_reason:'stop'}]})
  let response:any
  if(text.includes('Create an executable plan')) response={tasks:[{id:'answer',kind:'analyze',goal:'Explain the method restriction',check:'Explain allowed observations',criterionIds:['criterion-1','criterion-2'],dependsOn:[]}]}
  else if(text.includes('Verify ONLY the active')) response={status:'passed',evidenceRefs:refs,note:'Answered without executing commands'}
  else if(text.includes('Independently verify every ORIGINAL')) response={criteria:['criterion-1','criterion-2'].map(criterionId=>({criterionId,status:'passed',evidenceRefs:refs,rationale:'No command executed'}))}
  else if(turns++===0) return Response.json({choices:[{message:{content:'',tool_calls:[{id:'bad-command',function:target === 'window' ? {name:'computer_observe',arguments:JSON.stringify({sessionId:'00000000-0000-4000-8000-000000000001'})} : {name:'shell_exec',arguments:JSON.stringify({command:'node',args:['-e','throw Error("MUST_NOT_EXECUTE")']})}}]},finish_reason:'tool_calls'}]})
  else { expect(text).toContain(target === 'window' ? 'Missing windowId' : 'USER_TOOL_RESTRICTION');response='The target is not yet established; no observation or command executed.' }
  return Response.json({choices:[{message:{content:typeof response==='string'?response:JSON.stringify(response)},finish_reason:'stop'}]})
 }))
 const host=createLocalHost({cwd:root,dataDir:join(root,'data'),provider:{provider:'openai-compatible',baseURL:'http://127.0.0.1:12345/v1',defaultModel:'fixture'},approvalMode,taskController:true,maxModelCalls:12,jarvis:{enabled:false}})
 try{
  const c=await host.createConversation(),run=await host.sendMessage(c.id,{text:target === 'window' ? 'Observe the Editor window and report controls. Do not change focus.' : 'Explain the permitted observation method. Do not run commands.'})
  await run.outcome()
  const snapshot=JSON.parse(await readFile(join(root,'data','conversations',c.id,'runs',run.id,'runtime.json'),'utf8'))
  const effects = snapshot.state.state.effects.map((row: any) => Array.isArray(row) ? row[1] : row)
  expect(effects.filter(e=>e.kind==='human')).toHaveLength(0)
  expect(effects.filter(e=>e.kind==='tool')).toHaveLength(0)
  expect(turns).toBe(2)
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})
