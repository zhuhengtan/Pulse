import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, type RunHandle } from '../packages/server/src/index.js'
import { H5Server } from '../packages/server/src/h5/server.js'
import { readConversationFixture, writeConversationFixture } from './conversation-fixtures.js'
const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse()) await close()})
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'pulse-recovery-http-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}))
 const host=createLocalHost({cwd:dir,dataDir:dir,taskController:false});cleanups.push(()=>host.close())
 const conversation=await host.createConversation({title:'Synthetic recovery UI test'}),runId='run-synthetic'
 const manifestPath=join(dir,'conversations',conversation.id,'manifest.json'),manifest=JSON.parse(await readConversationFixture(manifestPath,'utf8'));manifest.activeRunId=runId;await writeConversationFixture(manifestPath,JSON.stringify(manifest))
 const preflight={conversationId:conversation.id,runId,status:'confirmation-required' as const,from:'a'.repeat(64),to:'b'.repeat(64),blockers:[],toolCheck:'on-resume' as const}
 const check=vi.spyOn(host,'preflightRunRecovery').mockResolvedValue(preflight)
 const resume=vi.spyOn(host,'resumeRun').mockImplementation(async()=>({id:runId,conversationId:conversation.id,events:(async function*(){yield {schemaVersion:1,type:'complete',conversationId:conversation.id,runId,seq:1,data:{status:'succeeded'}}})(),cancel:async()=>{},interrupt:async()=>{},outcome:async()=>({status:'succeeded'}),taskOutcome:async()=>undefined} as RunHandle))
 const server=new H5Server(host,{dataDir:dir,port:0,host:'127.0.0.1'});cleanups.push(()=>server.stop());const info=await server.start(),base=`http://127.0.0.1:${info.port}`
 const paired=await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:server.createPairingCode().code,name:'Synthetic test client'})}),cookie=paired.headers.get('set-cookie')??''
 const url=`${base}/api/conversations/${conversation.id}/runs/${runId}`
 return {preflight,check,resume,request:(suffix:string,body?:unknown)=>fetch(url+suffix,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})}
}
it('HTTP preflight is read-only and POST forwards only a current explicit build confirmation',async()=>{
 const f=await fixture();const read=await f.request('/recovery');expect(read.status).toBe(200);expect(await read.json()).toEqual(f.preflight);expect(f.resume).not.toHaveBeenCalled()
 expect((await f.request('/resume',{})).status).toBe(409);expect(f.resume).not.toHaveBeenCalled()
 const recovery={runId:f.preflight.runId,from:f.preflight.from,to:f.preflight.to,confirmed:true}
 const stale=await f.request('/resume',{recovery:{...recovery,to:'old'}});expect(stale.status).toBe(409);expect((await stale.json()).error).toBe('RECOVERY_CONFIRMATION_STALE');expect(f.resume).not.toHaveBeenCalled()
 expect((await f.request('/resume',{recovery})).status).toBe(200)
 expect(f.resume).toHaveBeenCalledWith(f.preflight.conversationId,{runId:recovery.runId,from:recovery.from,to:recovery.to})
})
it('POST refreshes blockers and returns structured compatibility errors without granting a retry',async()=>{
 const f=await fixture();await f.request('/recovery');f.check.mockResolvedValue({...f.preflight,status:'blocked',blockers:['RECOVERY_POLICY_INCOMPATIBLE']})
 const recovery={runId:f.preflight.runId,from:f.preflight.from,to:f.preflight.to,confirmed:true}
 const blocked=await f.request('/resume',{recovery});expect(blocked.status).toBe(409);expect((await blocked.json()).error).toBe('RECOVERY_POLICY_INCOMPATIBLE');expect(f.resume).not.toHaveBeenCalled()
 f.check.mockResolvedValue(f.preflight);f.resume.mockRejectedValue(new Error('TOOL_SCHEMA_INCOMPATIBLE:synthetic-tool'))
 const incompatible=await f.request('/resume',{recovery});expect(incompatible.status).toBe(409);expect(await incompatible.json()).toEqual({error:'TOOL_SCHEMA_INCOMPATIBLE',reasons:['TOOL_SCHEMA_INCOMPATIBLE:synthetic-tool']})
})
