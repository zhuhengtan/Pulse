// Isolated page acceptance: all transport calls stay in fixtures.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { Select } from 'antd'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseButton } from '../src/PulseControls.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { ConversationArtifacts } from '../src/ConversationArtifacts.js'
import { ArchivePage } from '../src/ArchivePage.js'
import { InteractionPanel } from '../src/PulseApp.js'
import { PulseApp } from './RouterApp.js'
import { RunTraceView, type TraceState } from '../src/RunTrace.js'
import { settingsFixture } from './fixtures/settings.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'

const fixture = settingsFixture()
const options = ['设置', '只读设置', '归档', '交付文件', '执行过程', '问答', '审批', '配对', '连接错误']
const trace: TraceState = { order: ['main'], lanes: { main: { id: 'main', label: '检查页面与控件', status: 'running', steps: [
  { id: 'think', kind: 'llm', task: 'reason', modelId: 'sample/chat', reasoning: Array.from({length: 60}, (_, i) => `检查步骤 ${i + 1}：确认页面、输入框与交互布局正常。`).join('\n') },
  ...Array.from({length:40},(_,i)=>({id:`read-${i}`,kind:'tool' as const,tool:'fs.read',status:'succeeded' as const,args:{path:`packages/web/src/example-${i}.tsx`},preview:{output:'示例文件内容'}})),
] } } }
const questions = [
  { effectId: 'choice', input: { type: 'choice', prompt: '请选择界面展示方式', options: ['紧凑显示', '标准显示', '这是一个较长的选项，用于检查自动换行和按钮尺寸'] } },
  { effectId: 'multi', input: { type: 'multi', prompt: '选择需要检查的页面', min: 1, max: 2, options: ['聊天', '工作区', '设置'] } },
  { effectId: 'input', input: { type: 'input', prompt: '补充检查要求', placeholder: '请输入检查要求' } },
]
function Review() {
  const [page, setPage] = useState('设置'), [done, setDone] = useState(false), [result, setResult] = useState('')
  const interaction = { kind: 'interaction' as const, runId: 'page-audit-run', groupId: page, interactionKind: page === '审批' ? 'approval' as const : 'ask' as const, items: page === '审批' ? [{effectId: 'approval', input: { prompt: '是否允许这次示例文件操作？', operationCount: 1, tools: [{toolName: 'fs.write', details: {path: '/example/notes.txt', content: '测试内容'}}] }}] : questions }
  return <PulseDesignSystem><style>{'.page-audit-content{height:calc(100dvh - 48px);overflow:auto}.page-audit-content>.settings-shell{position:relative;inset:auto;height:100%}.page-audit-content .pair-page{min-height:100%;height:auto}.page-audit-content>.archive-shell{height:100%}'}</style><header style={{height:48,display:'flex',alignItems:'center',gap:12,padding:'0 12px'}}><Select aria-label="预览页面" value={page} onChange={setPage} options={options.map(value=>({value,label:value}))} style={{width:140}}/><PulseButton onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}}>切换主题</PulseButton><span role="status">{result}</span></header><div className="page-audit-content">
    {page.endsWith('设置') && <SettingsPage key={page} transport={fixture.transport} canEditConfig={page==='设置'} onClose={()=>setResult('已返回')} onOpenArchive={()=>setPage('归档')}/>}
    {page==='交付文件' && <div className="messages" style={{height:'100%',margin:'auto'}}><ConversationArtifacts conversationId="fixture-conversation" revision="1" transport={fixture.transport}/></div>}
    {page==='归档' && <ArchivePage transport={fixture.transport} onBack={()=>setPage('设置')} onChanged={()=>setResult('归档状态已更新')} onOpen={()=>setResult('已打开示例归档')}/>}
    {page==='执行过程' && <div className="messages" style={{height:'100%',margin:'auto'}}><PulseButton onClick={()=>setDone(!done)}>切换执行完成</PulseButton><RunTraceView trace={done?{...trace,outcome:'succeeded'}:trace} running={!done}/></div>}
    {(page==='问答'||page==='审批') && <div className="composer-wrap" style={{margin:'40px auto',width:'min(900px,100%)'}}><InteractionPanel key={page} interaction={interaction} context="示例项目 · 页面检查" reviewNote="" delegated={false} submit={async()=>{setResult('已提交示例答案');return true}}/></div>}
    {page==='配对' && <SettingsPage transport={fixture.transport} canEditConfig category="devices" onCategoryChange={()=>{}} onClose={()=>setPage('设置')}/>}
    {page==='连接错误' && <PulseApp transport={fixture.transport}/>}
  </div></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Review/> )
