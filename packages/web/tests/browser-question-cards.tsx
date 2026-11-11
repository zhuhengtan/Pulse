import { createRoot } from 'react-dom/client'
import { MessageBubble } from '../src/MessageBubble.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { WebMessage } from '../src/transport.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/chat-surface.css'

// Visual fixtures only: no backend, model calls, or real approval decisions.
const theme = new URL(location.href).searchParams.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme
const input = { type:'choice', prompt:'已达到本轮上下文容量，是否继续？', context:'任务已暂停，已完成的操作和文件会保留。继续后会整理历史上下文，再接着执行；不会重做已完成的操作。', options:[{value:'continue',label:'继续',description:'整理上下文后继续当前任务'},{value:'stop',label:'暂不继续',description:'保留已有内容，结束本轮任务'}] }
const answered:WebMessage = {id:'answered',role:'user',text:'继续',createdAt:'2026-11-07T15:29:00Z',questionAnswer:{effectId:'q',input,answer:{value:'continue'}}}
const pending:WebMessage = {id:'pending',role:'assistant',text:'',createdAt:'2026-11-07T15:30:00Z',workAction:{callbackId:'preview',conversationId:'preview',runId:'run-preview',fingerprint:'preview',controlRevision:0,interaction:{groupId:'g',kind:'ask',items:[{effectId:'q',input}]}}}
const transport = { request:async()=>Response.json({ok:true}),subscribe:()=>()=>{} }
const props = {mode:'chat' as const,retry:()=>{},onOpenWork:()=>{},transport}
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><div className="chat chat-surface" data-chat-theme={theme} style={{minHeight:'100vh',height:'auto',overflow:'auto'}}><main className="messages" style={{width:'min(900px,100%)',margin:'auto',padding:24,overflow:'visible'}}><p style={{color:'var(--muted)',fontSize:12}}>问题卡片预览 · <a href="?theme=dark">深色</a> / <a href="?theme=light">浅色</a> · 仅测试数据</p><MessageBubble {...props} message={answered}/><MessageBubble {...props} message={pending}/></main></div></PulseDesignSystem>)
