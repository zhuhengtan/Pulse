import type { PulseWebTransport, WebProject } from '../../src/transport.js'
export const workbenchProject: WebProject = { id: 'pulse', name: 'Pulse', cwd: '/example/Pulse', pinned: true, available: true, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' }
export function workbenchFixture(readOnly = false) {
  const requests: Array<{ path: string; method: string }> = []
  let automationSession = { id: 'browser-1', kind: 'browser', state: 'ai', title: 'Existing document', actionCount: 0 }
  const entry = (name: string, path: string, type: string) => ({ name, path, type, size: 128, modifiedAt: '2026-10-18T00:00:00Z' })
  const transport: PulseWebTransport = {
    async request(path, init) {
      requests.push({ path, method: init?.method ?? 'GET' })
      const url = new URL(path, 'http://fixture.local')
      let value: unknown = { error: 'FIXTURE_ROUTE_NOT_FOUND' }, status = 200
      if (url.pathname.endsWith('/files')) value = { path: url.searchParams.get('path'), entries: url.searchParams.get('path') === 'docs' ? [entry('plan.md', 'docs/plan.md', 'file')] : [entry('docs', 'docs', 'directory'), entry('packages', 'packages', 'directory'), entry('README.md', 'README.md', 'file')] }
      else if (url.pathname.endsWith('/file')) value = { path: url.searchParams.get('path'), binary: false, size: 128, totalLines: 1, content: 'Verified workspace document' }
      else if (url.pathname.endsWith('/git/status')) value = { isGit: true, branch: 'main', entries: [{ index: ' ', worktree: 'M', path: 'packages/runtime/src/dsl/program.ts' }, { index: 'A', worktree: ' ', path: 'staged.ts' }, { index: 'M', worktree: 'M', path: 'both.ts' }, { index: '?', worktree: '?', path: 'new.ts' }] }
      else if (url.pathname.endsWith('/git/diff')) value = { diff: '+verified diff' }
      else if (url.pathname === '/api/projects/pulse' && init?.method === 'PATCH') value = { ...workbenchProject, previewUrl: JSON.parse(String(init.body)).previewUrl }
      else if (url.pathname.endsWith('/preview-ticket')) value = { url: 'about:blank' }
      else if (url.pathname === '/api/automation/sessions') value = { sessions: [automationSession], enabled: ['browser', 'computer'], approvalMode: readOnly ? 'read-only' : 'ask' }
      else if (url.pathname.endsWith('/control')) { const action = JSON.parse(String(init?.body)).action; automationSession = { ...automationSession, state: action === 'takeover' ? 'human' : action === 'pause' ? 'paused' : 'ai' }; value = { ...automationSession, ...(action === 'takeover' ? { lease: 'fixture-lease' } : {}) } }
      else if (url.pathname.endsWith('/observe')) value = { ...automationSession, frameId: 'fixture-frame' }
      else if (url.pathname.endsWith('/frame')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#dfe7ff"/><text x="20" y="60" fill="#222">Fixture browser frame</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } })
      else if (url.pathname === '/api/automation/doctor') value = { browser: { installed: true }, desktop: { installed: false } }
      else if (url.pathname === '/api/devices') value = [{ id: 'phone', name: 'Test phone', automationControl: false }]
      else if (url.pathname === '/api/conversations') value = [{ id: 'archived', title: 'Archived conversation', cwd: '/example', createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' }]
      else if (init?.method === 'DELETE') value = { ok: true }
      else status = 404
      return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    },
    subscribe: () => () => {},
  }
  return { transport, requests }
}
