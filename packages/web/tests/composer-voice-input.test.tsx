import { useState } from 'react'
import type { Editor } from '@tiptap/core'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RichComposer, emptyComposerDraft, type ComposerDraft } from '../src/RichComposer.js'
import { dictationAudio } from './fixtures/dictation-audio.js'

beforeAll(()=>{
 window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})as unknown as MediaQueryList
 Range.prototype.getClientRects=()=>[]as unknown as DOMRectList
 Range.prototype.getBoundingClientRect=()=>({x:0,y:0,top:0,bottom:0,left:0,right:0,width:0,height:0,toJSON(){}})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
const editorOf=(view:ReturnType<typeof render>)=>(view.container.querySelector('.tiptap') as HTMLElement &{editor:Editor}).editor
function fixture(mode:'chat'|'work'='chat'){
 const audio=dictationAudio(),send=vi.fn(async()=>true)
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
 vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;isPrimary=true;pointerType='mouse';constructor(name:string,init:PointerEventInit={}){super(name,init);this.pointerId=init.pointerId??1}})
 let calls=0;const request=vi.fn(async(path:string)=>Response.json(path.endsWith('config')?{microphoneId:'',asr:{model:'fixture'}}:path.endsWith('transcribe')?{text:++calls===1?'临时文字':'完整文字 <b>原文</b>'}:{}))
 const transport={request,subscribe:()=>()=>{}}
 function Harness(){const[key,setKey]=useState('A'),[drafts,setDrafts]=useState<Record<string,ComposerDraft>>({});return <><button onClick={()=>setKey(v=>v==='A'?'B':'A')}>切换会话</button><RichComposer key={key} surfaceMode={mode} draft={drafts[key]??emptyComposerDraft()} onChange={update=>setDrafts(current=>({...current,[key]:update(current[key]??emptyComposerDraft())}))} transport={transport} onSend={send}/></>}
 const view=render(<Harness/>);return{...audio,view,request,send}
}
it('long-presses the editor, progressively replaces interim text, then sends only after confirmation',async()=>{
 const f=fixture();act(()=>editorOf(f.view).commands.insertContent('已有草稿：'))
 const wrap=f.view.container.querySelector('.composer-editor-wrap')!
 fireEvent.pointerDown(wrap,{button:0,pointerId:1,clientX:20,clientY:20})
 expect(f.getUserMedia).not.toHaveBeenCalled()
 await waitFor(()=>expect(f.getUserMedia).toHaveBeenCalledOnce())
 await waitFor(()=>expect(f.view.getByRole('status').textContent).toContain('正在听写'))
 act(()=>f.speech());await waitFor(()=>expect(editorOf(f.view).getText()).toBe('已有草稿：临时文字'))
 expect(f.send).not.toHaveBeenCalled();expect((f.view.getByRole('button',{name:'发送'})as HTMLButtonElement).disabled).toBe(true)
 fireEvent.pointerUp(window,{pointerId:1});await waitFor(()=>expect(editorOf(f.view).getText()).toBe('已有草稿：完整文字 <b>原文</b>'))
 expect(f.view.container.querySelector('.tiptap b')).toBeNull();expect(f.stop).toHaveBeenCalledOnce();expect(f.send).not.toHaveBeenCalled()
 await waitFor(()=>expect((f.view.getByRole('button',{name:'发送'})as HTMLButtonElement).disabled).toBe(false))
 fireEvent.click(f.view.getByRole('button',{name:'发送'}));await waitFor(()=>expect(f.send).toHaveBeenCalledOnce())
 expect(f.send.mock.calls[0]?.[0]).toMatchObject({text:expect.stringContaining('完整文字')})
})
it('keeps ordinary clicks and mouse text selection from opening the microphone',async()=>{
 const f=fixture();vi.useFakeTimers();const wrap=f.view.container.querySelector('.composer-editor-wrap')!
 fireEvent.pointerDown(wrap,{button:0,pointerId:1});fireEvent.pointerUp(window,{pointerId:1})
 await act(async()=>vi.advanceTimersByTime(500));expect(f.getUserMedia).not.toHaveBeenCalled()
 fireEvent.pointerDown(wrap,{button:0,pointerId:2,clientX:10,clientY:10});fireEvent.pointerMove(window,{pointerId:2,clientX:35,clientY:10})
 await act(async()=>vi.advanceTimersByTime(500));expect(f.getUserMedia).not.toHaveBeenCalled()
 fireEvent.pointerDown(wrap,{button:2,pointerId:3});await act(async()=>vi.advanceTimersByTime(500));expect(f.request).not.toHaveBeenCalled()
})
it('releases capture on conversation switch and drops late ASR from the old draft',async()=>{
 const f=fixture();let finish!:(value:Response)=>void
 f.request.mockImplementation(async path=>path.endsWith('transcribe')?new Promise(resolve=>{finish=resolve}):Response.json({microphoneId:'',asr:{model:'fixture'}}))
 fireEvent.pointerDown(f.view.getByRole('button',{name:'按住说话'}),{button:0,pointerId:1})
 await waitFor(()=>expect(f.view.getByRole('status').textContent).toContain('正在听写'))
 act(()=>f.speech());await waitFor(()=>expect(finish).toBeDefined());fireEvent.click(f.view.getByText('切换会话'))
 await act(async()=>finish(Response.json({text:'过期的文字'})))
 expect(editorOf(f.view).getText()).toBe('');expect(f.stop).toHaveBeenCalledOnce();expect(f.send).not.toHaveBeenCalled()
})
it('supports keyboard hold and escape cancellation without sending a message',async()=>{
 const f=fixture(),button=f.view.getByRole('button',{name:'按住说话'})
 fireEvent.keyDown(button,{key:' '});await waitFor(()=>expect(f.view.getByRole('status').textContent).toContain('正在听写'))
 act(()=>f.speech(2));fireEvent.keyDown(window,{key:'Escape'})
 expect(f.stop).toHaveBeenCalledOnce();expect(f.send).not.toHaveBeenCalled();expect(f.view.queryByRole('status')).toBeNull()
})
it('leaves work-mode composer behavior unchanged',()=>{const f=fixture('work');expect(f.view.queryByRole('button',{name:'按住说话'})).toBeNull()})
