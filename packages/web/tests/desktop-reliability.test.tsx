import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { DesktopEnvironment } from '../src/DesktopSetup.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'
beforeAll(()=>{ Object.defineProperty(window,'matchMedia',{value:()=>({matches:false,addEventListener(){},removeEventListener(){}}),configurable:true}); Element.prototype.scrollTo=vi.fn();vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}}) })
beforeEach(()=>localStorage.clear())
afterEach(()=>{cleanup();vi.restoreAllMocks();delete window.pulseDesktop;history.replaceState(null,'','/')})
const answer=(value:unknown,status=200)=>Response.json(value,{status})
const pending={conversationId:'busy',runId:'run-busy',status:'confirmation-required',from:'a'.repeat(64),to:'b'.repeat(64),blockers:[],toolCheck:'on-resume'}
function fixture(preflight:unknown=pending,status=200,postError?:string) {
 const f=routingFixture(),request=f.transport.request,posts:unknown[]=[]
 f.transport.request=async(path,init)=>{
  if(path.endsWith('/runs/run-busy/recovery'))return answer(preflight,status)
  if(path.endsWith('/runs/run-busy/resume')){posts.push(init?.body?JSON.parse(String(init.body)):null);return postError?answer({error:postError},409):answer({runId:'run-busy'})}
  if(path==='/api/runs/run-busy/state')return answer({runId:'run-busy',state:'interrupted',seq:0,activities:[]})
  if(path==='/api/web/conversations/busy/messages')return answer([])
  if(path==='/api/web/conversations/busy/traces')return answer({traces:[]})
  return request(path,init)
 }
 const router=createMemoryRouter([{path:'*',element:<PulseApp transport={f.transport}/>}],{initialEntries:['/work/busy']})
 render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
 return {posts,router}
}
it('shows full build pair and only submits the exact run confirmation after acceptance',async()=>{
 const f=fixture();fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}))
 await screen.findByRole('dialog');expect(screen.getByText(pending.from)).toBeTruthy();expect(screen.getByText(pending.to)).toBeTruthy();expect(f.posts).toEqual([])
 fireEvent.click(screen.getByRole('button',{name:'确认',exact:true}))
 await waitFor(()=>expect(f.posts).toEqual([{recovery:{runId:'run-busy',from:pending.from,to:pending.to,confirmed:true}}]))
})
it('cancellation retains the recovery card and grants no migration',async()=>{
 const f=fixture();fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}));fireEvent.click(await screen.findByRole('button',{name:'取消',exact:true}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'继续任务',exact:true}).hasAttribute('disabled')).toBe(false));expect(f.posts).toEqual([])
})
it('a route change while confirming never resumes the previously selected run',async()=>{
 const f=fixture();fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}));await screen.findByRole('dialog')
 await act(()=>f.router.navigate('/work/pulse-chat'));fireEvent.click(screen.getByRole('button',{name:'确认',exact:true}))
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(f.posts).toEqual([])
})
it.each(['RECOVERY_POLICY_INCOMPATIBLE','RECOVERY_SNAPSHOT_UNREADABLE','RECOVERY_FORMAT_CONFLICT'])('explains %s without sending resume',async blocker=>{
 const f=fixture({...pending,status:'blocked',blockers:[blocker]});fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'继续任务',exact:true}).hasAttribute('disabled')).toBe(false));expect(f.posts).toEqual([]);expect(screen.queryByRole('dialog')).toBeNull()
 expect(await screen.findByText(blocker.includes('POLICY')?/恢复被策略变化阻止/:blocker.includes('UNREADABLE')?/无法读取运行快照/:/此运行存在多种快照格式/)).toBeTruthy()
})
it.each([200,404])('same-build and older backend %s resume without automatic build authorization',async status=>{
 const f=fixture({...pending,status:'ready'},status);fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}));await waitFor(()=>expect(f.posts).toEqual([null]));expect(screen.queryByRole('dialog')).toBeNull()
})
it('stale server response requests a new confirmation instead of retrying silently',async()=>{
 const f=fixture(pending,200,'RECOVERY_CONFIRMATION_STALE');fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}));fireEvent.click(await screen.findByRole('button',{name:'确认',exact:true}))
 await screen.findByText('构建或运行已变化，本次确认未使用。请重新检查并确认。');expect(f.posts).toHaveLength(1);expect(screen.getByRole('region',{name:'任务恢复'})).toBeTruthy()
})
it('rejects a preflight response for a different run',async()=>{
 const f=fixture({...pending,runId:'other'});fireEvent.click(await screen.findByRole('button',{name:'继续任务',exact:true}));await screen.findByText('运行已变化，请重新检查后继续。');expect(f.posts).toEqual([])
})
function diagnosticFixture(fail=false) {
 window.pulseDesktop={installation:true} as unknown as NonNullable<Window['pulseDesktop']>
 const paths:string[]=[]
 const transport={request:async(path:string)=>{paths.push(path);return path.endsWith('/diagnostics')?answer(fail?{error:'UNAVAILABLE'}:{directory:'/isolated/logs',text:'PULSE_SERVICE_START_ERROR:ENOENT'},fail?503:200):answer({phase:'error',firstRun:false,error:'后台启动失败',steps:[]})},subscribe:()=>()=>{}}
 render(<PulseDesignSystem><DesktopEnvironment transport={transport}/></PulseDesignSystem>);return paths
}
it('desktop diagnostics opens locally from the recovery UI without requiring a healthy backend',async()=>{
 const paths=diagnosticFixture();fireEvent.click(screen.getByRole('button',{name:'查看启动诊断'}));await screen.findByText('PULSE_SERVICE_START_ERROR:ENOENT');expect(paths).toContain('/api/desktop/diagnostics')
})
it('diagnostics read errors remain actionable and do not lose the setup page',async()=>{
 diagnosticFixture(true);fireEvent.click(screen.getByRole('button',{name:'查看启动诊断'}));await screen.findByText('暂时无法读取本地诊断，请稍后重试。');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,800))});expect(screen.getByText('暂时无法读取本地诊断，请稍后重试。')).toBeTruthy();expect(screen.getByRole('button',{name:'查看启动诊断'})).toBeTruthy()
})
it('menu deep link automatically loads the read-only diagnostic pane',async()=>{
 history.replaceState(null,'','/settings/desktop?diagnostics=1');const paths=diagnosticFixture();await screen.findByText('PULSE_SERVICE_START_ERROR:ENOENT');expect(paths.filter(path=>path.endsWith('/diagnostics'))).toHaveLength(1)
})
