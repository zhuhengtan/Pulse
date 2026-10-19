// Independent fixture: every API call stays in memory, including resume/end.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseButton } from '../src/PulseControls.js'
import { routingFixture } from './fixtures/routing.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'trace'
const fixture = routingFixture(), request = fixture.transport.request
let resumeReply: ((response: Response) => void) | undefined
let update: (text: string) => void = () => {}
fixture.transport.request = (path, init) => {
  if (path === '/api/runs/run-busy/state') return Promise.resolve(Response.json({ runId: 'run-busy', state: 'interrupted', seq: 0, activities: [] }, { status: scenario === 'unknown' ? 503 : 200 }))
  if (path === '/api/web/conversations/busy/messages') return Promise.resolve(Response.json(scenario === 'empty' ? [] : [{ id: 'preview-message', runId: 'run-busy', role: 'assistant', text: '消息列表已包含执行记录。任务中断后，可以在这里继续处理。', createdAt: new Date().toISOString() }]))
  if (path === '/api/web/conversations/busy/traces') return Promise.resolve(Response.json({ traces: scenario === 'empty' ? [] : [{ runId: 'run-busy', events: [
    { type: 'lanes', runId: 'run-busy', seq: 1, data: { available: true, lanes: [{ id: 'main', label: '主任务', status: 'waiting' }] } },
    { type: 'trace', runId: 'run-busy', seq: 2, data: { kind: 'model', laneId: 'main', effectId: 'model-1', attemptId: 'a1', attemptNo: 1, modelId: '模拟模型', task: 'reason' } },
  ] }] }))
  if (path.endsWith('/runs/run-busy/resume')) { update('模拟恢复请求已收到，正在等待响应'); return new Promise(resolve => { resumeReply = resolve }) }
  if (path.endsWith('/runs/run-busy/reconcile')) { update('模拟结束成功，原记录已保留'); return Promise.resolve(Response.json({ cleared: true })) }
  return request(path, init)
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/work/busy?task=1&lane=main'] })
function Preview() {
  const [result, setResult] = useState('隔离测试，不连接真实会话或模型'); update = setResult
  return <PulseDesignSystem><div className="recovery-preview"><div className="recovery-preview-app"><RouterProvider router={router}/></div><div className="recovery-preview-controls"><output>{result}</output><PulseButton type="button" onClick={() => { resumeReply?.(Response.json({ error: 'SIMULATED_OFFLINE' }, { status: 503 })); update('模拟恢复失败，操作按钮应恢复可用') }}>模拟失败</PulseButton><PulseButton type="button" onClick={() => { resumeReply?.(Response.json({ runId: 'run-next' })); update('模拟恢复成功，恢复卡片应消失') }}>模拟成功</PulseButton><PulseButton type="button" onClick={() => void router.navigate('/work/pulse-chat')}>切换对话</PulseButton></div></div></PulseDesignSystem>
}
const style = document.createElement('style')
style.textContent = '.recovery-preview{height:100dvh;display:flex;flex-direction:column}.recovery-preview-app{flex:1;min-height:0;position:relative}.recovery-preview-app .shell{height:100%;min-height:0}.recovery-preview-controls{flex:none;display:flex;align-items:center;gap:4px;overflow-x:auto;padding:4px;background:var(--surface-raised);border-top:1px solid var(--line);font-size:11px}.recovery-preview-controls output{min-width:100px;color:var(--muted)}.recovery-preview-controls button{white-space:nowrap;flex:none}'
document.head.appendChild(style)
createRoot(document.getElementById('root')!).render(<Preview/> )
