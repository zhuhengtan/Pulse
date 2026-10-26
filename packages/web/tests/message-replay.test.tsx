import {cleanup,fireEvent,render,waitFor} from '@testing-library/react'
import {afterEach,beforeAll,expect,it,vi} from 'vitest'
import {createMemoryRouter,RouterProvider} from 'react-router'
import {PulseApp} from '../src/PulseApp.js'
import {PulseDesignSystem} from '../src/PulseDesignSystem.js'
import {IndexedMessageQueueStore} from '../src/MessageQueue.js'
import {routingFixture} from './fixtures/routing.js'
const rich={version:1,document:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'review retry',marks:[{type:'bold'}]}]}]}}
vi.mock('../src/RichComposer.js',()=>({emptyComposerDraft:()=>({markdown:'',attachments:[],processing:0,revision:0}),RichComposer:({onSend}:any)=><button onClick={()=>onSend({text:'review retry',attachments:[{id:'attachment-fixture',name:'fixture.txt',type:'file',size:4,mediaType:'text/plain',data:'data:text/plain;base64,dGVzdA=='}],skills:['fixture-skill'],richContent:{version:1,document:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'review retry',marks:[{type:'bold'}]}]}]}}})}>fixture-send</button>}))
beforeAll(()=>{const style=window.getComputedStyle.bind(window);window.getComputedStyle=element=>style(element);window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})as any;Element.prototype.scrollTo=vi.fn();vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})})
const routers:any[]=[]
afterEach(()=>{cleanup();routers.splice(0).forEach(r=>r.dispose());localStorage.clear();vi.restoreAllMocks()})
it.each(['chat','work'])('%s manual retry preserves the full original payload and request ID',async mode=>{
 const f=routingFixture(),original=f.transport.request,posts:any[]=[];
 f.transport.request=async(path,init)=>{
 if(path===(mode==='chat'?'/api/assistant/messages':'/api/conversations/pulse-chat/messages')&&init?.method==='POST'){
 const body=JSON.parse(String(init.body));posts.push(body);
 return Response.json(posts.length===1?{error:'SIMULATED_TRANSIENT_FAILURE'}:{conversationId:'assistant',messageId:body.requestId,runId:'retry-run',state:'completed'},{status:posts.length===1?503:200})}
 return original(path,init)}
 const initial=mode==='chat'?'/chat?project=pulse&referenceConversation=pulse-chat':'/work/pulse-chat';
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:[initial]});routers.push(router);
 const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);
 if(mode==='chat'){await ui.findByRole('button',{name:'清除引用'});await ui.findByText('我们要做什么？');}else await ui.findByText('消息：pulse-chat');
 fireEvent.click(ui.getByRole('button',{name:'fixture-send'}));
 fireEvent.click(await ui.findByRole('button',{name:'发送失败，重新发送'}));
 fireEvent.click(await ui.findByRole('button',{name:'确认',exact:true}));
 await waitFor(()=>expect(posts).toHaveLength(2));
 expect(posts[0].richContent).toEqual(rich);
 if(mode==='chat'){expect(posts[0].assistantContext).toEqual({projectId:'pulse',conversationId:'pulse-chat'});expect(posts[1].assistantContext).toEqual(posts[0].assistantContext)}
 else {expect(posts[0].mentionedFiles).toBeUndefined();expect(posts[1].richContent).toEqual(rich)}
 expect(posts[1].requestId).toBe(posts[0].requestId);expect(posts[1].attachments).toEqual(posts[0].attachments);expect(posts[1].skills).toEqual(posts[0].skills);
})

it('a busy-response queue keeps the frozen navigation reference when the user changes projects',async()=>{
 const values=new Map<string,any>();vi.spyOn(IndexedMessageQueueStore.prototype,'list').mockImplementation(async scope=>[...values.values()].filter(v=>v.scope===scope));vi.spyOn(IndexedMessageQueueStore.prototype,'update').mockImplementation(async(key,change)=>{const value=change(values.get(key));values.set(key,value);return value});
 const f=routingFixture(),original=f.transport.request,posts:any[]=[];
 f.transport.request=async(path,init)=>{if(path==='/api/assistant/messages'&&init?.method==='POST'){const body=JSON.parse(String(init.body));posts.push(body);return posts.length===1?Response.json({error:'CONVERSATION_BUSY'},{status:409}):Response.json({conversationId:'assistant',messageId:body.requestId,runId:'queued-run',state:'completed'})}return original(path,init)};
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/chat?project=pulse&referenceConversation=pulse-chat']});routers.push(router);
 const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);await ui.findByText('我们要做什么？');await ui.findByRole('button',{name:'清除引用'});
 fireEvent.click(ui.getByRole('button',{name:'fixture-send'}));await waitFor(()=>expect(values.size).toBe(1));
 const queued=[...values.values()][0].entries[0];expect(posts[0].assistantContext).toEqual({projectId:'pulse',conversationId:'pulse-chat'});expect(queued.payload.assistantContext).toEqual(posts[0].assistantContext);expect(queued.payload.richContent).toEqual(posts[0].richContent);await router.navigate('/chat?project=jarvis&referenceConversation=jarvis-chat');window.dispatchEvent(new Event('online'));await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].assistantContext).toEqual(posts[0].assistantContext);expect(posts[1].requestId).toBe(posts[0].requestId);expect(posts[1].attachments).toEqual(posts[0].attachments);expect(posts[1].skills).toEqual(posts[0].skills);expect(posts[1].richContent).toEqual(posts[0].richContent);
})
it.each([false,true])('retrying a reloaded long chat uses full canonical content; expanded=%s',async expanded=>{
 const full='x'.repeat(8500)+'尾部纠正',preview=full.slice(0,8000),now=new Date().toISOString(),f=routingFixture(),original=f.transport.request,posts:any[]=[];
 f.transport.request=async(path,init)=>{
 if(path==='/api/assistant')return Response.json({conversation:{id:'assistant',title:'fixture',cwd:'/example',createdAt:now,updatedAt:now},messages:[{id:'msg-long-fixture',role:'user',text:preview,bodyTruncated:true,bodyLength:full.length,requestId:'long-fixture',deliveryState:'failed',createdAt:now}],receipts:[{messageId:'long-fixture',state:'failed',runId:'old-run',createdAt:now,updatedAt:now}],workInteractions:[]});
 if(path==='/api/data/conversations/assistant/body?id=msg-long-fixture')return Response.json({id:'msg-long-fixture',text:full});
 if(path==='/api/assistant/messages'&&init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return Response.json({error:'REQUEST_ID_REUSED'},{status:409})}return original(path,init)};
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/chat']});routers.push(router);
 const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);
 await ui.findByRole('button',{name:'展开完整消息'});if(expanded){fireEvent.click(ui.getByRole('button',{name:'展开完整消息'}));await ui.findByText(full);}
 fireEvent.click(ui.getByRole('button',{name:'发送失败，重新发送'}));fireEvent.click(await ui.findByRole('button',{name:'确认',exact:true}));
 await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0].text).toBe(full);expect(posts[0].requestId).toBe('long-fixture');
})

it('does not send a preview if the original body cannot be retrieved',async()=>{
 const f=routingFixture(),original=f.transport.request,now=new Date().toISOString(),posts:any[]=[];
 f.transport.request=async(path,init)=>{if(path==='/api/assistant')return Response.json({conversation:{id:'assistant',title:'fixture',cwd:'/example',createdAt:now,updatedAt:now},messages:[{id:'msg-body-failed',role:'user',text:'preview',bodyTruncated:true,requestId:'body-failed',deliveryState:'failed',createdAt:now}],receipts:[],workInteractions:[]});if(path.includes('/body?id='))return Response.json({error:'TEMPORARILY_UNAVAILABLE'},{status:503});if(path==='/api/assistant/messages'){posts.push(init);return Response.json({})}return original(path,init)};
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/chat']});routers.push(router);const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);fireEvent.click(await ui.findByRole('button',{name:'发送失败，重新发送'}));fireEvent.click(await ui.findByRole('button',{name:'确认',exact:true}));await ui.findByText('无法读取完整原消息，未重新发送；原消息和草稿已保留。');expect(posts).toHaveLength(0);expect(ui.getByRole('button',{name:'发送失败，重新发送'})).toBeTruthy();
})

it.each([false,true])('work retry reads the complete original after reload; expanded=%s',async expanded=>{
 const full='正文😀'.repeat(2500)+'最后只读',preview=full.slice(0,8000),now=new Date().toISOString(),f=routingFixture(),original=f.transport.request,posts:any[]=[];
 f.transport.request=async(path,init)=>{
 if(path==='/api/web/conversations/pulse-chat/messages')return Response.json([{id:'msg-long-work',role:'user',text:preview,bodyTruncated:true,bodyLength:full.length,requestId:'long-work',deliveryState:'failed',createdAt:now}]);
 if(path==='/api/data/conversations/pulse-chat/body?id=msg-long-work')return Response.json({id:'msg-long-work',text:full});
 if(path==='/api/conversations/pulse-chat/messages'&&init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return Response.json({runId:'fixture-run'})}return original(path,init)};
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/work/pulse-chat']});routers.push(router);const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);await ui.findByRole('button',{name:'展开完整消息'});if(expanded){fireEvent.click(ui.getByRole('button',{name:'展开完整消息'}));await ui.findByText(full)}fireEvent.click(ui.getByRole('button',{name:'发送失败，重新发送'}));fireEvent.click(await ui.findByRole('button',{name:'确认',exact:true}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0].text).toBe(full);expect(posts[0].requestId).toBe('long-work');
})
it('a late original-body response after navigation cannot send into the new conversation',async()=>{
 const f=routingFixture(),original=f.transport.request,now=new Date().toISOString(),posts:any[]=[];let resolve!:(r:Response)=>void;const body=new Promise<Response>(r=>{resolve=r}),loading=vi.fn();
 f.transport.request=async(path,init)=>{if(path==='/api/web/conversations/pulse-chat/messages')return Response.json([{id:'msg-slow-body',role:'user',text:'preview',bodyTruncated:true,requestId:'slow-body',deliveryState:'failed',createdAt:now}]);if(path.includes('/body?id=')){loading();return body}if(path.endsWith('/messages')&&init?.method==='POST'){posts.push(path);return Response.json({runId:'unexpected'})}return original(path,init)};
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/work/pulse-chat']});routers.push(router);const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);fireEvent.click(await ui.findByRole('button',{name:'发送失败，重新发送'}));fireEvent.click(await ui.findByRole('button',{name:'确认',exact:true}));await waitFor(()=>expect(loading).toHaveBeenCalled());await router.navigate('/work/jarvis-chat');await ui.findByText('消息：jarvis-chat');resolve(Response.json({id:'msg-slow-body',text:'full original'}));await waitFor(()=>expect(ui.queryByText('preview')).toBeNull());expect(posts).toHaveLength(0);
})
