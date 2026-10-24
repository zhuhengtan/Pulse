import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FilePreviewServer, readPreviewFile } from '../packages/server/src/file-preview.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const value = await mkdtemp(join(tmpdir(), 'pulse-preview-')); roots.push(value); return value }
it('preserves binary bytes and rejects changed artifacts and escaping symlinks', async () => {
  const directory = await root(), workspace = join(directory, 'project'); await mkdir(workspace)
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 128, 0])
  await writeFile(join(workspace, 'image.png'), bytes); await writeFile(join(directory, 'outside'), 'private'); await symlink(join(directory, 'outside'), join(workspace, 'escape.png'))
  const value = await readPreviewFile(workspace, 'image.png')
  expect(value.bytes).toEqual(bytes); expect(value.size).toBe(bytes.length); expect(value.mediaType).toBe('image/png')
  await expect(readPreviewFile(workspace, 'escape.png')).rejects.toThrow()
  await expect(readPreviewFile(workspace, '../outside')).rejects.toThrow()
  await writeFile(join(workspace, 'image.png'), 'changed')
  await expect(readPreviewFile(workspace, 'image.png', value.hash)).rejects.toThrow('ARTIFACT_CHANGED')
})
it('serves ticketed HTML and related resources from a separate sandboxed origin', async () => {
  const directory = await root(); await mkdir(join(directory, 'site'))
  await writeFile(join(directory, 'site/index.html'), '<title>Preview</title><script src="app.js"></script>')
  await writeFile(join(directory, 'site/app.js'), 'document.title="ready"')
  await writeFile(join(directory, 'secret.txt'), 'SECRET')
  const server = new FilePreviewServer()
  try {
    const ticket = await server.ticket(directory, 'site/index.html')
    const response = await fetch(ticket.browserUrl)
    expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(await (await fetch(new URL('app.js', ticket.browserUrl))).text()).toContain('ready')
    expect((await fetch(ticket.browserUrl.replace('site/index.html', 'secret.txt'))).status).toBe(404)
    expect((await fetch(new URL('/api/session', ticket.browserUrl))).status).toBe(404)
    expect((await fetch(ticket.browserUrl.replace(/file-preview\/[a-f0-9-]+/, 'file-preview/00000000-0000-0000-0000-000000000000'))).status).toBe(404)
  } finally { await server.close() }
})
it('registers and downloads a binary artifact through the Host and H5, preserving per-run hashes', async () => {
  const directory = await root(), bytes = Buffer.from('%PDF-1.4\n\0binary\xff', 'latin1')
  await writeFile(join(directory, 'report.pdf'), bytes)
  const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'artifact.record', input: { path: 'report.pdf' } }], mockAfterToolResponse: 'recorded' })
  const server = new H5Server(host, { dataDir: join(directory, 'data'), host: '127.0.0.1', port: 0 })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: 'record binary artifact' }); for await (const _ of run.events) { /* drain */ }
    expect((await host.listArtifacts(conversation.id))[0]).toMatchObject({ bytes: bytes.length, mediaType: 'application/pdf', hash: createHash('sha256').update(bytes).digest('hex') })
    const info = await server.start(), base = `http://127.0.0.1:${info.port}`
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: session.headers.get('set-cookie')!.split(';')[0]!, Origin: base }
    const path = `/api/conversations/${conversation.id}/artifacts/raw?path=report.pdf&runId=${run.id}&download=1`
    expect((await fetch(base + '/file-preview/00000000-0000-0000-0000-000000000000/report.pdf')).status).toBe(401)
    expect((await fetch(base + path)).status).toBe(401)
    const response = await fetch(base + path, { headers }); expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-disposition')).toContain('attachment')
    await writeFile(join(directory, 'report.pdf'), 'changed')
    expect((await fetch(base + path, { headers })).status).toBe(409)
  } finally { await server.stop(); await host.close() }
}, 30_000)
