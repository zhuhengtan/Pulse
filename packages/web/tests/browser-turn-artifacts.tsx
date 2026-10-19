// All requests stay in this in-memory fixture; no user conversations or models are touched.
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
const fixture = routingFixture(), request = fixture.transport.request
fixture.transport.request = async (path, init) => {
  if (path === '/api/web/conversations/pulse-chat/messages') return Response.json([
    { id: 'u1', role: 'user', text: '帮我整理项目计划。', runId: 'run-1' },
    { id: 'a1', role: 'assistant', text: '已整理第一版计划，包含目标、实施步骤与验收要求。', runId: 'run-1' },
    { id: 'u2', role: 'user', text: '补充移动端验收步骤，再给我一份。', runId: 'run-2' },
    { id: 'a2', role: 'assistant', text: '已补充手机端布局、文件查看和会话切换的验收步骤。修订文件放在本轮回复下方。', runId: 'run-2' },
  ].map(item => ({ ...item, createdAt: '2026-10-19T06:00:00Z' })))
  if (path.includes('/artifacts/content?')) return Response.json({ content: '# 项目计划\n\n本轮交付文件正文。\n\n- 桌面布局\n- 手机布局\n- 会话切换' })
  if (path.includes('/artifacts')) return Response.json([
    { runId: 'run-1', path: 'docs/plans/project-plan.md', absolutePath: '/example/Pulse/.workspaces/conversation/docs/plans/project-plan.md', workspaceState: 'isolated' },
    { runId: 'run-2', path: 'docs/plans/project-plan-mobile-revised-with-a-long-file-name.md', absolutePath: '/example/Pulse/.workspaces/conversation/docs/plans/project-plan-mobile-revised-with-a-long-file-name.md', workspaceState: 'isolated' },
    { runId: 'run-2', path: 'reports/验收清单.md', absolutePath: '/example/Pulse/reports/验收清单.md', workspaceState: 'project' },
  ])
  return request(path, init)
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/work/pulse-chat'] })
const viewport = Number(new URLSearchParams(location.search).get('viewport'))
if (viewport === 390 || viewport === 1280) {
  const frame = document.createElement('iframe'); frame.src = '/tests/turn-artifacts.html'; frame.title = `${viewport}px 交付布局`; frame.width = String(viewport); frame.height = '900'
  const scale = Math.min(1, (innerWidth - 16) / viewport)
  frame.style.cssText = `border:0;transform:scale(${scale});transform-origin:top left;flex:none`
  document.body.style.cssText = 'display:flex;justify-content:center;overflow:auto;background:#e8eaf0'
  const wrapper = document.createElement('div'); wrapper.style.cssText = `width:${viewport * scale}px;height:${900 * scale}px;flex:none`; wrapper.append(frame)
  document.getElementById('root')!.remove(); document.body.append(wrapper)
} else createRoot(document.getElementById('root')!).render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
