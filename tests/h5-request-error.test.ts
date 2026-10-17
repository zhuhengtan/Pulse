import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '@hunterzhu/pulse-server'

it('ends the assistant response with an error when reading its conversation fails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-h5-error-'))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false } })
  const server = new H5Server(host, { dataDir: join(cwd, 'data'), host: '127.0.0.1', port: 0 })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const info = await server.start(), base = `http://127.0.0.1:${info.port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const cookie = session.headers.get('set-cookie')!
    await session.text()
    vi.spyOn(host, 'getWebConversationMessages').mockRejectedValue(new Error('READ_FAILED'))
    const response = await fetch(`${base}/api/assistant`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2_000) })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'INTERNAL_ERROR' })
    expect(stderr).toHaveBeenCalledWith('h5 request failed: READ_FAILED\n')
  } finally {
    await server.stop()
    await host.close()
    vi.restoreAllMocks()
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
