import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopServiceFetch, desktopServiceTimeout } from '../packages/desktop/src/service-http.mjs'
import { readFileSync } from 'node:fs'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function listen(handler: (delay: number) => void, delay: number) {
  const server = createServer(async (_req, res) => { handler(delay); await new Promise(resolve => setTimeout(resolve, delay)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '你好' })) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

it('gives production voice requests the server 60 second budget', () => {
  expect(desktopServiceTimeout('POST', '/api/voice/transcribe')).toBe(60_000)
  expect(desktopServiceTimeout('POST', '/api/voice/speech')).toBe(60_000)
  expect(desktopServiceTimeout('POST', '/api/conversations/chat/messages')).toBe(25_000)
  expect(desktopServiceTimeout('GET', '/api/voice/config')).toBe(10_000)
  expect(readFileSync(new URL('../packages/desktop/src/main.mjs', import.meta.url), 'utf8')).toContain('desktopServiceFetch(base + requestPath, { method, headers, ...(typeof init.body === \'string\' ? { body: init.body } : {}) }, desktopServiceTimeout(method, requestPath))')
})

it('completes a voice request slower than the old 10 second budget and surfaces an explicit failure', async () => {
  let hits = 0
  const base = await listen(() => { hits += 1 }, 11_000)
  const speech = await desktopServiceFetch(base + '/api/voice/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, desktopServiceTimeout('POST', '/api/voice/speech'))
  expect(speech.status).toBe(200)
  expect(hits).toBe(1)
  const hung = createServer(() => undefined)
  servers.push(hung)
  await new Promise<void>(resolve => hung.listen(0, '127.0.0.1', resolve))
  const hungBase = `http://127.0.0.1:${(hung.address() as { port: number }).port}`
  await expect(desktopServiceFetch(hungBase + '/api/voice/transcribe', { method: 'POST', body: '{}' }, 200)).rejects.toThrow()
  const failing = createServer((_req, res) => { hits += 1; res.writeHead(500).end() })
  servers.push(failing)
  await new Promise<void>(resolve => failing.listen(0, '127.0.0.1', resolve))
  const failed = await desktopServiceFetch(`http://127.0.0.1:${(failing.address() as { port: number }).port}/api/voice/speech`, { method: 'POST', body: '{}' }, desktopServiceTimeout('POST', '/api/voice/speech'))
  expect(failed.status).toBe(500)
  expect(hits).toBe(2)
}, 20_000)
