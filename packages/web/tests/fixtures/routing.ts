import { sidebarFixture } from './sidebar.js'
import { settingsFixture } from './settings.js'
import { workbenchFixture } from './workbench.js'
import type { PulseWebTransport, WebConversation } from '../../src/transport.js'

export function routingFixture(options: { canUseTerminal?: boolean } = {}) {
  const sidebar = sidebarFixture(), settings = settingsFixture(), workspace = workbenchFixture()
  const calls: Array<{ path: string; method: string }> = [], subscriptions: string[] = []
  const now = '2026-10-18T00:00:00Z'
  const archived: WebConversation = { id: 'archived', title: '归档测试对话', cwd: '/example/Pulse', projectId: 'pulse', createdAt: now, updatedAt: now, archivedAt: now }
  const { archivedAt: _archivedAt, ...base } = archived
  const created: WebConversation = { ...base, id: 'created', title: '新建测试对话' }
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const transport: PulseWebTransport = {
    async request(path, init) {
      const method = init?.method ?? 'GET'; calls.push({ path, method })
      const url = new URL(path, 'http://fixture.local')
      if (path === '/api/session/local' || path === '/api/session') return response({ localAdmin: true, canUseTerminal: options.canUseTerminal === true })
      if (url.pathname === '/api/pair') return response({ ok: true })
      if (url.pathname === '/api/conversations' && method === 'POST') return response(created)
      if (path === '/api/conversations/created') return response(created)
      if (path === '/api/conversations/archived') return response(archived)
      if (/^\/api\/conversations\/[^/]+$/.test(path) && method === 'GET') return response({ error: 'CONVERSATION_NOT_FOUND' }, 404)
      if (path === '/api/conversations?archived=1') return response([archived])
      if (url.pathname.startsWith('/api/config') || path.includes('/artifacts')) return settings.transport.request(path, init)
      if (path.includes('/messages') && method === 'POST') return response({ runId: 'created-run' })
      if (path.startsWith('/api/web/conversations/') && path.endsWith('/traces')) return response({ traces: [] })
      if (path.startsWith('/api/web/conversations/')) return response([{ id: 'message', role: 'assistant', text: `消息：${path.split('/')[4]}`, createdAt: now }])
      if (path.endsWith('/state')) return response({ runId: 'run-busy', state: 'running', seq: 0, activities: [] })
      if (path.endsWith('/trace')) return response({ events: [], seq: 0 })
      if (path.startsWith('/api/projects/pulse/') || path.startsWith('/api/automation/')) return workspace.transport.request(path, init)
      if (path.startsWith('/api/terminals')) return response(options.canUseTerminal ? [{ id: 'term-1', projectId: 'pulse' }, { id: 'term-2', projectId: 'pulse' }] : [])
      return sidebar.transport.request(path, init)
    },
    subscribe(path) { subscriptions.push(path); return () => {} },
  }
  return { transport, calls, subscriptions, archived }
}
