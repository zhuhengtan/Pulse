// Isolated layout fixture. Safe insets emulate a standalone viewport owner.
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp as RoutedPulseApp } from '../src/PulseApp.js'
import { WorkbenchPanel } from '../src/WorkbenchPanel.js'
import { workbenchFixture, workbenchProject } from './fixtures/workbench.js'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { sidebarFixture } from './fixtures/sidebar.js'
import { routingFixture } from './fixtures/routing.js'
import { hostPathFixture, pathResponse } from './fixtures/host-paths.js'
import { RunTraceView, type TraceState } from '../src/RunTrace.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light'
if (params.get('safe') === '1') document.documentElement.style.setProperty('--pulse-safe-top', '24px')
const sidebar = sidebarFixture(); const paths = hostPathFixture()
const reasoning = 'The report docs/GDD设计评估报告.md was written. I need to verify the content against each evaluation dimension and confirm the source references.\n\n'
  + '/example/Pulse/'.repeat(35) + '\n\n' + '检查长中文内容能否在当前可用宽度内自然换行。'.repeat(35)
const trace: TraceState = {
  order: ['main', 'child'],
  lanes: {
    main: { id: 'main', label: '主任务', status: 'running', goal: '验证长路径和思考内容的移动端换行', steps: [
      { id: 'tool', kind: 'tool', tool: 'fs.read', status: 'succeeded', args: { path: '/example/Pulse/docs/design/evaluation/references/very-long-directory-name/GDD设计评估报告.md' } },
      { id: 'reasoning', kind: 'llm', task: 'reason', reasoning },
    ] },
    child: { id: 'child', parentId: 'main', label: '子任务', status: 'running', steps: [{ id: 'child-reasoning', kind: 'llm', task: 'reason', reasoning }] },
  },
}
const transport = { ...sidebar.transport, request: (path: string, init?: RequestInit) => {
  if (path === '/api/session') return Promise.resolve(pathResponse({ localAdmin: false, canUseTerminal: false, canBrowseHostPaths: true, canRegisterProject: true }))
  return path.startsWith('/api/host-filesystem/') ? paths.transport.request(path, init) : sidebar.transport.request(path, init)
} }
const detailsRouter = params.get('view') === 'details' ? createMemoryRouter([{ path: '*', element: <RoutedPulseApp transport={routingFixture().transport}/> }], { initialEntries: ['/work/pulse-chat?details=1'] }) : undefined
createRoot(document.getElementById('root')!).render(<PulseDesignSystem>{detailsRouter ? <RouterProvider router={detailsRouter}/> : params.get('view') === 'trace' ? <main className="shell"><div className="chat"><header className="navbar surface-work">移动端执行过程验收</header><section className="messages"><RunTraceView trace={trace} running /></section></div></main> : params.get('view') === 'workbench' ? <main className="shell"><WorkbenchPanel project={workbenchProject} transport={workbenchFixture().transport} localAdmin={false} canUseTerminal={false} tab="files" setTab={() => {}} onClose={() => {}} /></main> : <PulseApp transport={transport} />}</PulseDesignSystem>)
