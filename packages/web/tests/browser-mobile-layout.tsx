// Isolated layout fixture. Safe insets emulate a standalone viewport owner.
import { createRoot } from 'react-dom/client'
import { WorkbenchPanel } from '../src/WorkbenchPanel.js'
import { workbenchFixture, workbenchProject } from './fixtures/workbench.js'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { sidebarFixture } from './fixtures/sidebar.js'
import { hostPathFixture, pathResponse } from './fixtures/host-paths.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light'
if (params.get('safe') === '1') document.documentElement.style.setProperty('--pulse-safe-top', '24px')
const sidebar = sidebarFixture(); const paths = hostPathFixture()
const transport = { ...sidebar.transport, request: (path: string, init?: RequestInit) => {
  if (path === '/api/session') return Promise.resolve(pathResponse({ localAdmin: false, canUseTerminal: false, canBrowseHostPaths: true, canRegisterProject: true }))
  return path.startsWith('/api/host-filesystem/') ? paths.transport.request(path, init) : sidebar.transport.request(path, init)
} }
createRoot(document.getElementById('root')!).render(<PulseDesignSystem>{params.get('view') === 'workbench' ? <main className="shell"><WorkbenchPanel project={workbenchProject} transport={workbenchFixture().transport} localAdmin={false} canUseTerminal={false} tab="files" setTab={() => {}} onClose={() => {}} /></main> : <PulseApp transport={transport} />}</PulseDesignSystem>)
