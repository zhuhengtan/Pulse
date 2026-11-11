import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PendingWorkSummary } from '../src/PendingWorkSummary.js'
import { routingFixture } from './fixtures/routing.js'
import type { WebAssistantWorkInteraction, WebMessage } from '../src/transport.js'
beforeAll(()=>{
  window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}}) as any
  Element.prototype.scrollTo=vi.fn();Element.prototype.scrollIntoView=vi.fn()
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();localStorage.clear()})
const interaction=(ordinal:number):WebAssistantWorkInteraction=>({runId:`run-work-${ordinal}`,conversationId:`work-${ordinal}`,title:`工作 ${ordinal}`,approvalPolicy:'manual',groupId:`group-${ordinal}`,kind:ordinal===2?'ask':'approval',requestedAt:Date.now()-12*60_000,items:[{effectId:`e-${ordinal}`,input:ordinal===2?{type:'input',prompt:'请补充目标'}:{tools:[{toolName:'fs.write',details:{path:`report-${ordinal}.txt`}}]}}],action:{callbackId:`callback-${ordinal}`,conversationId:`work-${ordinal}`,runId:`run-work-${ordinal}`,fingerprint:`fingerprint-${ordinal}`,controlRevision:1,interaction:{groupId:`group-${ordinal}`,kind:ordinal===2?'ask':'approval',items:[{effectId:`e-${ordinal}`,input:ordinal===2?{type:'input',prompt:'请补充目标'}:{tools:[{toolName:'fs.write',details:{path:`report-${ordinal}.txt`}}]}}]}}})
it('shows all native pending cards without a model explanation, independent of history pagination, and submits one exact approval',async()=>{
  const base=routingFixture(),original=base.transport.request,now=new Date().toISOString(),listeners=new Set<()=>void>(),posts:any[]=[]
  let pending=[interaction(1),interaction(2),interaction(3)]
  base.transport.onChange=listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
  base.transport.request=(path,init)=>{
    if(path==='/api/assistant')return Promise.resolve(Response.json({conversation:{id:'assistant',title:'Pulse 助理',cwd:'/example',createdAt:now,updatedAt:now},messages:[],receipts:[],workInteractions:pending,before:'older-history'}))
    if(path==='/api/assistant/work/work-1/replies'){
      posts.push(JSON.parse(String(init?.body)));pending=pending.filter(i=>i.conversationId!=='work-1');listeners.forEach(listener=>listener());return Promise.resolve(Response.json({ok:true}))
    }
    return original(path,init)
  }
  const router=createMemoryRouter([{path:'*',element:<PulseApp transport={base.transport}/>}],{initialEntries:['/chat?notification=group-2']})
  const ui=render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  await waitFor(()=>expect(ui.getAllByLabelText('聊天审批')).toHaveLength(2))
  expect(ui.getByRole('region',{name:'待回答问题'})).toBeTruthy()
  const summary=ui.getByRole('complementary',{name:'待处理事项'})
  expect(within(summary).getAllByRole('button')).toHaveLength(3)
  expect(within(summary).getAllByText(/已等待 12 分钟/)).toHaveLength(3)
  fireEvent.click(within(summary).getByRole('button',{name:'查看待审批操作：工作 1'}))
  const approval=ui.getAllByLabelText('聊天审批').find(e=>e.closest('article')?.id.includes('run-work-1'))!
  const agree=within(approval).getByRole('button',{name:'同意',exact:true})
  fireEvent.click(agree);fireEvent.click(agree)
  await waitFor(()=>expect(posts).toHaveLength(1))
  expect(posts[0]).toEqual({callbackId:'callback-1',fingerprint:'fingerprint-1',answers:[{effectId:'e-1',value:{approved:true}}]})
  await waitFor(()=>expect(within(summary).getAllByRole('button')).toHaveLength(2))
  expect(ui.queryByText('回复中断了，可以重新发送。')).toBeNull()
})
it('updates elapsed time without sending messages or replacing the original request time',()=>{
  vi.useFakeTimers()
  const item={...interaction(1),kind:'interaction' as const,interactionKind:'approval' as const},locate=vi.fn()
  const ui=render(<PulseDesignSystem><PendingWorkSummary items={[item]} onLocate={locate}/></PulseDesignSystem>)
  expect(ui.getByText('等待你审批 · 已等待 12 分钟')).toBeTruthy()
  act(()=>{vi.advanceTimersByTime(60_000)})
  expect(ui.getByText('等待你审批 · 已等待 13 分钟')).toBeTruthy()
  fireEvent.click(ui.getByRole('button'))
  expect(locate).toHaveBeenCalledWith(item)
})
