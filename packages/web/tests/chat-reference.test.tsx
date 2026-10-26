import {cleanup,fireEvent,render,waitFor} from '@testing-library/react'
import {afterEach,beforeAll,expect,it,vi} from 'vitest'
import {createMemoryRouter,RouterProvider} from 'react-router'
import {PulseApp} from '../src/PulseApp.js'
import {PulseDesignSystem} from '../src/PulseDesignSystem.js'
import {routingFixture} from './fixtures/routing.js'
import {chatModePath,chatReferenceFromQuery} from '../src/chat-reference.js'
import {MessageQueuePanel} from '../src/MessageQueuePanel.js'
import type {MessageQueueController} from '../src/MessageQueue.js'
vi.mock('../src/RichComposer.js',()=>({emptyComposerDraft:()=>({markdown:'',attachments:[],processing:0,revision:0}),RichComposer:({onSend}:{onSend:(payload:{text:string})=>void})=><button onClick={()=>onSend({text:'继续这个项目，只读'})}>fixture-send</button>}))
beforeAll(()=>{window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})as any;Element.prototype.scrollTo=vi.fn();vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})})
const routers:ReturnType<typeof createMemoryRouter>[]=[]
afterEach(()=>{cleanup();routers.splice(0).forEach(r=>r.dispose());localStorage.clear();vi.restoreAllMocks()})
it('carries exact work/project IDs into chat and submits the frozen navigation reference',async()=>{
 const f=routingFixture(),original=f.transport.request,posts:any[]=[];f.transport.request=async(path,init)=>{if(path==='/api/assistant/messages'){const body=JSON.parse(String(init?.body));posts.push(body);return Response.json({conversationId:'assistant',messageId:body.requestId,runId:'fixture-run',state:'completed'})}return original(path,init)}
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/work/pulse-chat']});routers.push(router);const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>);await ui.findByText('消息：pulse-chat');fireEvent.click(ui.getByRole('tab',{name:'聊天'}));await ui.findByRole('button',{name:'清除引用'});expect(chatReferenceFromQuery(new URLSearchParams(router.state.location.search))).toEqual({projectId:'pulse',conversationId:'pulse-chat'});fireEvent.click(ui.getByRole('button',{name:'fixture-send'}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0].assistantContext).toEqual({projectId:'pulse',conversationId:'pulse-chat'});fireEvent.click(ui.getByRole('button',{name:'清除引用'}));await waitFor(()=>expect(router.state.location.search).toBe(''));fireEvent.click(ui.getByRole('button',{name:'fixture-send'}));await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].assistantContext).toBeUndefined()
})
it('generic chat has no implicit stale project reference',()=>{expect(chatModePath()).toBe('/chat');expect(chatReferenceFromQuery(new URLSearchParams('notification=g'))).toBeUndefined();expect(chatReferenceFromQuery(new URLSearchParams(chatModePath('c','p').split('?')[1]))).toEqual({projectId:'p',conversationId:'c'})})
it('labels queue pause as sending only and never calls run cancellation',async()=>{const pause=vi.fn(async()=>{}),controller={pause}as unknown as MessageQueueController;const ui=render(<MessageQueuePanel queue={{key:'k',scope:'s',surface:'chat',conversationId:'c',entries:[{requestId:'request-one',createdAt:'2026',payload:{text:'待发'}}],paused:true}} controller={controller} onError={()=>{}}/>);expect(ui.getByText('仅暂停待发消息，正在运行的任务不受影响。')).toBeTruthy();fireEvent.click(ui.getByRole('button',{name:'继续发送'}));await waitFor(()=>expect(pause).toHaveBeenCalledWith('c',false))})
