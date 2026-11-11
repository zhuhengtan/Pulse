import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compactTtsInstalled, compactTtsModel, installLocalModel, localModelReady, localModels, whisperAsrInstalled, whisperAsrModel } from '../packages/desktop/src/voice/local-models.mjs'
// A tiny tar.bz2: two model files, an outside entry, a traversal entry and a symlink.
const archive = Buffer.from('QlpoOTFBWSZTWWrtHFIAAOnfgMuQQAP/gAAJBwBvL95ASIgwANm2DUagAAAGgyAMgyKGhPQTJmpkemkNDIMIpQRo0PUAZAAAaXevkdI5SCmAg6+5kSfyTGBFTVqtmPaWJISm3bNpHEmFFIBIGVtNpmozQTwRFgVCtSICAXwyWEhAMGUIAp6qtjw2J3NXXoQqkIWI0h1wgYKyMK+QgcI8IgDjUIWxO7Iwn0wXKFCLs9DchSXn8aDxVL8NyXyq+Tp9cqV4KChMLeS4LshXQyTcoH8XckU4UJBq7RxS', 'base64')
const catalog = { asr: { directory: 'fixture', size: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), required: ['model.onnx', 'tokens.txt'] } }
const roots: string[] = [], servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function root() { const value = await mkdtemp(join(tmpdir(), 'pulse-local-model-')); roots.push(value); return value }
const download = () => Promise.resolve(new Response(archive))
it('keeps a verified Whisper usable until an explicit successful ASR upgrade', async () => {
 const directory = await root(), hashes = {}
 await mkdir(join(directory, 'asr'))
 for (const name of whisperAsrModel.required) { await writeFile(join(directory, 'asr', name), name); hashes[name] = createHash('sha256').update(name).digest('hex') }
 await writeFile(join(directory, 'asr/installation.json'), JSON.stringify({archiveSha256:whisperAsrModel.sha256,hashes}))
 expect(await localModelReady(directory, 'asr')).toBe(true)
 expect(await whisperAsrInstalled(directory)).toBe(true)
 expect(await localModelReady(directory, 'asr', localModels, false)).toBe(false)
 await expect(installLocalModel(directory, 'asr', () => {}, undefined, {fetch:download})).rejects.toThrow('CHECKSUM_MISMATCH')
 expect(await whisperAsrInstalled(directory)).toBe(true)
 await writeFile(join(directory, 'asr/base-tokens.txt'), 'tampered')
 expect(await localModelReady(directory, 'asr')).toBe(false)
})
const install = (directory: string, options = {}) => installLocalModel(directory, 'asr', () => {}, undefined, { catalog, fetch: download, ...options })
it('installs a verified archive, excludes unsafe entries and verifies files on reuse', async () => {
  const directory = await root(), fetch = vi.fn(download)
  await install(directory, { fetch })
  expect(await localModelReady(directory, 'asr', catalog)).toBe(true)
  expect(await readFile(join(directory, 'asr/model.onnx'), 'utf8')).toBe('fixture-model')
  for (const name of ['outside.txt', 'escape.txt', 'asr/link']) await expect(readFile(join(directory, name))).rejects.toThrow()
  await install(directory, { fetch }); expect(fetch).toHaveBeenCalledOnce()
  await writeFile(join(directory, 'asr/model.onnx'), 'tampered')
  expect(await localModelReady(directory, 'asr', catalog)).toBe(false)
  await install(directory, { fetch }); expect(fetch).toHaveBeenCalledTimes(2)
  expect(await localModelReady(directory, 'asr', catalog)).toBe(true)
})
it('recovers an interrupted atomic swap without redownloading', async () => {
  const directory = await root(), fetch = vi.fn(download)
  await install(directory, { fetch }); await rename(join(directory, 'asr'), join(directory, 'asr.backup'))
  await install(directory, { fetch }); expect(fetch).toHaveBeenCalledOnce()
  expect(await localModelReady(directory, 'asr', catalog)).toBe(true)
})
it('rejects wrong hashes, oversized archives and missing required files, then permits retry', async () => {
  const directory = await root()
  await expect(install(directory, { catalog: { asr: { ...catalog.asr, sha256: '0'.repeat(64) } } })).rejects.toThrow('CHECKSUM_MISMATCH')
  await expect(install(directory, { fetch: async () => new Response(Buffer.concat([archive, archive])) })).rejects.toThrow('SIZE_INVALID')
  await expect(install(directory, { catalog: { asr: { ...catalog.asr, required: ['missing.onnx'] } } })).rejects.toThrow('FILES_MISSING')
  expect(await localModelReady(directory, 'asr', catalog)).toBe(false)
  await install(directory); expect(await localModelReady(directory, 'asr', catalog)).toBe(true)
})
it.each(['headers', 'body'])('times out stalled %s and preserves caller cancellation', async mode => {
  const server = createServer((_req, res) => { if (mode === 'body') { res.writeHead(200); res.write(archive.subarray(0, 3)) } })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`, directory = await root()
  await expect(install(directory, { fetch: globalThis.fetch, url, budgetMs: 100 })).rejects.toThrow('VOICE_MODEL_DOWNLOAD_TIMEOUT')
  const abort = new AbortController(); setTimeout(() => abort.abort(), 50)
  await expect(installLocalModel(directory, 'asr', () => {}, abort.signal, { catalog, url, budgetMs: 2000 })).rejects.toMatchObject({ name: 'AbortError' })
  await install(directory); expect(await localModelReady(directory, 'asr', catalog)).toBe(true)
})

it('keeps a previously verified installation when a replacement fails its checksum', async () => {
  const directory = await root(); await install(directory)
  await expect(install(directory, { catalog: { asr: { ...catalog.asr, sha256: '0'.repeat(64) } } })).rejects.toThrow('CHECKSUM_MISMATCH')
  expect(await localModelReady(directory, 'asr', catalog)).toBe(true)
})
it('keeps compact TTS usable while offering a verified upgrade, and preserves it when the upgrade fails', async () => {
  const directory = await root(), hashes = {}
  await mkdir(join(directory, 'tts'))
  for (const name of compactTtsModel.required) {
    await writeFile(join(directory, 'tts', name), 'compact-fixture')
    hashes[name] = createHash('sha256').update('compact-fixture').digest('hex')
  }
  await writeFile(join(directory, 'tts/installation.json'), JSON.stringify({ archiveSha256: compactTtsModel.sha256, hashes }))
  expect(await localModelReady(directory, 'tts')).toBe(true)
  expect(await compactTtsInstalled(directory)).toBe(true)
  expect(await localModelReady(directory, 'tts', localModels, false)).toBe(false)
  const fetch = vi.fn(download)
  await expect(installLocalModel(directory, 'tts', () => {}, undefined, { fetch })).rejects.toThrow('CHECKSUM_MISMATCH')
  expect(fetch).toHaveBeenCalledOnce(); expect(await localModelReady(directory, 'tts')).toBe(true)
  await writeFile(join(directory, 'tts/voices.bin'), 'corrupted')
  expect(await localModelReady(directory, 'tts')).toBe(false)
})
