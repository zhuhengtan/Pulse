import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { createBuiltinSkillCapabilityPack } from '../packages/server/src/builtin-skills.js'
import { createSkillCapabilityPack } from '../packages/server/src/skill-pack.js'
import { skillRoot } from '../packages/server/src/skill-store.js'
const require = createRequire(import.meta.url), { ZipFile } = require('../packages/server/node_modules/yazl')
const nativeFetch = fetch
const dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function archive(reference = 'reference') {
  const zip = new ZipFile(); zip.addBuffer(Buffer.from('---\nname: demo\ndescription: Demo skill\n---\nUse the reference.'), 'repo/skills/demo/SKILL.md'); zip.addBuffer(Buffer.from(reference), 'repo/skills/demo/references/guide.md')
  const chunks: Buffer[] = []; zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk)); const result = new Promise<Buffer>(resolve => zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))); zip.end(); return result
}
it('protects management APIs, installs with config concurrency, refreshes lists and preserves active snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-skill-api-')); dirs.push(dir); vi.stubEnv('PULSE_HOME', dir)
  const config = join(dir, 'config.json'); await writeFile(config, JSON.stringify({ custom: 'keep', capabilities: { enabled: [], skills: [] } }))
  let body = await archive(), commit = 'a'.repeat(40), remoteUnavailable = false
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = String(input)
    if (remoteUnavailable && url.startsWith('https://api.github.com/')) return new Response('', { status: 503 })
    if (url.startsWith('https://api.github.com/')) return Response.json({ sha: commit })
    if (url.startsWith('https://codeload.github.com/')) return new Response(body)
    return nativeFetch(input, init)
  }))
  const packs = [createBuiltinSkillCapabilityPack(), createSkillCapabilityPack()]
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), skillConfigPath: config, capabilityPacks: packs, enabledCapabilityPacks: ['builtin-skills'], jarvis: { enabled: false } })
  const server = new H5Server(host, { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1', configuration: { path: config, prepare: async path => {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return { cwd: dir, dataDir: join(dir, 'data'), capabilityPacks: packs, enabledCapabilityPacks: ['builtin-skills', ...value.capabilities.enabled], capabilityConfig: { skills: value.capabilities.skills } }
  } } })
  const info = await server.start(), base = `http://127.0.0.1:${info.port}`
  try {
    expect((await nativeFetch(base + '/api/skill-marketplace/installed')).status).toBe(401)
    const local = await nativeFetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } }), cookie = local.headers.get('set-cookie')!
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }
    const post = (path: string, data: unknown, extra = {}) => nativeFetch(base + '/api/skill-marketplace/' + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) })
    expect((await post('inspect', { source: 'owner/repo' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('check-updates', {}, { Origin: 'https://evil.example' })).status).toBe(403)
    const paired = await nativeFetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Phone' }) })
    expect((await nativeFetch(base + '/api/skill-marketplace/installed', { headers: { Cookie: paired.headers.get('set-cookie')! } })).status).toBe(403)
    expect((await nativeFetch(base + '/api/skill-marketplace/check-updates', { method: 'POST', headers: { Cookie: paired.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
    const list = await nativeFetch(base + '/api/skills', { headers }).then(res => res.json())
    expect(list.skills).toContainEqual({ id: 'skill-creator', name: 'skill-creator' })
    const envelope = await nativeFetch(base + '/api/config', { headers }).then(res => res.json())
    const preview = await post('inspect', { source: 'owner/repo' }).then(res => res.json())
    expect(preview.skills[0].files.map((file: { path: string }) => file.path)).toContain('references/guide.md')
    expect((await post('install', { previewId: preview.previewId, name: 'demo', directory: 'skills/demo', configVersion: 'stale' })).status).toBe(409)
    const installed = await post('install', { previewId: preview.previewId, name: 'demo', directory: 'skills/demo', configVersion: envelope.version })
    expect(installed.status).toBe(200)
    expect((await host.listSkills())).toContain('demo')
    expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({ custom: 'keep', capabilities: { enabled: ['skills'], skills: ['demo'] } })
    const refreshed = await nativeFetch(base + '/api/config', { headers }).then(res => res.json())
    expect(refreshed.version).not.toBe(envelope.version)
    const receiptPath = join(skillRoot(), 'demo/.pulse-install.json'), beforeCheck = await readFile(receiptPath, 'utf8')
    const check = () => post('check-updates', { name: 'demo' }).then(res => res.json())
    expect((await check()).skills.find((skill: { name: string }) => skill.name === 'demo')).toMatchObject({ version: 'a'.repeat(40), update: { status: 'current', latestCommit: 'a'.repeat(40) } })
    // A repository commit without skill-content changes is not a skill update.
    commit = 'b'.repeat(40)
    expect((await check()).skills.find((skill: { name: string }) => skill.name === 'demo').update.status).toBe('current')
    body = await archive('new reference')
    expect((await check()).skills.find((skill: { name: string }) => skill.name === 'demo')).toMatchObject({ version: 'a'.repeat(40), update: { status: 'available', latestCommit: commit } })
    expect(await readFile(receiptPath, 'utf8')).toBe(beforeCheck)
    expect(await readFile(join(skillRoot(), 'demo/references/guide.md'), 'utf8')).toBe('reference')
    expect((await nativeFetch(base + '/api/config', { headers }).then(res => res.json())).version).toBe(refreshed.version)
    commit = 'c'.repeat(40)
    const moved = await post('update', { name: 'demo', configVersion: refreshed.version, expectedCommit: 'b'.repeat(40) })
    expect(await moved.json()).toEqual({ error: 'SKILL_UPDATE_CHANGED' })
    expect(await readFile(receiptPath, 'utf8')).toBe(beforeCheck)
    await check()
    expect((await post('update', { name: 'demo', configVersion: refreshed.version, expectedCommit: commit })).status).toBe(200)
    expect((await check()).skills.find((skill: { name: string }) => skill.name === 'demo')).toMatchObject({ version: commit, update: { status: 'current' } })
    const afterUpdate = await nativeFetch(base + '/api/config', { headers }).then(res => res.json())
    remoteUnavailable = true
    expect((await check()).skills.find((skill: { name: string }) => skill.name === 'demo')).toMatchObject({ version: commit, update: { status: 'error' } })
    expect((await post('update', { name: 'demo', configVersion: afterUpdate.version })).status).toBe(400)
    expect(await readFile(join(skillRoot(), 'demo/references/guide.md'), 'utf8')).toBe('new reference')
    remoteUnavailable = false
    await writeFile(join(skillRoot(), 'demo/references/guide.md'), 'local edit')
    const failure = await post('uninstall', { name: 'demo' })
    expect(failure.status).toBe(409); expect(await failure.json()).toEqual({ error: 'SKILL_LOCALLY_MODIFIED' })
    expect((await post('uninstall', { name: 'skill-creator' })).status).toBe(400)
  } finally { await server.stop(); await host.close() }
})
