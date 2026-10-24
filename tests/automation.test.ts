import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationSessionManager } from '../packages/server/src/automation/manager.js'
import { AutomationBroker, RemoteAutomationClient } from '../packages/server/src/automation/broker.js'
import type { AutomationBackend } from '../packages/server/src/automation/types.js'
import { createHostModelRouting } from '../packages/server/src/model-routing.js'
import { lowerProjectionToCanonical, toOpenAIPayload, toAnthropicPayload, resolveModelCapability } from '../packages/adapters/src/providers/canonical/index.js'
import { createModelEffectExecutor } from '@hunterzhu/pulse-adapters'
import { createRuntimeState, createAgent, publishArtifact, ContextBuilder, type LLMRequestProjection } from '@hunterzhu/pulse-runtime'

const roots: string[] = [], managers: AutomationSessionManager[] = [], brokers: AutomationBroker[] = []
// Fake backends must not acquire the user's real desktop session lock.
// Managers in the same test still compete for the same isolated resource.
beforeEach(() => vi.stubEnv('XDG_SESSION_ID', `test-${randomUUID()}`))
afterEach(() => vi.unstubAllEnvs())
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
function backend(): AutomationBackend { return { call: vi.fn(async()=>({ok:true})), observe: vi.fn(async()=>({width:100,height:100,geometry:'display-a',image:{mediaType:'image/png' as const,data:image}})), act: vi.fn(async()=>undefined),release:vi.fn(async()=>undefined),close:vi.fn(async()=>undefined) } }
async function setup() { const root=await mkdtemp(join(tmpdir(),'pulse-automation-test-'));roots.push(root);const driver=backend();const manager=new AutomationSessionManager(root,{},true,()=>driver);managers.push(manager);return {root,driver,manager} }
afterEach(async()=>{for(const b of brokers.splice(0))await b.close();for(const m of managers.splice(0))await m.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
describe('automation control and recovery boundaries',()=>{
 it('rejects queued observations after close instead of reopening the browser',async()=>{
  const {root,manager,driver}=await setup(),session=await manager.open('browser','owner',root,'dedicated')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const observation = {width:100,height:100,geometry:'display-a',image:{mediaType:'image/png' as const,data:image}}
  vi.mocked(driver.observe).mockImplementationOnce(async()=>{await gate;return observation})
  const first=manager.observe(session.id,'owner')
  await Promise.resolve()
  const closing=manager.control(session.id,'close','local')
  await Promise.resolve();await Promise.resolve()
  const late=manager.observe(session.id,'owner')
  const rejection=expect(late).rejects.toThrow('AUTOMATION_SESSION_NOT_FOUND')
  release();await first;await closing;await rejection
  expect(driver.observe).toHaveBeenCalledOnce()
  expect(driver.close).toHaveBeenCalledOnce()
  expect(manager.list()[0]?.state).toBe('closed')
  expect((await manager.open('browser','next-owner',root,'dedicated')).state).toBe('ai')
 })
 it('isolates task owners and rejects stale frames while deduplicating applied input',async()=>{
  const {root,driver,manager}=await setup(),session=await manager.open('browser','run-a:agent-1',root,'dedicated')
  await expect(manager.observe(session.id,'run-b:agent-1')).rejects.toThrow('NOT_OWNED')
  const observation=await manager.observe(session.id,'run-a:agent-1')
  const action={type:'click',point:{x:.5,y:.5},button:'left',count:1}
  await manager.act(session.id,String(observation.frameId),action,'request-1','run-a:agent-1')
  await manager.act(session.id,String(observation.frameId),action,'request-1','run-a:agent-1')
  expect(driver.act).toHaveBeenCalledTimes(1)
  await expect(manager.act(session.id,String(observation.frameId),action,'request-2','run-a:agent-1')).rejects.toThrow('STALE')
 })
 it('requires a human lease and prevents AI input during takeover',async()=>{
  const {root,manager}=await setup(),session=await manager.open('browser','run-a',root,'dedicated')
  const control=await manager.control(session.id,'takeover','phone')
  const observation=await manager.observe(session.id)
  const action={type:'type',text:'你好'}
  await expect(manager.act(session.id,String(observation.frameId),action,'ai','run-a')).rejects.toThrow('CONTROL_REQUIRED')
  await expect(manager.act(session.id,String(observation.frameId),action,'bad',undefined,'wrong')).rejects.toThrow('CONTROL_REQUIRED')
  await manager.act(session.id,String(observation.frameId),action,'human',undefined,String(control.lease))
  await manager.control(session.id,'resume','phone')
  expect(manager.list()[0]?.frameId).toBeUndefined()
 })
 it('records an uncertain operation before execution and never replays it',async()=>{
  const {root,manager,driver}=await setup();vi.mocked(driver.act).mockRejectedValueOnce(new Error('connection lost'))
  const session=await manager.open('browser','owner',root,'dedicated'),observation=await manager.observe(session.id,'owner')
  const action={type:'key',keys:['Enter']}
  await expect(manager.act(session.id,String(observation.frameId),action,'submit','owner')).rejects.toThrow('connection lost')
  expect(manager.list()[0]?.state).toBe('unknown')
  expect(await manager.act(session.id,String(observation.frameId),action,'submit','owner')).toMatchObject({status:'unknown'})
  expect(driver.act).toHaveBeenCalledTimes(1)
 })
 it('serializes a browser profile across independently constructed managers',async()=>{
  const {root,manager}=await setup();await manager.open('browser','owner',root,'dedicated')
  const other=new AutomationSessionManager(root,{},true,()=>backend());managers.push(other)
  await expect(other.open('browser','other',root,'dedicated')).rejects.toThrow('RESOURCE_BUSY')
 })
 it('serves worker operations through an authenticated local broker',async()=>{
  const {root,manager}=await setup(),broker=new AutomationBroker(manager,root);brokers.push(broker)
  const endpoint=await broker.start(),client=new RemoteAutomationClient(endpoint)
  const session=await client.request('open',['browser','worker:agent-1',root,'dedicated'])
  expect((await client.request('observe',[session.id,'worker:agent-1'])).pulseImage.data).toBe(image)
  await expect(new RemoteAutomationClient({...endpoint,token:'wrong'}).request('list',[])).rejects.toThrow('UNAUTHORIZED')
 })
 it('persists uncertain receipts across a supervisor restart and requires explicit reconnection',async()=>{
  const {root,manager,driver}=await setup();vi.mocked(driver.act).mockRejectedValueOnce(new Error('lost ack'))
  const session=await manager.open('browser','owner',root,'dedicated'),observation=await manager.observe(session.id,'owner')
  await expect(manager.act(session.id,String(observation.frameId),{type:'key',keys:['Enter']},'persisted','owner')).rejects.toThrow('lost ack')
  await manager.suspend()
  const restored=new AutomationSessionManager(root,{},true,()=>backend());managers.push(restored);await restored.init()
  await expect(restored.observe(session.id,'owner')).rejects.toThrow('RECONNECT_REQUIRED')
  expect(await restored.act(session.id,String(observation.frameId),{type:'key',keys:['Enter']},'persisted','owner')).toMatchObject({status:'unknown'})
  await restored.control(session.id,'resume','local')
  expect(await restored.observe(session.id,'owner')).toHaveProperty('frameId')
 })
 it('does not let a second device steal a live manual lease',async()=>{
  const {root,manager}=await setup(),session=await manager.open('browser','owner',root,'dedicated')
  await manager.control(session.id,'takeover','device-a')
  await expect(manager.control(session.id,'takeover','device-b')).rejects.toThrow('CONTROL_BUSY')
 })
 it('waits without sending input during takeover and cancels a disconnected worker wait',async()=>{
  const {root,manager}=await setup(),session=await manager.open('browser','worker',root,'dedicated')
  await manager.control(session.id,'takeover','local')
  let returned=false
  const waiting=manager.wait(session.id,'worker').then(()=>{returned=true})
  await new Promise(resolve=>setTimeout(resolve,20))
  expect(returned).toBe(false)
  await manager.control(session.id,'resume','local');await waiting
  await manager.control(session.id,'pause','local')
  const controller=new AbortController(),cancelled=manager.wait(session.id,'worker',controller.signal)
  controller.abort();await expect(cancelled).rejects.toThrow('CANCELLED')
 })
 it('pauses other sessions globally while a person owns input',async()=>{
  const {root,manager}=await setup(),first=await manager.open('browser','one',root,'dedicated')
  const otherRoot=join(root,'second');const second=await manager.open('browser','two',otherRoot,'dedicated')
  await manager.control(first.id,'takeover','local')
  expect(manager.list().find(session=>session.id===second.id)?.state).toBe('paused')
  await expect(manager.control(second.id,'resume','other')).rejects.toThrow('CONTROL_BUSY')
 })
 it('arbitrates simultaneous human takeover requests across different sessions',async()=>{
  const {root,manager}=await setup(),first=await manager.open('browser','one',root,'dedicated'),second=await manager.open('browser','two',join(root,'other'),'dedicated')
  const results=await Promise.allSettled([manager.control(first.id,'takeover','device-a'),manager.control(second.id,'takeover','device-b')])
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
  expect(manager.list().filter(session=>session.state==='human')).toHaveLength(1)
 })
 it('cancels the geometry recheck before input when a session is paused',async()=>{
  const {root,manager,driver}=await setup(),session=await manager.open('computer','owner',root)
  const frame=await manager.observe(session.id,'owner')
  let started!:()=>void
  const ready=new Promise<void>(resolve=>{started=resolve})
  vi.mocked(driver.observe).mockImplementationOnce(signal=>new Promise((_resolve,reject)=>{started();signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})}))
  const acting=manager.act(session.id,String(frame.frameId),{type:'key',keys:['Enter']},'cancel','owner')
  const rejected=expect(acting).rejects.toThrow('cancelled')
  await ready;await manager.control(session.id,'pause','local');await rejected
  expect(driver.act).not.toHaveBeenCalled()
  expect(manager.list()[0]?.state).toBe('paused')
 })
})
describe('image model transport',()=>{
 const projection:LLMRequestProjection={contextSpec:{globalSnapshotVersion:0,laneSnapshotVersion:0,resultRefs:[],eventIds:[],toolSetId:'t',instruction:'observe',privacy:'public',privacyRefs:[]},blocks:[{kind:'instruction',content:'observe'}],images:[{ref:'screenshot-1',mediaType:'image/png',data:image}],prefixHash:'p',projectionHash:'q',builderVersion:'2',policyVersion:'1',toolSetVersion:'1',privacy:'public',privacyRefs:[]}
 it('maps screenshot bytes to native OpenAI and Anthropic image parts',()=>{
  const {canonical}=lowerProjectionToCanonical({request:projection,model:'vision'})
  const openai=toOpenAIPayload(canonical,resolveModelCapability('vision','openai')) as any
  expect(openai.messages.at(-1).content.at(-1)).toEqual({type:'image_url',image_url:{url:`data:image/png;base64,${image}`}})
  const anthropic=toAnthropicPayload(canonical,resolveModelCapability('vision','anthropic')) as any
  expect(anthropic.messages.at(-1).content.at(-1)).toEqual({type:'image',source:{type:'base64',media_type:'image/png',data:image}})
 })
 it('selects the configured provider/model vision route and excludes text-only models',()=>{
  const routing=createHostModelRouting({activeModel:'a/text',activeProvider:{provider:'openai',defaultModel:'text'},activeProviderCode:'a',providerModels:{'a/text':{provider:'a',model:'text',imageInput:'unsupported'},'a/vision':{provider:'a',model:'vision',imageInput:'supported'}},taskRouting:{vision:['a/vision']}})
  expect(routing.router.routeProjection('vision',projection,{imageInput:true}).map(item=>item.id)).toEqual(['a/vision'])
 })
 it('resolves visible image artifacts outside the 4 KiB text summary and preserves privacy',()=>{
  const state=createRuntimeState(),{root}=createAgent(state,'image task',{programId:'image',programVersion:'1',step:'start',locals:{}})
  const artifact=publishArtifact(state,{mediaType:'image/png',content:Buffer.from(image,'base64'),laneId:root.id,privacy:'local_only'})
  state.results.set('shot',{id:'shot',value:{artifactRef:artifact.ref,frameId:'frame'},privacy:'local_only',derivedFrom:[]})
  root.visibleResultRefs!.add('shot')
  const projection=new ContextBuilder(state).build({agent:state.agents.get(root.agentId)!,lane:root,resultRefs:['shot'],instruction:'inspect screenshot',toolSetId:'test'})
  expect(projection.images).toEqual([{ref:artifact.ref,mediaType:'image/png'}])
  expect(JSON.stringify(projection)).not.toContain(image)
  expect(JSON.stringify(projection.blocks)).not.toContain(image)
  expect(projection.privacy).toBe('local_only')
  const {root:other}=createAgent(state,'different task',{programId:'image',programVersion:'1',step:'start',locals:{}})
  other.visibleResultRefs!.add('shot')
  expect(()=>new ContextBuilder(state).build({agent:state.agents.get(other.agentId)!,lane:other,resultRefs:['shot'],instruction:'inspect',toolSetId:'test'})).toThrow('ARTIFACT_NOT_VISIBLE')
 })
 it('hydrates artifact bytes only at the selected vision provider boundary',async()=>{
  const request={...projection,images:[{ref:'screenshot-1',mediaType:'image/png' as const}],contextSpec:{...projection.contextSpec,artifactRefs:['screenshot-1']}}
  const routing=createHostModelRouting({activeModel:'local/text',activeProviderCode:'local',activeProvider:{provider:'mock',defaultModel:'text'},providerModels:{'local/text':{provider:'local',model:'text'},'local/vision':{provider:'local',model:'vision',imageInput:'supported'}},taskRouting:{vision:['local/vision']}})
  const executeAttempt=vi.fn(async()=>({text:'seen',toolCalls:[],finishReason:'stop' as const}))
  routing.providers.set('local',{id:'local',name:'test',executeAttempt})
  const resolveImage=vi.fn(()=>image),executor=createModelEffectExecutor({...routing,resolveImage})
  await executor({id:'vision-effect',kind:'llm',agentId:'agent-test',ownerLaneId:'lane-test',attemptId:'attempt-test',attemptNo:1,input:{task:'reason',request}} as any,new AbortController().signal)
  expect(resolveImage).toHaveBeenCalledWith('screenshot-1','agent-test','public')
  expect(executeAttempt).toHaveBeenCalledWith(expect.objectContaining({model:'local/vision',request:expect.objectContaining({images:[{ref:'screenshot-1',mediaType:'image/png',data:image}]})}))
  expect(JSON.stringify(request)).not.toContain(image)
 })
})

describe('conversation browser lifetime', () => {
 it('retains a browser after a run, rebinds only its conversation, and closes desktop sessions', async () => {
  const {root,manager,driver}=await setup()
  const first=await manager.open('browser','run-a:agent',root,'dedicated',{conversationId:'conversation-a'})
  await manager.observe(first.id,'run-a:agent'); await manager.releaseOwner('run-a:agent')
  expect(driver.close).not.toHaveBeenCalled()
  expect(manager.list()[0]).toMatchObject({state:'paused',owner:'conversation:conversation-a',conversationId:'conversation-a'})
  await expect(manager.observe(first.id,'run-a:agent')).rejects.toThrow('NOT_OWNED')
  const next=await manager.open('browser','run-b:agent',root,'dedicated',{conversationId:'conversation-a'})
  expect(next.id).toBe(first.id); expect(next.state).toBe('ai'); expect(next.frameId).toBeUndefined()
  const other=await manager.open('browser','other:agent',root,'dedicated',{conversationId:'conversation-b'})
  expect(other.id).not.toBe(first.id)
  await expect(manager.observe(first.id,'other:agent')).rejects.toThrow('NOT_OWNED')
  const desktop=await manager.open('computer','desktop-owner',root)
  await manager.releaseOwner('desktop-owner')
  expect(manager.list().find(item=>item.id===desktop.id)?.state).toBe('closed')
 })
 it('keeps the human lease across run completion and blocks concurrent task ownership', async () => {
  const {root,manager}=await setup()
  const session=await manager.open('browser','run:agent',root,'dedicated',{conversationId:'conversation'})
  await expect(manager.open('browser','other:agent',root,'dedicated',{conversationId:'conversation'})).rejects.toThrow('RESOURCE_BUSY')
  const control=await manager.control(session.id,'takeover','device')
  await manager.releaseOwner('run:agent')
  const rebound=await manager.open('browser','next:agent',root,'dedicated',{conversationId:'conversation'})
  expect(rebound.state).toBe('human');manager.heartbeat(session.id,'device',String(control.lease))
  await manager.control(session.id,'resume','device')
  expect((await manager.observe(session.id,'next:agent')).frameId).toBeTruthy()
 })
})

it('keeps window scope and coordinate evidence attached to the exact observed frame',async()=>{
 const {root,manager,driver}=await setup(),session=await manager.open('computer','scope-owner',root)
 vi.mocked(driver.observe).mockResolvedValue({width:400,height:300,geometry:'window-rect',title:'Pulse',captureScope:'window',targetWindowId:'100:1',captureBounds:{x:-500,y:200,width:400,height:300},accessibilityTruncated:true,text:'AXWindow Pulse',image:{mediaType:'image/png',data:image}})
 const observation=await manager.observe(session.id,'scope-owner',undefined,true,'100:1')
 expect(observation).toMatchObject({title:'Pulse',captureScope:'window',targetWindowId:'100:1',captureBounds:{x:-500,y:200,width:400,height:300},accessibilityTruncated:true})
 expect(observation.pulseImage).toBeDefined()
 expect(driver.observe).toHaveBeenCalledWith(expect.any(AbortSignal),'100:1')
 expect(driver.call).not.toHaveBeenCalledWith('selectWindow',expect.anything(),expect.anything())
})
