import { createRoot } from 'react-dom/client'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { RunTraceView, type TraceState } from '../src/RunTrace.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/chat-surface.css'

const trace:TraceState={order:['main'],lanes:{main:{id:'main',label:'主任务',status:'running',steps:[
 {id:'one',kind:'llm',task:'reason',modelId:'fixture',reasoning:'第一步思考正文',note:'Store 文件已核对完整。现在定位其余四个集成点。'},
 {id:'read',kind:'tool',tool:'fs.read',status:'succeeded',args:{path:'prompt.ts'}},
 {id:'two',kind:'llm',task:'reason',modelId:'fixture',reasoning:'下一步思考正文',note:'prompt.ts 已存在全局提示词选项，现在核对接口与 UI。'},
 {id:'pending-body',kind:'llm',task:'verify',modelId:'fixture'},
 {id:'search',kind:'tool',tool:'fs.search',status:'succeeded',args:{query:'resolveSystemPrompt'}},
 {id:'three',kind:'llm',task:'reason',modelId:'fixture',reasoning:'核对用例',note:'接口与 UI 位置已定位，接下来运行验证。'},
 {id:'test',kind:'tool',tool:'shell.exec',status:'running',args:{command:'pnpm',args:['test']}},
]}}}
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><div className="chat chat-surface" data-chat-theme="dark" style={{minHeight:'100vh',display:'block',padding:24}}><main style={{maxWidth:850,margin:'0 auto'}}><h1>执行详情回归预览</h1><p>固定测试数据，不连接后台或调用工具。</p><RunTraceView trace={trace} running compact/></main></div></PulseDesignSystem>)
