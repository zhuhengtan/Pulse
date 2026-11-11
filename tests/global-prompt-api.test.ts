import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost, H5Server, MAX_GLOBAL_PROMPT_CHARS, globalPromptPath, readGlobalPrompt, writeGlobalPrompt, type LocalHostOptions } from '../packages/server/src/index.js'

const previousHome = process.env.PULSE_HOME, previousConfig = process.env.PULSE_CONFIG
const isolatedHome = mkdtempSync(join(tmpdir(), 'pulse-global-prompt-home-'))
process.env.PULSE_HOME = isolatedHome
process.env.PULSE_CONFIG = ''

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
afterAll(() => {
  if (previousHome === undefined) delete process.env.PULSE_HOME
  else process.env.PULSE_HOME = previousHome
  if (previousConfig === undefined) delete process.env.PULSE_CONFIG
  else process.env.PULSE_CONFIG = previousConfig
  rmSync(isolatedHome, { recursive: true, force: true })
})

const mock = { provider: { provider: 'mock' as const, defaultModel: 'fixture' }, providerProfiles: { fixture: { provider: 'mock' as const, defaultModel: 'fixture' } }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', activeProviderCode: 'fixture' }

async function fixture() {
  await rm(globalPromptPath(), { recursive: true, force: true })
  const root = await mkdtemp(join(tmpdir(), 'pulse-global-prompt-'))
  closers.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'config.json'), dataDir = join(root, 'data')
  await writeFile(path, JSON.stringify({ allowNetwork: false }))
  const prepare = async (file: string): Promise<LocalHostOptions> => ({ ...mock, cwd: root, dataDir, taskController: false, allowNetwork: false, builtinPluginConfigPath: file, builtinPluginConfig: JSON.parse(await readFile(file, 'utf8')), approvalMode: 'ask' })
  const host = createLocalHost(await prepare(path))
  await host.init()
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir, configuration: { path, prepare } })
  closers.push(async () => { await server.stop(); await host.close() })
  const base = 'http://127.0.0.1:' + (await server.start()).port
  const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const headers = { Origin: base, Cookie: session.headers.get('set-cookie')!.split(';')[0]!, 'Content-Type': 'application/json' }
  const get = () => fetch(base + '/api/config', { headers }).then(response => response.json())
  const put = (body: unknown) => fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify(body) })
  return { get, put, path, server }
}

describe('global prompt over /api/config', () => {
  it('GET reports an unconfigured global prompt without changing the settings payload', async () => {
    const { get } = await fixture()
    const envelope = await get()
    expect(envelope.globalPrompt).toMatchObject({ prompt: '', configured: false, path: globalPromptPath() })
    expect(typeof envelope.version).toBe('string')
  })

  it('PUT stores the prompt and the next GET returns it', async () => {
    const { get, put } = await fixture()
    const initial = await get()
    const response = await put({ version: initial.version, config: initial.config, globalPrompt: 'Always answer in Chinese.', globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, globalPrompt: { prompt: 'Always answer in Chinese.', configured: true } })
    expect((await get()).globalPrompt).toMatchObject({ prompt: 'Always answer in Chinese.', configured: true })
    expect(await readGlobalPrompt()).toMatchObject({ prompt: 'Always answer in Chinese.', configured: true })
  })

  it('rejects a non-string prompt before writing anything', async () => {
    const { get, put } = await fixture()
    await writeGlobalPrompt('Existing prompt.')
    const initial = await get()
    const response = await put({ version: initial.version, config: initial.config, globalPrompt: 42, globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'GLOBAL_PROMPT_INVALID' })
    expect(await readGlobalPrompt()).toMatchObject({ prompt: 'Existing prompt.', configured: true })
    expect((await get()).version).toBe(initial.version)
  })

  it('rejects an over-long prompt before writing anything', async () => {
    const { get, put } = await fixture()
    await writeGlobalPrompt('Existing prompt.')
    const initial = await get()
    const response = await put({ version: initial.version, config: initial.config, globalPrompt: 'x'.repeat(MAX_GLOBAL_PROMPT_CHARS + 1), globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'GLOBAL_PROMPT_TOO_LONG' })
    expect(await readGlobalPrompt()).toMatchObject({ prompt: 'Existing prompt.', configured: true })
    expect((await get()).version).toBe(initial.version)
  })

  it('requires the prompt version the client read', async () => {
    const { get, put } = await fixture()
    const initial = await get()
    const response = await put({ version: initial.version, config: initial.config, globalPrompt: 'No base version.' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'GLOBAL_PROMPT_VERSION_REQUIRED' })
    expect(await readGlobalPrompt()).toMatchObject({ configured: false })
  })

  it('rejects a stale prompt version without writing the prompt or the config', async () => {
    const { get, put, path } = await fixture()
    const initial = await get()
    await writeGlobalPrompt('Written by another window.')
    const config = { ...initial.config, allowNetwork: true }
    const response = await put({ version: initial.version, config, globalPrompt: 'Mine.', globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'GLOBAL_PROMPT_CONFLICT' })
    expect(await readGlobalPrompt()).toMatchObject({ prompt: 'Written by another window.' })
    expect(JSON.parse(await readFile(path, 'utf8')).allowNetwork).toBe(false)
  })

  it('reports a prompt store failure without changing the config', async () => {
    const { get, put, path } = await fixture()
    const initial = await get()
    await mkdir(globalPromptPath(), { recursive: true })
    const response = await put({ version: initial.version, config: { ...initial.config, allowNetwork: true }, globalPrompt: 'Mine.', globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'GLOBAL_PROMPT_WRITE_FAILED' })
    expect(JSON.parse(await readFile(path, 'utf8')).allowNetwork).toBe(false)
    expect((await get()).version).toBe(initial.version)
  })

  it('rolls back its own prompt when the config replacement fails', async () => {
    const { get, put, path } = await fixture()
    await writeGlobalPrompt('Original prompt.')
    const initial = await get()
    // A directory at the backup path makes the real config replacement fail after the prompt landed.
    await mkdir(`${path}.bak`, { recursive: true })
    const response = await put({ version: initial.version, config: { ...initial.config, allowNetwork: true }, globalPrompt: 'Mine.', globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(400)
    expect((await response.json()).error).not.toBe('CONFIG_SAVE_PARTIAL_GLOBAL_PROMPT')
    expect(await readGlobalPrompt()).toMatchObject({ prompt: 'Original prompt.', configured: true })
    expect(JSON.parse(await readFile(path, 'utf8')).allowNetwork).toBe(false)
    expect((await get()).version).toBe(initial.version)
  })

  it('returns PARTIAL and keeps a concurrent writer prompt when rollback is no longer ours to do', async () => {
    const { get, put, path, server } = await fixture()
    await writeGlobalPrompt('Original prompt.')
    const initial = await get()
    // Another window updates the prompt after our write landed and before our config write fails.
    ;(server as any).replaceConfig = async () => { await writeGlobalPrompt('Newer prompt from another writer.'); throw new Error('CONFIG_REPLACE_FIXTURE_FAILURE') }
    const response = await put({ version: initial.version, config: { ...initial.config, allowNetwork: true }, globalPrompt: 'Mine.', globalPromptVersion: initial.globalPrompt.version })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'CONFIG_SAVE_PARTIAL_GLOBAL_PROMPT' })
    expect(await readGlobalPrompt()).toMatchObject({ prompt: 'Newer prompt from another writer.', configured: true })
    expect(JSON.parse(await readFile(path, 'utf8')).allowNetwork).toBe(false)
  })
})
