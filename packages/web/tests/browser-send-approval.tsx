// Isolated mobile HTTP acceptance. No request is sent to a real Pulse service.
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
const approval = new URLSearchParams(location.search).get('mode') === 'approval'
const fixture = routingFixture(), original = fixture.transport.request
let release: ((response: Response) => void) | undefined
let body: Record<string, unknown> = {}
let setResult: (value: string) => void = () => {}
let decided = false
fixture.transport.request = (path, init) => {
  if (path.endsWith('/messages') && init?.method === 'POST') {
    body = JSON.parse(String(init.body))
    setResult('消息已乐观显示；正在等待模拟服务器')
    return new Promise(resolve => { release = resolve })
  }
  if (approval && path.endsWith('/state')) return Promise.resolve(Response.json({ runId: 'run-busy', state: 'running', seq: 0, activities: [], reviewNote: '需要你决定；代审无法确认本次操作。', interactions: decided ? [] : [{ kind: 'approval', groupId: 'mobile-approval', items: [{ effectId: 'mobile-effect', input: { prompt: '以下仅为隔离界面测试，不执行电脑操作。', operationCount: 2, tools: [{ toolName: 'shell.exec', details: { command: 'git', args: ['status', '--short'] } }, { toolName: 'fs.list', details: { path: '.' } }] } }] }] }))
  if (path.endsWith('/replies')) {
    const value = JSON.parse(String(init?.body))
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(value.requestId)) return Promise.resolve(Response.json({ error: 'INVALID_REQUEST_ID' }, { status: 400 }))
    decided = true; setResult(value.answers[0].value.approved ? '模拟审批已提交：允许本次' : '模拟审批已提交：拒绝')
    return Promise.resolve(Response.json({ ok: true }))
  }
  return original(path, init)
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [approval ? '/work/busy' : '/chat'] })
function Review() {
  const [result, updateResult] = useState('独立测试数据，不会调用真实模型'); setResult = updateResult
  return <PulseDesignSystem><div className="mobile-acceptance-controls" style={{ position: 'fixed', zIndex: 100, top: 54, left: 0, right: 0, display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, background: 'var(--surface-subtle)', borderBottom: '1px solid var(--line)' }}><output role="status">{result}</output><small>安全上下文：{String(window.isSecureContext)}；randomUUID：{typeof globalThis.crypto?.randomUUID}</small>{!approval && <><PulseButton type="button" onClick={() => { release?.(Response.json({ error: 'OFFLINE' }, { status: 503 })); setResult('模拟发送失败，检查草稿恢复') }}>模拟发送失败</PulseButton><PulseButton type="button" onClick={() => { release?.(Response.json({ conversationId: 'assistant', messageId: body.requestId, runId: 'run-fixture', state: 'queued' })); setResult('模拟服务器已接受消息') }}>模拟接收成功</PulseButton></>}</div><RouterProvider router={router}/></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Review/> )
