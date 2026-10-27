import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import type { Editor } from '@tiptap/core'
import type { WebConversation } from '../src/transport.js'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

function TestApp({ transport }: { transport: ReturnType<typeof routingFixture>['transport'] }) {
  const location = useLocation()
  return <><output data-testid="rendered-route">{location.pathname}</output><PulseApp transport={transport}/></>
}

async function openFixture(mode: 'chat' | 'work', failFirst = false) {
  const fixture = routingFixture(), original = fixture.transport.request
  let count = 0
  let createdConversation: WebConversation | undefined
  fixture.transport.request = async (path, init) => {
    if (path === '/api/conversations' && init?.method === 'POST') {
      const response = await original(path, init)
      createdConversation = await response.clone().json() as WebConversation
      return response
    }
    if (path === '/api/conversations' && !init?.method && createdConversation) {
      const response = await original(path, init)
      return Response.json([...(await response.json()), createdConversation])
    }
    if (path.endsWith('/messages') && init?.method === 'POST') {
      count++
      if (failFirst && count === 1) return Response.json({ error: 'OFFLINE' }, {status: 503})
      return Response.json(mode === 'chat' ? {conversationId:'assistant', messageId:JSON.parse(String(init.body)).requestId, runId:'review-run', state:'queued'} : {runId:'review-run'})
    }
    return original(path, init)
  }
  const router = createMemoryRouter([{ path:'*', element:<TestApp transport={fixture.transport}/> }], {initialEntries:[mode === 'chat' ? '/chat' : '/work/new']})
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  await view.findByText('我们要做什么？')
  const getEditor = () => (view.container.querySelector('.tiptap') as HTMLElement & {editor:Editor}).editor
  return {view, router, getEditor,fixture}
}
it('new work draft remains isolated from the created conversation', async () => {
  const {view,router,getEditor} = await openFixture('work')
  try {
    act(()=>getEditor().commands.insertContent('首次工作消息'))
    fireEvent.click(view.getByRole('button',{name:'发送',exact:true}))
    await waitFor(()=>expect(view.getByTestId('rendered-route').textContent).toBe('/work/created'))
    await waitFor(()=>expect(getEditor().getText()).toBe(''))
    await act(async()=>{await router.navigate('/work/new')})
    await waitFor(()=>expect(view.getByTestId('rendered-route').textContent).toBe('/work/new'))
    await view.findByText('我们要做什么？')
    await waitFor(()=>expect(view.container.querySelector('.tiptap')).not.toBeNull())
    act(()=>getEditor().commands.insertContent('另一会话的新草稿'))
    await act(async()=>{await router.navigate('/work/created')})
    await waitFor(()=>expect(view.getByTestId('rendered-route').textContent).toBe('/work/created'))
    await view.findByText('消息：created')
    await waitFor(()=>expect(getEditor().getText()).toBe(''))
    await act(async()=>{await router.navigate('/work/new')})
    await waitFor(()=>expect(view.getByTestId('rendered-route').textContent).toBe('/work/new'))
    await waitFor(()=>expect(getEditor().getText()).toBe('另一会话的新草稿'))
  } finally {router.dispose()}
})
it.each(['chat', 'work'] as const)('%s retry preserves attachments added after the failed send', async mode => {
  const {view,router,getEditor} = await openFixture(mode,true)
  try {
    act(()=>getEditor().commands.insertContent('原始消息'))
    fireEvent.click(view.getByRole('button',{name:'发送',exact:true}))
    const retry = await view.findByRole('button',{name:'发送失败，重新发送'})
    fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['new draft'],'new-draft.txt',{type:'text/plain'})]}})
    await view.findByText('new-draft.txt')
    fireEvent.click(retry)
    fireEvent.click(await view.findByRole('button',{name:'确认',exact:true}))
    await waitFor(()=>expect(view.queryByRole('dialog')).toBeNull())
    expect(Boolean(view.container.querySelector('.composer-attachments')?.textContent?.includes('new-draft.txt'))).toBe(true)
  } finally {router.dispose()}
})

it('a late chat retry cannot unsubscribe the current work run',async()=>{
 const {view,router,getEditor,fixture}=await openFixture('chat',true)
 const original=fixture.transport.request, originalSubscribe=fixture.transport.subscribe
 const released:string[]=[]
 let resolveRetry!:(r:Response)=>void, retryStarted=false
 const response=new Promise<Response>(resolve=>{resolveRetry=resolve})
 fixture.transport.request=async(path,init)=>{
  if(path==='/api/assistant/messages' && init?.method==='POST' && JSON.parse(String(init.body)).retry){retryStarted=true;return response}
  return original(path,init)
 }
 fixture.transport.subscribe=(path,event,error)=>{const release=originalSubscribe(path,event,error);return()=>{released.push(path);release()}}
 try{
  act(()=>getEditor().commands.insertContent('需要重试的聊天消息'))
  fireEvent.click(view.getByRole('button',{name:'发送',exact:true}))
  fireEvent.click(await view.findByRole('button',{name:'发送失败，重新发送'}))
  fireEvent.click(await view.findByRole('button',{name:'确认',exact:true}))
  await waitFor(()=>expect(retryStarted).toBe(true))
  await act(async()=>{await router.navigate('/work/busy')})
  await waitFor(()=>expect(fixture.subscriptions).toContain('/api/runs/run-busy/events?after=0'))
  await act(async()=>{resolveRetry(Response.json({conversationId:'assistant',messageId:'retry',runId:'late-chat-run',state:'replying'}))})
  expect(released).not.toContain('/api/runs/run-busy/events?after=0')
 }finally{router.dispose()}
})

it.each(['chat', 'work'] as const)('%s retry clears an unchanged original draft after acceptance', async mode => {
  const { view, router, getEditor } = await openFixture(mode, true)
  try {
    act(() => getEditor().commands.insertContent('待重试的原草稿'))
    fireEvent.click(view.getByRole('button', { name: '发送', exact: true }))
    const retry = await view.findByRole('button', { name: '发送失败，重新发送' })
    // The failed-message control can render before TipTap applies the restored draft.
    await waitFor(() => expect(getEditor().getText()).toBe('待重试的原草稿'))
    fireEvent.click(retry)
    fireEvent.click(await view.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect(getEditor().getText()).toBe(''))
  } finally { router.dispose() }
})

it('retry preserves a new attachment whose read is still pending', async () => {
  const { view, router, getEditor } = await openFixture('chat', true)
  let reader: FileReader | undefined
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { reader = this })
  try {
    act(() => getEditor().commands.insertContent('原始文字保持不变'))
    fireEvent.click(view.getByRole('button', { name: '发送', exact: true }))
    const retry = await view.findByRole('button', { name: '发送失败，重新发送' })
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['new'], 'pending.txt', { type: 'text/plain' })] } })
    await view.findByText('正在处理附件…')
    fireEvent.click(retry)
    fireEvent.click(await view.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
    expect(getEditor().getText()).toBe('原始文字保持不变')
    await act(async () => {
      Object.defineProperty(reader!, 'result', { value: 'data:text/plain;base64,bmV3' })
      reader!.onload?.call(reader!, new ProgressEvent('load') as ProgressEvent<FileReader>)
    })
    expect(await view.findByText('pending.txt')).toBeTruthy()
  } finally { router.dispose() }
})
