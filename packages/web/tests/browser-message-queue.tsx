import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { followupFixture } from './fixtures/followup.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'

const params = new URLSearchParams(location.search), surface = params.get('surface') === 'chat' ? 'chat' : 'work'
const fixture = followupFixture(surface, params.get('ask') === '1')
if (surface === 'chat' && params.get('demo') === 'bubbles') {
  const request = fixture.transport.request, now = new Date().toISOString()
  fixture.transport.request = async (path, init) => {
    if (path === '/api/assistant') {
      const view = await (await request(path, init)).json()
      return Response.json({ ...view, messages: [
        { id: 'demo-user', role: 'user', text: '帮我检查一下工作任务的结果。', createdAt: now },
        { id: 'demo-ack', role: 'assistant', text: '我先看看结果。', messageKind: 'pre_reply', createdAt: now },
        { id: 'demo-work', role: 'assistant', text: '检查已经完成，报告需要保存到项目里。你确认后我再继续。', createdAt: now, work: { conversationId: 'demo-work', title: '检查任务', state: 'waiting' }, workAction: { callbackId: 'demo-callback', conversationId: 'demo-work', runId: 'demo-work-run', controlRevision: 0, fingerprint: 'demo-only', interaction: { groupId: 'demo-confirm', kind: 'approval', items: [{ effectId: 'demo-effect', input: { tools: [{ toolName: 'fs.write', details: { path: 'report.md' } }] } }] } } },
        { id: 'demo-followup', role: 'user', text: '对了，报告里也说明一下还有哪些待办。', createdAt: now },
      ] })
    }
    if (path === '/api/assistant/work/demo-work/replies') return Response.json({ ok: true })
    return request(path, init)
  }
}
if (params.get('admin') === '0') { const request = fixture.transport.request; fixture.transport.request = (path, init) => path === '/api/session' ? Promise.resolve(Response.json({ queueScope: `followup-fixture-${surface}`, localAdmin: false })) : request(path, init) }
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport} /> }], { initialEntries: [surface === 'chat' ? '/chat' : '/work/busy'] })
Object.assign(window, { followupFixture: fixture, followupRouter: router })
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><RouterProvider router={router} /></PulseDesignSystem>)
