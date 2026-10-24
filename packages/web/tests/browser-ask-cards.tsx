/** Isolated UI verification; all network responses below are synthetic. */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { followupFixture } from './fixtures/followup.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'

const params = new URLSearchParams(location.search), kind = params.get('kind') ?? 'choice'
document.documentElement.dataset.theme = params.get('theme') ?? 'light'
window.pulseDesktop = { nativeBrowser: true } as NonNullable<typeof window.pulseDesktop>
const fixture = followupFixture('work', true), request = fixture.transport.request
const path = 'docs/plans/rate-limit-and-export-plan.md', runId = fixture.conversation.activeRunId!
let answered = false
const status = { set: (_value: string) => {} }
fixture.transport.request = async (url, init) => {
  if (url === '/api/session') return Response.json({ localAdmin: true, queueScope: `ask-cards-${kind}` })
  if (url === '/api/automation/sessions') return Response.json({ sessions: [{ id: 'existing-browser', kind: 'browser', mode: 'native', state: 'ai', owner: 'run:existing', conversationId: 'busy' }] })
  if (url.endsWith('/state') && !answered) return Response.json({ runId, state: 'running', seq: 0, activities: [], interactions: [{ kind: 'ask', groupId: `ask-cards-${kind}`, items: [{ effectId: 'plan', input: { kind: 'ask', type: kind, planPath: path, prompt: `请审阅已保存的计划 ${path}，是否执行？`, options: [{ label: '暂不执行', value: 'defer' }, { label: '执行', value: 'execute' }], min: 1 } }] }] })
  if (url.includes('/artifacts/raw?')) return new Response('# 请求限流与导出计划\n\n## 实现范围\n\n- 为审计服务增加请求限流。\n- 将审计日志导出为 CSV。\n\n## 验证\n\n运行现有测试，保留配置和用户数据。', { headers: { 'Content-Type': 'text/markdown' } })
  if (url.endsWith('/replies')) { answered = true; const body = JSON.parse(String(init?.body)); status.set(body.answers?.every((item: any) => item.value.dismissed === true) ? '未作答，卡片已关闭。' : '回答已提交。') }
  return request(url, init)
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/work/busy'] })
function Preview() {
  const [message, setMessage] = useState('界面验证 · 合成会话'); status.set = setMessage
  return <PulseDesignSystem><div style={{ height: '100dvh', display: 'grid', gridTemplateRows: '28px minmax(0,1fr)' }}><output style={{ padding: '4px 12px', fontSize: 12 }}>{message}</output><div style={{ minHeight: 0 }}><style>{'.shell { height:100%; min-height:0; }'}</style><RouterProvider router={router}/></div></div></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Preview />)
