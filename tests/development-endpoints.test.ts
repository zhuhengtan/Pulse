import { afterEach, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { developmentPortAvailable, selectDevelopmentBackendPort, selectDevelopmentFrontend } from '../scripts/desktop/development-endpoints.mjs'
import { verifyDevelopmentBackend } from '../scripts/desktop/restart-backend.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { port, origin: `http://127.0.0.1:${port}` }
}
function vite(workspace: string, backend: string) {
  return (req: IncomingMessage, res: ServerResponse) => res.end(req.url === '/__pulse_dev' ? JSON.stringify({ workspace, backend }) : 'const connection = new WebSocket("ws://fixture");')
}

it('reuses only a Vite for the same workspace and actual backend, preserving the selected page', async () => {
  const backend = 'http://127.0.0.1:60065'
  const frontend = await serve(vite(repo, backend))
  const url = frontend.origin + '/settings/desktop?test=1#fragment'
  expect(await selectDevelopmentFrontend({ repo, url, backend })).toBe(url)
})
it('automatically leaves a stale proxy running and chooses a free frontend port', async () => {
  const stale = await serve(vite(repo, 'http://127.0.0.1:7333'))
  const url = stale.origin + '/work/new?keep=1#preview'
  const selected = await selectDevelopmentFrontend({ repo, url, backend: 'http://127.0.0.1:60065', attempts: 4 })
  expect(new URL(selected).port).not.toBe(String(stale.port))
  expect(new URL(selected).pathname + new URL(selected).search + new URL(selected).hash).toBe('/work/new?keep=1#preview')
  expect(await fetch(stale.origin + '/__pulse_dev').then(r => r.json())).toMatchObject({ backend: 'http://127.0.0.1:7333' })
  expect(await developmentPortAvailable(Number(new URL(selected).port))).toBe(true)
})
it('prefers a matching existing Vite over an earlier free port', async () => {
  const backend = 'http://127.0.0.1:60065', frontend = await serve(vite(repo, backend))
  expect(await selectDevelopmentFrontend({ repo, url: `http://127.0.0.1:${frontend.port - 1}/work/new`, backend, attempts: 2 })).toBe(frontend.origin + '/work/new')
})
it('never reuses a different workspace even if its backend matches', async () => {
  const backend = 'http://127.0.0.1:60065', frontend = await serve(vite('/not-this-workspace', backend))
  const selected = await selectDevelopmentFrontend({ repo, url: frontend.origin, backend, attempts: 4 })
  expect(new URL(selected).port).not.toBe(String(frontend.port))
})
it('preserves strict explicitly requested frontend ports', async () => {
  const frontend = await serve(vite(repo, 'http://127.0.0.1:1'))
  await expect(selectDevelopmentFrontend({ repo, url: frontend.origin, backend: 'http://127.0.0.1:2', explicit: true })).rejects.toThrow('指定的前端端口')
  expect(await fetch(frontend.origin).then(r => r.ok)).toBe(true)
})
it('does not follow redirects from an unrelated listener', async () => {
  let visits = 0
  const destination = await serve((_req, res) => { visits++; res.end('not Vite') })
  const redirect = await serve((_req, res) => res.writeHead(302, { Location: destination.origin }).end())
  await selectDevelopmentFrontend({ repo, url: redirect.origin, backend: 'http://127.0.0.1:2', attempts: 3 })
  expect(visits).toBe(0)
})
it('skips unrelated backend listeners automatically but leaves explicit collisions as errors', async () => {
  const unrelated = await serve((_req, res) => res.end('keep running'))
  expect(await selectDevelopmentBackendPort(unrelated.port)).not.toBe(unrelated.port)
  await expect(selectDevelopmentBackendPort(unrelated.port, true)).rejects.toThrow('PULSE_WEB_DEV_PORT')
  expect(await fetch(unrelated.origin).then(r => r.text())).toBe('keep running')
})
it('never selects the production port or the actual backend port as a frontend', async () => {
  await expect(selectDevelopmentFrontend({ repo, url: 'http://127.0.0.1:7332/work/new', backend: 'http://127.0.0.1:60065', explicit: true })).rejects.toThrow()
  await expect(selectDevelopmentFrontend({ repo, url: 'http://127.0.0.1:60065/work/new', backend: 'http://127.0.0.1:60065', explicit: true })).rejects.toThrow()
})
it.each(['valid', 'wrong-pid', 'wrong-data', 'not-admin'] as const)('verifies a reused backend identity (%s)', async kind => {
  const data = await realpath(repo)
  const scope = createHash('sha256').update(data).digest('hex').slice(0, 32)
  const backend = await serve((req, res) => {
    if (req.url === '/api/session/local') { res.setHeader('Set-Cookie', 'local=synthetic; HttpOnly'); res.end('{}'); return }
    expect(req.headers.cookie).toBe('local=synthetic')
    res.end(JSON.stringify({ localAdmin: kind !== 'not-admin', serverPid: kind === 'wrong-pid' ? process.pid + 1 : process.pid, queueScope: kind === 'wrong-data' ? 'another-data-directory' : scope }))
  })
  const result = verifyDevelopmentBackend(data, { port: backend.port, pid: process.pid })
  if (kind === 'valid') await expect(result).resolves.toBeUndefined()
  else await expect(result).rejects.toThrow('身份核验失败')
})

it.each(['0.12.0', '0.8.0', undefined])('checks the authenticated backend version before reuse (%s)', async serverVersion => {
  const data = await realpath(repo)
  const scope = createHash('sha256').update(data).digest('hex').slice(0, 32)
  const backend = await serve((req, res) => {
    if (req.url === '/api/session/local') { res.setHeader('Set-Cookie', 'local=synthetic; HttpOnly'); res.end('{}'); return }
    expect(req.headers.cookie).toBe('local=synthetic')
    res.end(JSON.stringify({ localAdmin: true, serverPid: process.pid, queueScope: scope, serverVersion }))
  })
  const saved = { port: backend.port, pid: process.pid }
  const result = verifyDevelopmentBackend(data, saved, { expectedVersion: '0.12.0' })
  if (serverVersion === '0.12.0') await expect(result).resolves.toBeUndefined()
  else {
    await expect(result).rejects.toThrow('请运行 ./restart-dev.sh')
    // Explicit restart can still authenticate an old server before stopping it.
    await expect(verifyDevelopmentBackend(data, saved)).resolves.toBeUndefined()
    expect(await fetch(backend.origin, { headers: { Cookie: 'local=synthetic' } }).then(r => r.ok)).toBe(true)
  }
})
