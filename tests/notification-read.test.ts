import { expect, it } from 'vitest'
import { TaskNoticeInbox, type TaskNotice } from '../packages/server/src/h5/notifications.js'
const complete = (runId:string) => ({type:'complete' as const,runId,conversationId:'chat',seq:1,data:{status:'succeeded' as const}})
it('persists read state without deleting pending questions, and new revisions become unread',async()=>{
 let saved:TaskNotice[]=[];const inbox=new TaskNoticeInbox(async()=>structuredClone(saved),async value=>{saved=value})
 const event:any={type:'interactions',runId:'r',conversationId:'c',seq:1,data:{interactions:[{groupId:'g',kind:'ask',items:[{effectId:'e',input:{type:'input',prompt:'first'}}]}]}}
 await inbox.record(event);const first=(await inbox.list())[0]!
 await inbox.markRead([{id:first.id,revision:first.revision!}]);expect((await inbox.list())[0]?.readAt).toBeTypeOf('number')
 await inbox.record(event);expect((await inbox.list())[0]?.readAt).toBeDefined()
 event.data.interactions[0].items[0].input.prompt='changed';await inbox.record(event)
 await inbox.markRead([{id:first.id,revision:first.revision!}]);expect((await inbox.list())[0]?.readAt).toBeUndefined()
})
it('does not clear notifications arriving after the displayed batch and survives reconstruction',async()=>{
 let saved:TaskNotice[]=[];const read=async()=>structuredClone(saved),write=async(value:TaskNotice[])=>{saved=value};const inbox=new TaskNoticeInbox(read,write)
 await inbox.record(complete('one'));const targets=(await inbox.list()).map(item=>({id:item.id,revision:item.revision!}))
 await Promise.all([inbox.record(complete('two')),inbox.markRead(targets)])
 const restored=await new TaskNoticeInbox(read,write).list();expect(restored[0]?.readAt).toBeDefined();expect(restored[1]?.readAt).toBeUndefined()
})
it('migrates only historical completions to read, leaving old pending items unread',async()=>{
 let saved:TaskNotice[]=[{id:'complete:old',kind:'complete',runId:'old',conversationId:'c',createdAt:1},{id:'interaction:r:g',kind:'ask',runId:'r',conversationId:'c',groupId:'g',createdAt:2}]
 const inbox=new TaskNoticeInbox(async()=>saved,async value=>{saved=value});await inbox.list()
 expect(saved.find(item=>item.kind==='complete')?.readAt).toBe(1);expect(saved.find(item=>item.kind==='ask')?.readAt).toBeUndefined();expect(saved.every(item=>item.revision)).toBe(true)
})
it('retains unread completions beyond the read-history limit', async()=>{
 let saved:TaskNotice[]=[];const inbox=new TaskNoticeInbox(async()=>structuredClone(saved),async value=>{saved=value})
 for(let index=0;index<205;index++)await inbox.record(complete(String(index)))
 expect(await inbox.list()).toHaveLength(205)
 await inbox.markRead(saved.map(item=>({id:item.id,revision:item.revision!})))
 expect(await inbox.list()).toHaveLength(200)
})
