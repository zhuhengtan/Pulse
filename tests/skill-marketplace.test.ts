import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { SkillMarketplace, parseSkillSource } from '../packages/server/src/skill-marketplace.js'
import { SkillManagement } from '../packages/server/src/skill-management.js'
import { snapshot, metadata, publishSkill, readSkillDirectory, receipt, uninstallSkill, skillPath, skillRoot, skillLimits } from '../packages/server/src/skill-store.js'
import { createSkillCapabilityPack } from '../packages/server/src/skill-pack.js'
import { createBuiltinSkillCapabilityPack, listBuiltinSkills } from '../packages/server/src/builtin-skills.js'
import { createSkillTools } from '../packages/server/src/skill-tools.js'
import { enableSkillConfig } from '../packages/server/src/skill-config.js'
import { saveRunSkills, loadRunSkills } from '../packages/server/src/skill-run-snapshot.js'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'

const require = createRequire(import.meta.url)
const { ZipFile } = require('../packages/server/node_modules/yazl')
let root: string
const text = (name = 'demo', body = 'Read [reference](references/guide.md).') => `---\nname: ${name}\ndescription: A useful example\n---\n${body}`
const files = (name = 'demo', body?: string) => new Map([['SKILL.md', Buffer.from(text(name, body))], ['references/guide.md', Buffer.from('ORIGINAL_REFERENCE')], ['scripts/run.mjs', Buffer.from('console.log("ok")')], ['assets/binary.bin', Buffer.from([0, 255, 42])]])
const context: ToolContext = { toolCallId: 'call', effectId: 'effect', attemptId: 'attempt', agentId: 'agent', laneId: 'lane', signal: new AbortController().signal, emit() {} }
async function zip(entries: Record<string, string | Buffer>, options?: { symlink?: string }): Promise<Buffer> {
  const archive = new ZipFile()
  for (const [path, content] of Object.entries(entries)) archive.addBuffer(Buffer.from(content), 'repo-sha/' + path, options?.symlink === path ? { mode: 0o120777 } : {})
  const chunks: Buffer[] = []; archive.outputStream.on('data', (bytes: Buffer) => chunks.push(bytes))
  const done = new Promise<Buffer>((resolve, reject) => { archive.outputStream.on('end', () => resolve(Buffer.concat(chunks))); archive.outputStream.on('error', reject) }); archive.end(); return done
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pulse-market-')); vi.stubEnv('PULSE_HOME', root) })
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })

describe('skill sources and registry transport', () => {
  it('accepts public GitHub repo, exact skill and tree sources', () => {
    expect(parseSkillSource('owner/repo@demo')).toEqual({ repository: 'owner/repo', ref: 'HEAD', skill: 'demo' })
    expect(parseSkillSource('https://github.com/owner/repo/tree/main/skills/demo')).toEqual({ repository: 'owner/repo', ref: 'main', directory: 'skills/demo' })
    for (const source of ['https://example.com/owner/repo', 'git@github.com:owner/repo', '../repo', 'owner/repo;whoami', 'https://u:p@github.com/owner/repo']) expect(() => parseSkillSource(source)).toThrow()
  })
  it('separates empty results, changed responses and rate limits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ skills: [] })).mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(new Response('', { status: 429 }))
    const market = new SkillMarketplace(fetcher)
    expect(await market.search('react')).toEqual([])
    await expect(market.search('react')).rejects.toThrow('SKILL_SEARCH_RESPONSE_CHANGED')
    await expect(market.search('react')).rejects.toThrow('SKILL_REMOTE_RATE_LIMITED')
    await expect(market.search('a')).rejects.toThrow('SKILL_QUERY_INVALID')
  })
  it('filters well-known non-GitHub sources without losing valid search results', async () => {
    const market = new SkillMarketplace(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ skills: [{ id: 'mintlify.com/mintlify', source: 'mintlify.com', name: 'mintlify', installs: 10 }, { id: 'owner/repo/demo', source: 'owner/repo', name: 'demo', installs: 20 }] })))
    expect(await market.search('demo')).toEqual([{ id: 'owner/repo/demo', source: 'owner/repo', name: 'demo', installs: 20 }])
  })
  it('discovers multiple complete directories at an immutable commit', async () => {
    const archive = await zip({ 'skills/demo/SKILL.md': text(), 'skills/demo/references/guide.md': 'guide', 'skills/demo/assets/raw.bin': Buffer.from([0, 255]), 'skills/other/SKILL.md': text('other', 'other') })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes('/commits/') ? Response.json({ sha: 'a'.repeat(40) }) : new Response(archive))
    const found = await new SkillMarketplace(fetcher).discover('owner/repo')
    expect(found.map(skill => skill.name)).toEqual(['demo', 'other'])
    expect(found[0]!.origin).toEqual({ repository: 'owner/repo', directory: 'skills/demo', commit: 'a'.repeat(40), ref: 'HEAD' })
    expect(found[0]!.files.get('assets/raw.bin')).toEqual(Buffer.from([0, 255]))
    expect(fetcher.mock.calls[1]![0]).toBe('https://codeload.github.com/owner/repo/zip/' + 'a'.repeat(40))
  })
  it('ignores repository symlinks outside the selected skill directory', async () => {
    const archive = await zip({ 'skills/demo/SKILL.md': text('demo', 'safe'), '.claude/skills/demo': '../../skills/demo' }, { symlink: '.claude/skills/demo' })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes('/commits/') ? Response.json({ sha: 'b'.repeat(40) }) : new Response(archive))
    const found = await new SkillMarketplace(fetcher).discover('owner/repo@demo')
    expect(found[0]!.name).toBe('demo')
    expect([...found[0]!.files.keys()]).toEqual(['SKILL.md'])
  })
  it('rejects symlinks in remote archives', async () => {
    const archive = await zip({ 'skills/demo/SKILL.md': text(), 'skills/demo/escape': '/private/file' }, { symlink: 'skills/demo/escape' })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes('/commits/') ? Response.json({ sha: 'b'.repeat(40) }) : new Response(archive))
    await expect(new SkillMarketplace(fetcher).discover('owner/repo')).rejects.toThrow('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED')
  })
})

describe('skill store invariants', () => {
  it('checks market versions independently without changing installed files or fetching local skills', async () => {
    await publishSkill(snapshot(files()), { origin: { repository: 'owner/repo', directory: 'skills/demo', ref: 'HEAD', commit: 'a'.repeat(40) } })
    await publishSkill(snapshot(files('other')), { origin: { repository: 'owner/unavailable', directory: 'skills/other', ref: 'main', commit: 'a'.repeat(40) } })
    await publishSkill(snapshot(files('local')))
    const archive = await zip({ 'skills/demo/SKILL.md': text(), 'skills/demo/references/guide.md': 'NEW_REFERENCE' })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/owner/unavailable/')) return new Response('', { status: 429 })
      return url.includes('/commits/') ? Response.json({ sha: 'b'.repeat(40) }) : new Response(archive)
    })
    vi.stubGlobal('fetch', fetcher)
    const manager = new SkillManagement(), before = await receipt('demo')
    const result = await manager.checkUpdates()
    expect(result.skills.find(skill => skill.name === 'demo')).toMatchObject({ version: 'a'.repeat(40), update: { status: 'available', latestCommit: 'b'.repeat(40) } })
    expect(result.skills.find(skill => skill.name === 'other')).toMatchObject({ update: { status: 'error', error: 'SKILL_REMOTE_RATE_LIMITED' } })
    expect(result.skills.find(skill => skill.name === 'local')).not.toHaveProperty('origin', expect.anything())
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await receipt('demo')).toEqual(before)
    expect(await readFile(join(skillRoot(), 'demo/references/guide.md'), 'utf8')).toBe('ORIGINAL_REFERENCE')
    await publishSkill(snapshot(files()), { update: true, origin: { ...before!.origin!, commit: 'b'.repeat(40) } })
    fetcher.mockClear()
    expect((await manager.checkUpdates('demo')).skills.find(skill => skill.name === 'demo')).toMatchObject({ update: { status: 'current' } })
    expect(fetcher).toHaveBeenCalledTimes(1) // Unchanged source revision needs no archive download.
    await expect(manager.checkUpdates('../escape')).rejects.toThrow('INVALID_SKILL_NAME')
    await expect(manager.checkUpdates('local')).rejects.toThrow('SKILL_NOT_REMOTE_MANAGED')
  })
  it('validates metadata, links and portable paths', () => {
    expect(snapshot(files()).warnings).toEqual([])
    expect(snapshot(files('demo', '```md\n[example](not-a-real-file.md)\n```')).warnings).toEqual([])
    expect(snapshot(files('demo', '[missing](references/missing.md)')).warnings).toHaveLength(1)
    for (const path of ['../outside', '/outside', 'a/../b', 'a\\b', 'C:file', 'a/NUL.txt', 'a.', 'a//b']) expect(() => skillPath(path)).toThrow()
    expect(() => metadata(Buffer.from('no metadata'))).toThrow('SKILL_FRONTMATTER_REQUIRED')
    expect(() => metadata(Buffer.from(text('INVALID')))).toThrow('INVALID_SKILL_NAME')
    expect(() => metadata(Buffer.from('---\nname: demo\nname: other\ndescription: description\n---\n'))).toThrow('SKILL_FRONTMATTER_INVALID')
    expect(() => snapshot(new Map([['SKILL.md', Buffer.from(text())], ['skill.md', Buffer.from('collision')]]))).toThrow('SKILL_FILE_COLLISION')
    expect(() => snapshot(new Map([['SKILL.md', Buffer.alloc(skillLimits.bodyBytes + 1)]]))).toThrow('SKILL_FILE_BYTES_LIMIT_EXCEEDED')
  })
  it('publishes complete files, persists origin and enables only after publishing', async () => {
    const skill = snapshot(files()), origin = { repository: 'owner/repo', directory: 'skills/demo', commit: 'a'.repeat(40), ref: 'HEAD' }
    const enable = vi.fn(async name => { expect(await readFile(join(skillRoot(), name, 'assets/binary.bin'))).toEqual(Buffer.from([0, 255, 42])) })
    await publishSkill(skill, { origin, enable })
    expect((await receipt('demo'))?.origin).toEqual(origin)
    expect(enable).toHaveBeenCalledOnce()
    await expect(publishSkill(skill)).rejects.toThrow('SKILL_ALREADY_INSTALLED')
    await expect(publishSkill(snapshot(files('skill-creator')), { protectedNames: listBuiltinSkills() })).rejects.toThrow('SKILL_BUILTIN_PROTECTED')
  })
  it('rolls back installation and update when configuration activation fails', async () => {
    const fail = async () => { throw new Error('CONFIG_VERSION_CONFLICT') }
    await expect(publishSkill(snapshot(files()), { enable: fail })).rejects.toThrow('CONFIG_VERSION_CONFLICT')
    expect(await readdir(skillRoot())).toEqual([])
    const original = snapshot(files()); await publishSkill(original)
    await expect(publishSkill(snapshot(files('demo', 'updated')), { update: true, enable: fail })).rejects.toThrow('CONFIG_VERSION_CONFLICT')
    expect(snapshot(await readSkillDirectory(join(skillRoot(), 'demo'))).hash).toBe(original.hash)
    expect(await readdir(skillRoot())).toEqual(['demo'])
  })
  it('detects existing skills in host trusted roots independently of the selection allow-list', async () => {
    const other = join(root, 'trusted'); await mkdir(join(other, 'demo'), { recursive: true }); await writeFile(join(other, 'demo/SKILL.md'), text())
    const pack = createSkillCapabilityPack({ trustedRoots: [other] })
    expect(await pack.discoverSkills!({ skills: [] })).toEqual([])
    expect(await pack.hasSkill!('demo')).toBe(true)
    expect(await pack.hasSkill!('missing')).toBe(false)
  })
  it('reclaims a stale skill lock that has no live owner', async () => {
    const lock = join(skillRoot(), '.store-lock')
    await mkdir(lock, { recursive: true })
    const stale = new Date(Date.now() - 60_000)
    await utimes(lock, stale, stale)
    await publishSkill(snapshot(files()))
    expect(await readdir(skillRoot())).toEqual(['demo'])
    await rm(join(skillRoot(), 'demo'), { recursive: true })
    await mkdir(lock)
    await writeFile(join(lock, 'owner'), '2147483646')
    await publishSkill(snapshot(files()))
    expect(await readdir(skillRoot())).toEqual(['demo'])
  })
  it('protects locally modified files during update and removal', async () => {
    await publishSkill(snapshot(files()))
    await writeFile(join(skillRoot(), 'demo/references/guide.md'), 'local edit')
    await expect(publishSkill(snapshot(files()), { update: true })).rejects.toThrow('SKILL_LOCALLY_MODIFIED')
    await expect(uninstallSkill('demo', [])).rejects.toThrow('SKILL_LOCALLY_MODIFIED')
    expect(await readFile(join(skillRoot(), 'demo/references/guide.md'), 'utf8')).toBe('local edit')
  })
  it('rejects local symlinks and oversized resources without publishing', async () => {
    const dir = join(root, 'draft'); await mkdir(dir); await writeFile(join(dir, 'SKILL.md'), text())
    await symlink('/etc/hosts', join(dir, 'escape'))
    await expect(readSkillDirectory(dir)).rejects.toThrow('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED')
    await rm(join(dir, 'escape')); await writeFile(join(dir, 'large'), Buffer.alloc(skillLimits.fileBytes + 1))
    await expect(readSkillDirectory(dir)).rejects.toThrow('SKILL_BYTES_LIMIT_EXCEEDED')
  })
  it('preserves unrelated configuration and appends an explicit allow-list', async () => {
    const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify({ keep: { value: 'unchanged' }, capabilities: { enabled: ['pdf'], skills: ['existing'], trustedSkillRoots: ['/somewhere'] } }))
    await enableSkillConfig(path, 'demo'); await enableSkillConfig(path, 'demo')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ keep: { value: 'unchanged' }, capabilities: { enabled: ['pdf', 'skills'], skills: ['existing', 'demo'], trustedSkillRoots: ['/somewhere'] } })
  })
})

describe('selected resource tools and built-in creator', () => {
  it('keeps an active snapshot usable after update and removal', async () => {
    await publishSkill(snapshot(files()))
    const activation = await createSkillCapabilityPack().activate({ workspaceRoot: root, selectedSkills: ['demo'], config: {}, signal: context.signal })
    const selected = activation.skillSnapshots!
    await publishSkill(snapshot(files('demo', 'new version')), { update: true })
    await uninstallSkill('demo', [])
    const tools = createSkillTools(selected, root, { mode: 'auto', approved: () => false, enable: async () => {}, protectedNames: listBuiltinSkills() })
    expect(await tools.find(tool => tool.manifest.name === 'skills.read')!.execute({ skill: 'demo', path: 'references/guide.md' }, context)).toEqual({ content: 'ORIGINAL_REFERENCE', nextOffset: null })
    await expect(tools[0]!.execute({ skill: 'other', path: 'SKILL.md' }, context)).rejects.toThrow('SKILL_NOT_SELECTED')
    await expect(tools[0]!.execute({ skill: 'demo', path: '../outside' }, context)).rejects.toThrow('SKILL_PATH_INVALID')
    const materialize = tools.find(tool => tool.manifest.name === 'skills.materialize')!
    await materialize.execute({ skill: 'demo', destination: 'prepared' }, context)
    expect(await readFile(join(root, 'prepared/assets/binary.bin'))).toEqual(Buffer.from([0, 255, 42]))
    await expect(materialize.execute({ skill: 'demo', destination: 'prepared' }, context)).rejects.toThrow('SKILL_DESTINATION_EXISTS')
    const saved = join(root, 'run/skills.json'); await saveRunSkills(saved, selected)
    expect((await loadRunSkills(saved))?.get('demo')!.files.get('references/guide.md')?.toString()).toBe('ORIGINAL_REFERENCE')
    const restored = await createSkillCapabilityPack().activate({ workspaceRoot: root, selectedSkills: ['demo'], skillSnapshots: (await loadRunSkills(saved))!, config: {}, signal: context.signal })
    expect(restored.instructions?.[0]).toContain('Read [reference]')
  })
  it('retains selected built-in instructions in a persisted run snapshot', async () => {
    const builtin = createBuiltinSkillCapabilityPack()
    const original = await builtin.activate({ workspaceRoot: root, selectedSkills: ['grill-and-plan'], config: {}, signal: context.signal })
    expect([...original.skillSnapshots!.keys()]).toEqual(['grill-and-plan'])
    const path = join(root, 'run/builtin.json'); await saveRunSkills(path, original.skillSnapshots!)
    const saved = (await loadRunSkills(path))!
    const resumed = await builtin.activate({ workspaceRoot: root, selectedSkills: [...saved.keys()], skillSnapshots: saved, config: {}, signal: context.signal })
    expect(resumed.instructions).toEqual(original.instructions)
  })
  it('enforces read-only and approval boundaries for materialization', async () => {
    for (const [mode, code] of [['read-only', 'TOOL_DISABLED_READ_ONLY'], ['ask', 'APPROVAL_REQUIRED']]) {
      const tools = createSkillTools(new Map([['demo', snapshot(files())]]), root, { mode: mode!, approved: () => false, enable: async () => {}, protectedNames: [] })
      await expect(tools[1]!.execute({ skill: 'demo', destination: 'out' }, context)).rejects.toThrow(code!)
    }
  })
  it('requires ordinary approval for local publication and forbids it in read-only mode', async () => {
    const creator = await createBuiltinSkillCapabilityPack().activate({ workspaceRoot: root, selectedSkills: ['skill-creator'], config: {}, signal: context.signal })
    for (const [mode, code] of [['read-only', 'TOOL_DISABLED_READ_ONLY'], ['ask', 'APPROVAL_REQUIRED']]) {
      const tools = createSkillTools(creator.skillSnapshots!, root, { mode: mode!, approved: () => false, enable: async () => {}, protectedNames: listBuiltinSkills() })
      await expect(tools.find(tool => tool.manifest.name === 'skills.installLocal')!.execute({ directory: 'draft' }, context)).rejects.toThrow(code!)
    }
  })
  it('creates, validates, installs and invokes a skill using the offline built-in creator', async () => {
    const creator = await createBuiltinSkillCapabilityPack().activate({ workspaceRoot: root, selectedSkills: ['skill-creator'], config: {}, signal: context.signal })
    expect(creator.instructions?.[0]).toContain('skills.installLocal')
    expect(creator.instructions?.[0]).not.toContain('claude -p')
    expect(creator.skillSnapshots!.get('skill-creator')!.files.has('LICENSE.txt')).toBe(true)
    const tools = createSkillTools(creator.skillSnapshots!, root, { mode: 'auto', approved: () => true, enable: async () => {}, protectedNames: listBuiltinSkills() })
    await mkdir(join(root, 'draft')); for (const [path, data] of files()) { await mkdir(join(root, 'draft', path, '..'), { recursive: true }); await writeFile(join(root, 'draft', path), data) }
    expect(await tools.find(tool => tool.manifest.name === 'skills.validate')!.execute({ directory: 'draft' }, context)).toMatchObject({ valid: true, name: 'demo' })
    await tools.find(tool => tool.manifest.name === 'skills.installLocal')!.execute({ directory: 'draft' }, context)
    const installed = await createSkillCapabilityPack().activate({ workspaceRoot: root, selectedSkills: ['demo'], config: {}, signal: context.signal })
    expect(installed.instructions?.[0]).toContain('A useful example')
  })
})
