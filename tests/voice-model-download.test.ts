import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installModels } from '../packages/desktop/src/voice/models.mjs'

const body = Buffer.from('fixture-model')
const model = { tag: 't', file: 'fixture.onnx', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
const servers: Array<ReturnType<typeof createServer>> = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(mode: 'ok' | 'hang-header' | 'hang-body') {
  const server = createServer((_request, response) => {
    if (mode === 'hang-header') return
    response.writeHead(200, { 'Content-Length': body.length })
    if (mode === 'hang-body') { response.write(body.subarray(0, 3)); return }
    response.end(body)
  })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(join(tmpdir(), 'pulse-voice-models-')); roots.push(root)
  return { root, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

it('times out a response that never sends headers, and a later download can succeed', async () => {
  const hung = await fixture('hang-header')
  await expect(installModels(hung.root, () => undefined, undefined, { models: [model], baseUrl: hung.baseUrl, budgetMs: 200 })).rejects.toThrow('VOICE_MODEL_DOWNLOAD_TIMEOUT')
  const ok = await fixture('ok')
  await installModels(hung.root, () => undefined, undefined, { models: [model], baseUrl: ok.baseUrl, budgetMs: 2000 })
  expect(await readFile(join(hung.root, model.file))).toEqual(body)
})

it('times out a response body that stalls mid-stream', async () => {
  const hung = await fixture('hang-body')
  await expect(installModels(hung.root, () => undefined, undefined, { models: [model], baseUrl: hung.baseUrl, budgetMs: 200 })).rejects.toThrow('VOICE_MODEL_DOWNLOAD_TIMEOUT')
})

it('keeps caller cancellation distinct from the timeout', async () => {
  const hung = await fixture('hang-body'), controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const error = await installModels(hung.root, () => undefined, controller.signal, { models: [model], baseUrl: hung.baseUrl, budgetMs: 5000 }).catch(error => error)
  expect(error.message).not.toBe('VOICE_MODEL_DOWNLOAD_TIMEOUT')
  expect(error.name).toBe('AbortError')
})

it('still verifies size and checksum on the normal path', async () => {
  const bad = { ...model, sha256: '0'.repeat(64) }
  const ok = await fixture('ok')
  await expect(installModels(ok.root, () => undefined, undefined, { models: [bad], baseUrl: ok.baseUrl })).rejects.toThrow('VOICE_MODEL_CHECKSUM_MISMATCH')
})
