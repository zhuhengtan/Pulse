import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
import '../src/workbench-theme.css'

// A standalone visual fixture: every request is synthetic, with no backend or model calls.
const fixture=routingFixture(),original=fixture.transport.request,now=new Date().toISOString(),listeners=new Set<()=>void>()
const question={groupId:'question',kind:'ask' as const,requestedAt:Date.now()-9*60_000,items:[{effectId:'answer',input:{type:'input',prompt:'请确认验收使用的目标环境',context:'实现已保留，等待这项信息后继续验证。'}}]}
const approval={groupId:'approval',kind:'approval' as const,requestedAt:Date.now()-13*60_000,items:[{effectId:'command',input:{tools:[{toolName:'shell.exec',details:{command:'pnpm',args:['exec','vitest','run','tests/example.test.ts']}}]}}]}
let pending=[approval,question].map((item,i)=>({...item,runId:`run-preview-${i}`,conversationId:`preview-${i}`,title:i===0?'验证本地配置接口':'核对目标环境',approvalPolicy:'manual' as const,action:{callbackId:`callback-${i}`,conversationId:`preview-${i}`,runId:`run-preview-${i}`,fingerprint:`preview-${i}`,controlRevision:0,interaction:item}}))
fixture.transport.onChange=listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
fixture.transport.request=(path,init)=>{
  if(path==='/api/assistant')return Promise.resolve(Response.json({conversation:{id:'assistant',title:'Pulse 助理',cwd:'/example',createdAt:now,updatedAt:now},messages:[{id:'intro',role:'assistant',text:'当前有两项需要你处理。可以直接查看和回答，下方卡片不依赖模型生成说明。\n\n这是隔离预览，所有操作仅作用于测试数据。',createdAt:now}],receipts:[],workInteractions:pending}))
  if(path.startsWith('/api/assistant/work/')&&init?.method==='POST'){
    const body=JSON.parse(String(init.body));pending=pending.filter(item=>item.action.callbackId!==body.callbackId);listeners.forEach(listener=>listener());return Promise.resolve(Response.json({ok:true}))
  }
  return original(path,init)
}
const router=createMemoryRouter([{path:'*',element:<PulseApp transport={fixture.transport}/>}],{initialEntries:['/chat']})
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
