// Isolated acceptance page: controls never call the daily Pulse service.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseButton } from '../src/PulseControls.js'
import { WorkbenchPanel } from '../src/WorkbenchPanel.js'
import { workbenchFixture, workbenchProject } from './fixtures/workbench.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
const fixture = workbenchFixture()
function Review() {
  const [tab, setTab] = useState<'files' | 'git' | 'preview' | 'terminal' | 'automation'>('files')
  return <PulseDesignSystem><header style={{height:40,display:'flex',alignItems:'center',gap:16,padding:'0 16px'}}><span>工作区组件预览 · 独立测试数据</span><PulseButton onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>切换主题</PulseButton></header><main className="shell" style={{height:'calc(100dvh - 40px)',justifyContent:'flex-end'}}><WorkbenchPanel project={workbenchProject} transport={fixture.transport} localAdmin canUseTerminal={false} tab={tab} setTab={setTab} onClose={()=>{}} /></main></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Review />)
