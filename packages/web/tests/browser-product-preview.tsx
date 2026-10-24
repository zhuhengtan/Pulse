/** Product screenshot fixture: real components, synthetic transport, no credentials or model calls. */
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { followupFixture } from './fixtures/followup.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
document.documentElement.dataset.theme = 'light'
const fixture = followupFixture('work', true), baseRequest = fixture.transport.request
fixture.conversation.title = '审计服务 · 请求限流与导出'
fixture.conversation.projectId = 'pulse'
const path = 'docs/plans/rate-limit-and-export-plan.md', runId = fixture.conversation.activeRunId!
fixture.transport.request = async (url, init) => {
  if (url === '/api/session') return Response.json({ localAdmin: true, queueScope: 'product-demo' })
  if (/\/artifacts(?:\?|$)/.test(url)) return Response.json([])
  if (url.includes('/messages') && (!init?.method || init.method === 'GET')) return Response.json([{ id: 'request', role: 'user', text: '为审计服务补充请求限流和 CSV 导出。先整理实现计划，我确认后再开始。', createdAt: '2026-10-24T06:30:00Z' }])
  if (url.endsWith('/state')) return Response.json({ runId, state: 'running', seq: 0, activities: [], interactions: [{ kind: 'ask', groupId: 'plan', items: [{ effectId: 'plan', input: { kind: 'ask', type: 'choice', planPath: path, prompt: `请审阅已保存的计划 ${path}，是否执行？`, options: [{ label: '执行', value: 'execute', description: '按已确认的范围开始实现，并运行验证。' }, { label: '暂不执行', value: 'defer', description: '保留当前计划，稍后再继续。' }] } }] }] })
  if (url.includes('/artifacts/raw?')) return new Response('# 请求限流与导出计划\n\n## 实现范围\n\n- 增加按时间窗口计数的请求限流。\n- 支持将审计记录导出为 CSV。\n- 保留已有 API 和测试用例。\n\n## 验证与交付\n\n补充边界用例，运行测试，再整理修改内容与验证结果。\n\n## 等待你的确认\n\n确认计划后开始实现。', { headers: { 'Content-Type': 'text/markdown' } })
  return baseRequest(url, init)
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [`/work/busy?workspace=preview&artifact=${encodeURIComponent(path)}&artifactRun=${runId}`] })
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
