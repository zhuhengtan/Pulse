import type { HostPathEntry, HostPathListing } from '@hunterzhu/pulse-server/protocol'
import type { PulseWebTransport } from '../../src/transport.js'
export const pathResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
export function hostPathFixture() {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const made: string[] = []
  let entries: HostPathEntry[] = [{ name: '中文 项目', path: '/host/中文 项目', kind: 'directory' }, { name: 'note.txt', path: '/host/note.txt', kind: 'file' }, { name: 'broken', path: '/host/broken', kind: 'file', unavailable: 'HOST_PATH_NOT_FOUND' }]
  const listing = (path: string, children = entries): HostPathListing => ({ path, name: path.split('/').at(-1)!, parent: path === '/' ? null : '/', breadcrumbs: [{ name: '/', path: '/' }, ...(path === '/' ? [] : [{ name: path.slice(1), path }])], entries: children, nextOffset: null })
  const transport: PulseWebTransport = {
    async request(path, init) {
      calls.push({ path, ...(init ? { init } : {}) })
      if (path === '/api/host-filesystem/roots') return pathResponse({ home: '/host', roots: [{ name: '/', path: '/' }] })
      if (path.startsWith('/api/host-filesystem/entries?')) {
        const params = new URLSearchParams(path.split('?')[1]); const input = params.get('path')!
        if (input === '/forbidden') return pathResponse({ error: 'HOST_PATH_FORBIDDEN' }, 403)
        if (input === '/missing') return pathResponse({ error: 'HOST_PATH_NOT_FOUND' }, 404)
        return pathResponse(listing(input, input === '/host' ? [...entries, ...(params.get('hidden') === '1' ? [{ name: '.hidden', path: '/host/.hidden', kind: 'file' as const }] : [])] : []))
      }
      if (path === '/api/host-filesystem/directories') {
        const body = JSON.parse(String(init?.body)) as { parentPath: string; name: string }
        if (body.name === 'exists') return pathResponse({ error: 'HOST_PATH_EXISTS' }, 409)
        const created = `${body.parentPath}/${body.name}`; made.push(created); return pathResponse({ path: created, kind: 'directory' }, 201)
      }
      return pathResponse({ error: 'NOT_FOUND' }, 404)
    }, subscribe: () => () => {},
  }
  return { transport, calls, made, listing, setEntries: (value: HostPathEntry[]) => { entries = value } }
}
