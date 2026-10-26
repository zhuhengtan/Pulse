import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import {createLocalHost} from '../packages/server/src/index.js'
it('still asks before starting project work while read tools need no card',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-chat-write-confirm-')),profile={provider:'mock' as const,defaultModel:'fixture'},start=vi.fn(async()=>{throw Error('must not execute')});const host=createLocalHost({cwd:root,dataDir:join(root,'data'),provider:profile,providerProfiles:{fixture:profile},providerModels:{fixture:{provider:'fixture',model:'fixture'}},activeModel:'fixture',assistantModel:'fixture',approvalMode:'ask',jarvis:{enabled:false},mockToolCalls:[{name:'work.start',input:{projectId:'p1',task:'Read fixture'}}]});host.setAssistantWorkTools({start,list:async()=>({projects:[{id:'p1',name:'Fixture'}]}),status:async()=>({}),send:async()=>{},stop:async()=>{},resume:async()=>{}})
 try{const c=await host.createConversation();const run=await host.sendMessage(c.id,{text:'请调用work.start在p1创建后台工作',assistantChat:true});let waiting=false;for await(const event of run.events){if(event.type==='waiting'){waiting=true;expect(JSON.stringify(event.data)).toContain('work.start');await run.cancel('fixture cleanup');break}}expect(waiting).toBe(true);expect(start).not.toHaveBeenCalled();expect((await run.outcome()).status).toBe('cancelled')}finally{await host.close();await rm(root,{recursive:true,force:true})}
})
