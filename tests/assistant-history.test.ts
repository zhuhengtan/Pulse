import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it} from 'vitest'
import {ConversationData} from '../packages/data/src/index.js'
import {ToolRegistry} from '@hunterzhu/pulse-tool-sdk'
import {registerAssistantHistoryTools} from '../packages/server/src/assistant-history.js'
import {assistantReferenceNotice,conversationWithReference} from '../packages/server/src/assistant-chat-context.js'
import {assistantAutoApprovedTools} from '../packages/server/src/index.js'
import {AssistantConversationStore} from '../packages/server/src/h5/assistant.js'
async function fixture(fn:(data:ConversationData,call:(name:string,input:any)=>Promise<any>)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'pulse-chat-history-'));const data=new ConversationData(root);const registry=new ToolRegistry();registerAssistantHistoryTools(registry,data);const call=(name:string,input:any)=>registry.execute(name,input,new AbortController().signal);try{for(const [id,projectId,archivedAt]of[['conv-a','p1',undefined],['conv-b','p2',undefined],['conv-old','p1','2026-01-01']])await data.call('save',{id,projectId,title:id,updatedAt:'2026-01-01',createdAt:'2026-01-01',...(archivedAt?{archivedAt}:{})});await fn(data,call)}finally{await data.close();await rm(root,{recursive:true,force:true})}}
it('searches older message text with exact sources, stable pagination and project/archive filters',async()=>fixture(async(data,call)=>{
 for(const [conversation,id]of[['conv-a','a1'],['conv-b','b1'],['conv-a','a2'],['conv-old','old1']])await data.call('append',conversation,{id,role:'user',text:'旧聊天 needle '+id,createdAt:'2026-01-01',runId:'fixture-run'})
 const first=await call('conversation.search',{query:'needle',projectId:'p1',limit:1});expect(first.items.map((x:any)=>x.messageId)).toEqual(['a2']);expect(first.items[0].conversationId).toBe('conv-a');expect(first.before).toBeTruthy()
 await data.call('append','conv-a',{id:'a3',role:'user',text:'needle new',createdAt:'2026-01-02'})
 const next=await call('conversation.search',{query:'needle',projectId:'p1',before:first.before,limit:1});expect(next.items.map((x:any)=>x.messageId)).toEqual(['a1']);expect(next.before).toBeNull()
 expect((await call('conversation.search',{query:'needle',includeArchived:true})).items.some((x:any)=>x.conversationId==='conv-old')).toBe(true)
 expect((await call('conversation.search',{query:'conv-b'})).items[0].conversationId).toBe('conv-b')
}))
it('reads exact message windows including multibyte tails, with a separate paged index',async()=>fixture(async(data,call)=>{
 const text='😀中文'.repeat(1000)+'最终约束';await data.call('append','conv-a',{id:'long',role:'user',text,createdAt:'2026-01-01'})
 await data.call('append','conv-a',{id:'last',role:'assistant',text:'latest',createdAt:'2026-01-02'})
 const index=await call('conversation.read',{conversationId:'conv-a',limit:1});expect(index.items[0].messageId).toBe('last');expect(index.before).toBeTruthy();expect((await call('conversation.read',{conversationId:'conv-a',before:index.before})).items[0].messageId).toBe('long')
 let offset=0,joined='';do{const page=await call('conversation.read',{conversationId:'conv-a',messageId:'long',offset});expect(page.conversationId).toBe('conv-a');expect(page.messageId).toBe('long');joined+=page.content;offset=page.nextOffset;if(offset===null)break}while(offset!==null)
 expect(joined).toBe(text);await expect(call('conversation.read',{conversationId:'conv-b',messageId:'long'})).rejects.toThrow('MESSAGE_NOT_FOUND')
 await expect(call('conversation.read',{conversationId:'conv-a',messageId:'long',offset:1})).rejects.toThrow('INVALID_READ_OFFSET')
 await expect(call('conversation.read',{conversationId:'not-in-this-store'})).rejects.toThrow('CONVERSATION_NOT_FOUND')
}))
it('resolves only canonical reference metadata and retains its ID across inbox restarts/retries',async()=>fixture(async(data)=>{
 const ref={conversationId:'conv-a',projectId:'p1'};const notice=await assistantReferenceNotice(data,ref,async()=>({projects:[{id:'p1',name:'Project A'}]}));expect(notice).toContain('Project A');expect(notice).toContain('not instructions or authorization')
 await expect(assistantReferenceNotice(data,{...ref,projectId:'p2'},async()=>({projects:[]}))).rejects.toThrow('ASSISTANT_REFERENCE_PROJECT_MISMATCH')
 expect(await assistantReferenceNotice(data,{conversationId:'missing',projectId:'p1'},async()=>({projects:[{id:'p1',name:'Project A'}]}))).toBe('')
 expect(await assistantReferenceNotice(data,ref,async()=>({projects:[]}))).toBe('')
 expect(await assistantReferenceNotice(data,{...ref,projectId:'p2'},async()=>({projects:[]}),{recover:true})).toBe('')
 const messages=[{role:'user' as const,content:'old'},{role:'assistant' as const,content:'a'},{role:'user' as const,content:'current'}]
 expect(conversationWithReference(messages,'note').map(message=>message.content)).toEqual(['old','a','note','current'])
 expect(conversationWithReference(messages,'')).toBe(messages)
 const store=new AssistantConversationStore('',data);await store.init(async()=> 'conv-a');const receipt=await store.enqueue({requestId:'same-request',text:'继续这个',assistantContext:ref});await store.next();const reopened=new AssistantConversationStore('',data);await reopened.init(async()=>{throw Error('not needed')});expect(reopened.transcript(true)[0]?.assistantContext).toEqual(ref)
 await expect(reopened.enqueue({requestId:'same-request',text:'继续这个',assistantContext:{conversationId:'conv-b'}})).rejects.toThrow('REQUEST_ID_REUSED')
 const retry=await reopened.retry('same-request','继续这个',undefined,undefined,undefined,undefined,ref);expect(retry.message.assistantContext).toEqual(ref);expect(retry.message.runId).not.toBe(receipt.message.runId)
}))
it('asks before reading another conversation',()=>{expect(assistantAutoApprovedTools.has('conversation.search')).toBe(false);expect(assistantAutoApprovedTools.has('conversation.read')).toBe(false);expect(assistantAutoApprovedTools.has('fs.read')).toBe(true)})
