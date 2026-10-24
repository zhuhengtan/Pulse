import type { PulseWebTransport, WebConversation, WebProject } from '../../src/transport.js'

export function sidebarFixture() {
  const now = new Date().toISOString()
  const projects: WebProject[] = [
    { id: 'pulse', name: 'Pulse', cwd: '/example/Pulse', pinned: true, available: true, createdAt: now, updatedAt: now },
    { id: 'jarvis', name: 'Jarvis', cwd: '/example/Jarvis', pinned: false, available: true, createdAt: now, updatedAt: now },
  ]
  let conversations: WebConversation[] = [
    { id: 'old', title: '这个项目还是需要帮我加个自动审核', cwd: '/example', createdAt: now, updatedAt: now },
    { id: 'pulse-chat', title: '优化侧边栏和主题', cwd: projects[0]!.cwd, projectId: 'pulse', pinned: true, createdAt: now, updatedAt: now },
    { id: 'jarvis-chat', title: '完善项目记忆', cwd: projects[1]!.cwd, projectId: 'jarvis', createdAt: now, updatedAt: now },
    { id: 'busy', title: '正在执行的任务', cwd: projects[1]!.cwd, projectId: 'jarvis', activeRunId: 'run-busy', createdAt: now, updatedAt: now },
  ]
  const projectEdits: Array<{ id: string; body: Record<string, unknown> }> = []
  const projectOrders: string[][] = []
  const patches: Array<{ id: string; body: Record<string, unknown> }> = []
  let rejectMove = false
  let approvalPolicy: 'manual' | 'delegate' = 'manual'
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const transport: PulseWebTransport = {
    async request(path, init) {
      if (path === '/api/approval-policy') {
        if (init?.method === 'PUT') approvalPolicy = JSON.parse(String(init.body)).policy
        return response({ policy: approvalPolicy })
      }
      if (path === '/api/session/local' || path === '/api/session') return response({ localAdmin: true, canUseTerminal: false })
      if (path === '/api/assistant') return response({ conversation: { id: 'assistant', title: 'Pulse 助理', cwd: '/example', createdAt: now, updatedAt: now }, messages: [], receipts: [], workInteractions: [] })
      if (path === '/api/projects/order') {
        const ids = JSON.parse(String(init?.body)).ids as string[]; projectOrders.push(ids)
        projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return response({ ok: true })
      }
      if (/^\/api\/projects\/[^/]+$/.test(path) && init?.method === 'PATCH') {
        const id = path.split('/').at(-1)!, body = JSON.parse(String(init.body)); projectEdits.push({ id, body })
        const index = projects.findIndex(project => project.id === id)
        projects[index] = { ...projects[index]!, ...body }
        return response(projects[index])
      }
      if (path === '/api/projects') return response(projects)
      if (path === '/api/conversations') return response(conversations)
      if (path.endsWith('/messages')) return response([{ id: 'message', role: 'assistant', text: '对话内容会保留，所属项目可以随时调整。', createdAt: now }])
      if (path === '/api/config') return response({ active: { provider: 'mock', model: 'preview' } })
      if (path.startsWith('/api/conversations/') && init?.method === 'PATCH') {
        const id = decodeURIComponent(path.split('/').at(-1)!)
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        patches.push({ id, body })
        if (rejectMove) return response({ error: 'CONVERSATION_BUSY' }, 409)
        conversations = conversations.map(item => {
          if (item.id !== id) return item
          const { projectId: previous, ...rest } = item
          const projectId = Object.hasOwn(body, 'projectId') ? body.projectId as string | null : previous
          const project = projects.find(value => value.id === projectId)
          return { ...rest, ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}), ...(projectId ? { projectId } : {}), cwd: project?.cwd ?? item.cwd }
        })
        return response(conversations.find(item => item.id === id))
      }
      return response({ error: 'FIXTURE_ROUTE_NOT_FOUND' }, 404)
    },
    subscribe: () => () => {},
  }
  return { transport, patches, projectEdits, projectOrders, rejectMove: () => { rejectMove = true } }
}
