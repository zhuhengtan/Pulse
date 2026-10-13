// Isolated acceptance page: every request stays in the fixture transport.
import { createRoot } from 'react-dom/client'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { sidebarFixture } from './fixtures/sidebar.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'

const fixture = sidebarFixture()
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><div className="sidebar-acceptance-controls"><span>侧边栏预览 · 独立测试数据</span><button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>切换主题</button></div><div style={{ height: 'calc(100dvh - 40px)' }}><PulseApp transport={fixture.transport}/></div></PulseDesignSystem>)
