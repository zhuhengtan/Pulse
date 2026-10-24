import { expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, defineTool, createToolInputValidator } from '@hunterzhu/pulse-tool-sdk'
import { capabilityStatusTool } from '../packages/server/src/capability-status.js'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'

it.each(['disabled', 'unregistered', 'connected', 'disconnected', 'unknown'])('reports readiness without opening anything: %s', async mode => {
  const registry = new ToolRegistry()
  if (!['disabled', 'unregistered'].includes(mode)) registry.register(defineTool({ name: 'browser.observe', description: 'observe', input: z.object({}), output: z.unknown(), execute: async () => ({}) }))
  const requests: string[] = []
  registry.register(capabilityStatusTool(registry, mode === 'disabled' ? [] : ['browser'], { request: async method => { requests.push(method); if (mode === 'unknown') throw Error('old broker'); return { nativeBrowserConnected: mode === 'connected' } } }))
  const result = await registry.execute('capability.status', {}, new AbortController().signal) as any
  expect(result.capabilities[0]).toMatchObject({ connection: ({ disabled: 'unavailable', unregistered: 'unavailable', connected: 'connected', disconnected: 'disconnected', unknown: 'unverified' } as any)[mode] })
  expect(requests).toEqual(['disabled', 'unregistered'].includes(mode) ? [] : ['capabilities'])
})

it('preflight respects the pure step boundary even with workspace permission policy', async () => {
  const registry = new ToolRegistry({ workspaceRoots: ['/tmp'] })
  registry.register(defineTool({ name: 'read', description: 'read', input: z.object({ path: z.string() }), output: z.unknown(), permissions: { workspaceRoots: ['/tmp'] }, execute: async () => ({}) }))
  const validateToolInput = createToolInputValidator(registry)
  let count = 0
  const program = defineLaneProgram({ id: 'pure-preflight', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'read', validateToolInput, toolAllow: ['read'], onFinish: () => ({ complete: {} }) }))
  const runtime = new PulseRuntime({ effectExecutor: async effect => effect.kind === 'tool' ? { value: {} } : { value: ++count === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'read', input: { path: 'a' } }] } : { text: 'done' } } })
  const { agentId } = runtime.createAgent('read', program)
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(count).toBe(2)
})

it('preflights unsupported browser images and reports desktop vision blockers before opening a session', async () => {
 const {createAutomationTools}=await import('../packages/server/src/automation/tools.js')
 const requests:string[]=[], client={request:async(method:string)=>{requests.push(method);return{nativeBrowserConnected:true}}}
 const registry=new ToolRegistry()
 for(const tool of createAutomationTools(client,'/tmp',['browser','computer'],'run',undefined,undefined,false))registry.register(tool)
 registry.register(capabilityStatusTool(registry,['browser','computer'],client,false))
 const validate=createToolInputValidator(registry)
 expect(()=>validate('browser.observe',{sessionId:'12345678-1234-4123-8123-123456789abc',includeImage:true})).toThrow(/manifest/)
 expect(validate('browser.observe',{sessionId:'12345678-1234-4123-8123-123456789abc',includeImage:false})).toBeUndefined()
 const status=await registry.execute('capability.status',{},new AbortController().signal) as any
 expect(status.capabilities.find((c:any)=>c.id==='computer')).toMatchObject({enabled:true,registered:true,visionAvailable:false,reason:'VISION_MODEL_REQUIRED'})
 await expect(registry.execute('automation.open',{kind:'computer'},new AbortController().signal)).rejects.toMatchObject({code:'VISION_MODEL_REQUIRED'})
 expect(requests).toEqual(['capabilities'])
})

it('stops a capability-blocked stage before another model can invent a desktop workaround',async()=>{
 let models=0, tools=0
 const program=defineLaneProgram({id:'capability-blocker',version:'1'},b=>b.addReActLoopStep('work',{
  instruction:'Observe desktop',toolAllow:['automation.open','shell.exec'],terminalToolErrorCodes:['VISION_MODEL_REQUIRED'],
  onFinish:()=>({complete:{}}),
 }))
 const runtime=new PulseRuntime({effectExecutor:async effect=>{
  if(effect.kind==='tool'){tools++;throw Object.assign(new Error('No configured vision route'),{code:'VISION_MODEL_REQUIRED',retryable:false})}
  models++;return {value:{finishReason:'tool_calls',toolCalls:[{name:models===1?'automation.open':'shell.exec',input:models===1?{kind:'computer'}:{command:'osascript'}}]}}
 }})
 const {agentId}=runtime.createAgent('Observe desktop',program)
 expect(await runtime.start(agentId).outcome()).toMatchObject({status:'failed',error:{code:'VISION_MODEL_REQUIRED'}})
 expect(models).toBe(1);expect(tools).toBe(1)
})

it('routes a read-only desktop window observation without a focus command',async()=>{
 const {createAutomationTools}=await import('../packages/server/src/automation/tools.js')
 const calls:any[]=[],client={request:async(method:string,args:any[])=>{calls.push([method,args]);return{title:'Pulse',captureScope:'window',targetWindowId:'123:1'}}}
 const registry=new ToolRegistry()
 for(const tool of createAutomationTools(client,'/tmp',['computer'],'run',undefined,undefined,true))registry.register(tool)
 const id='12345678-1234-4123-8123-123456789abc'
 const result=await registry.execute('computer.observe',{sessionId:id,windowId:'123:1'},new AbortController().signal)
 expect(result).toMatchObject({title:'Pulse',captureScope:'window'})
 expect(calls).toEqual([['observe',[id,expect.stringMatching(/^run:/),null,true,'123:1']]])
})
