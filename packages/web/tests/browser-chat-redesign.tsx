/** Entirely synthetic, isolated transport and IndexedDB scope; never contacts a model or H5 service. */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { IndexedMessageQueueStore, MessageQueueController } from '../src/MessageQueue.js'
import { followupFixture } from './fixtures/followup.js'
import type { PendingInteraction } from '../src/InteractionPanel.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
const params = new URLSearchParams(location.search), state = params.get('state') ?? 'running', surface = params.get('surface') === 'chat' ? 'chat' : 'work'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme
const fixture = followupFixture(surface, state === 'question'), original = fixture.transport.request
const scope = `chat-redesign-${surface}-${state}`, runId = fixture.conversation.activeRunId!
let decided = false, cancelCount = 0, releaseCancel: (() => void) | undefined
const setResult = { current: (_message: string) => {} }
const items: PendingInteraction['items'] = state === 'question' ? [
  { effectId: 'layout', input: { type: 'choice', prompt: '队列消息采用哪种展示方式？', context: '当前运行会继续保留，选择只影响界面。', options: [{ value: 'compact', label: '紧凑消息行', description: '默认显示三条，其余展开查看。' }, { value: 'all', label: '全部展开', description: '同时展示完整待发列表。' }] } },
  { effectId: 'coverage', input: { type: 'multi', prompt: '需要验证哪些界面？', min: 1, options: ['桌面', '手机', '深色主题'] } },
  { effectId: 'note', input: { type: 'input', prompt: '还有哪些需要注意的地方？', placeholder: '补充要求…' } },
] : [{ effectId: 'command', input: { prompt: '需要运行项目测试，检查这次改动是否影响已有功能。', operationCount: 1, tools: [{ toolName: 'shell.exec', details: { command: 'pnpm', args: ['--filter', '@hunterzhu/pulse-web', 'test'], cwd: '/example/Pulse' } }] } }]
const awaiting = state === 'approval' || state === 'question'
fixture.transport.request = async (path, init) => {
  if (path === '/api/session') return Response.json({ queueScope: scope, localAdmin: true })
  if (path.endsWith('/state') && awaiting && !decided && fixture.conversation.activeRunId) {
    return Response.json({ runId, state: 'running', seq: 0, activities: [], interactions: [{ groupId: 'preview-interaction', kind: state === 'question' ? 'ask' : 'approval', items }] })
  }
  if (path.endsWith('/replies')) { decided = true; setResult.current('提交已确认，队列保持独立。') }
  if (path.endsWith('/cancel')) {
    cancelCount++
    if (state === 'stop-failure' && cancelCount === 1) { setResult.current('模拟停止请求失败'); return Response.json({ error: 'OFFLINE' }, { status: 503 }) }
    if (state === 'stopping') { setResult.current('停止请求已发送，等待确认'); await new Promise<void>(resolve => { releaseCancel = resolve }) }
  }
  if (path.endsWith('/messages') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)); setResult.current(body.delivery === 'immediate' ? '即时输入已交给模型；原任务继续运行。' : '下一轮消息已接收。')
  }
  const response = await original(path, init)
  if (path.endsWith('/messages') && !init?.method || path === '/api/assistant') {
    const data = await response.json(), messages = Array.isArray(data) ? data : data.messages
    const sample = { id: 'preview-progress', role: 'assistant', text: '已确认聊天区域的入口。接下来统一输入框、队列与审批卡片，并验证停止后的消息保留。\n\n发送补充内容时，可以选择排队等待下一轮，也可以立即交给模型判断。', runId, createdAt: fixture.conversation.createdAt }
    return Response.json(Array.isArray(data) ? [...messages, sample] : { ...data, messages: [...messages, sample] })
  }
  return response
}
if (state === 'idle') fixture.finish()
if (state === 'queue' || state === 'approval') {
  const store = new IndexedMessageQueueStore()
  const seed = new MessageQueueController(scope, store, { inspect: async () => ({ waiting: true }), send: async () => ({ runId }) }, () => {})
  if (!(await store.list(scope)).some(queue => queue.entries.length)) {
    for (const text of ['完成后检查手机端布局', '保留现有的附件和文件引用', '补充深色主题截图', '再检查停止失败后的重试', '最后运行类型检查']) await seed.enqueue(fixture.conversation.id, surface, { text }, runId)
  }
  seed.close()
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [surface === 'chat' ? '/chat' : '/work/busy'] })
function Preview() {
  const [result, update] = useState('隔离预览 · 不调用真实服务'); setResult.current = update
  return <PulseDesignSystem><style>{'#chat-preview .shell { height:100%; min-height:0; }'}</style><div id="chat-preview" style={{ display: 'grid', gridTemplateRows: '36px minmax(0,1fr)', height: '100dvh' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 10px', background: theme === 'dark' ? '#242424' : '#f5f5f5', fontSize: 11, overflow: 'auto', whiteSpace: 'nowrap' }}>
      <label>状态 <select aria-label="预览状态" value={state} onChange={event => { params.set('state', event.target.value); location.search = params.toString() }}>{['idle','running','queue','approval','question','stopping','stop-failure'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>主题 <select aria-label="预览主题" value={theme} onChange={event => { params.set('theme', event.target.value); location.search = params.toString() }}><option>light</option><option>dark</option></select></label>
      <button onClick={() => { fixture.finish(); update('当前运行已完成，队列逐条发送。') }}>完成当前运行</button>
      {state === 'stopping' && <button onClick={() => releaseCancel?.()}>确认停止</button>}
      <output>{result}</output>
    </div><RouterProvider router={router}/>
  </div></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
