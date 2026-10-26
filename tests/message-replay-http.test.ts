import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import {createLocalHost,H5Server} from '../packages/server/src/index.js'
it('replays canonical long chat content/reference using the original request ID, and accepts rich work duplicates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pulse-message-replay-')),nativeFetch=globalThis.fetch,models:any[]=[];
 vi.stubGlobal('fetch',async(input:any,init:any)=>{if(String(input).startsWith('http://127.0.0.1:12345/')){models.push(JSON.parse(String(init.body)));return Response.json({choices:[{message:{content:'fixture complete'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}return nativeFetch(input,init)});
 const profile={provider:'openai-compatible' as const,baseURL:'http://127.0.0.1:12345/v1',defaultModel:'fixture'};const host=createLocalHost({cwd:root,dataDir:root,provider:profile,providerProfiles:{fixture:profile},providerModels:{fixture:{provider:'fixture',model:'fixture'}},activeModel:'fixture',assistantModel:'fixture',jarvis:{enabled:false}}),server=new H5Server(host,{dataDir:root,host:'127.0.0.1',port:0});
 try{const base=`http://127.0.0.1:${(await server.start()).port}`,session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}}),headers={Cookie:session.headers.get('set-cookie')!,Origin:base,'Content-Type':'application/json'},inbox=(server as any).assistantInbox,conversationId=inbox.conversationId,now=new Date().toISOString(),text='context '.repeat(1100)+'最后只读',requestId='review-canonical-replay',assistantContext={conversationId},richContent={version:1,document:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text,marks:[{type:'bold'}]}]}]}};
 const queued=await inbox.enqueue({requestId,text,assistantContext,richContent});await inbox.update(queued.message.runId,'failed');
 // A queued-only entry must carry its reference before a conversation message exists.
 const queuedView=await fetch(base+'/api/assistant',{headers}).then(r=>r.json());expect(queuedView.messages.find((m:any)=>m.requestId===requestId).assistantContext).toEqual(assistantContext);
 await host.conversationData.call('append',conversationId,{id:'msg-'+requestId,role:'user',text,runId:queued.message.runId,assistantContext,richContent,createdAt:now});
 const preview=await fetch(base+`/api/data/conversations/${conversationId}/messages`,{headers}).then(r=>r.json());expect(preview.items[0].text.length).toBe(8000);
 const canonical=await fetch(base+`/api/data/conversations/${conversationId}/body?id=msg-${requestId}`,{headers}).then(r=>r.json());expect(canonical.text).toBe(text);
 const retry=await fetch(base+'/api/assistant/messages',{method:'POST',headers,body:JSON.stringify({requestId,delivery:'whenIdle',retry:true,text:canonical.text,assistantContext:canonical.assistantContext,richContent:canonical.richContent})});expect(retry.status).toBe(202);expect((await retry.json()).messageId).toBe(requestId);
 await vi.waitFor(()=>expect(inbox.list().find((m:any)=>m.messageId===requestId)?.state).toBe('completed'));expect(models).toHaveLength(1);expect(JSON.stringify(models[0])).toContain('最后只读');expect((await host.getConversationMessages(conversationId)).filter(m=>m.id==='msg-'+requestId)).toHaveLength(1);
 const work=await host.createConversation({title:'fixture work'});await host.conversationData.call('append',work.id,{id:'msg-rich-work-retry',role:'user',text:'rich work',richContent,runId:'prior-work-run',createdAt:now});const workRetry=await fetch(base+`/api/conversations/${work.id}/messages`,{method:'POST',headers,body:JSON.stringify({requestId:'rich-work-retry',text:'rich work',richContent,delivery:'whenIdle'})});expect(workRetry.status).toBe(200);expect(await workRetry.json()).toEqual({runId:'prior-work-run'});expect(models).toHaveLength(1);
 const changed=await fetch(base+'/api/assistant/messages',{method:'POST',headers,body:JSON.stringify({requestId,text:'changed',assistantContext,delivery:'whenIdle',retry:true})});expect(changed.status).toBe(409);expect(await changed.json()).toEqual({error:'REQUEST_ID_REUSED'});
 }finally{await server.stop();await host.close();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true})}
})
