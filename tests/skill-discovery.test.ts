import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillCapabilityPack } from '../packages/server/src/skill-pack.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { searchSlashSuggestions, skillSuggestions } from '../packages/cli/src/utils/slashCompletion.js'

describe('lazy skills', () => {
  it('indexes names without reading bodies, refreshes removals and excludes unsafe or ambiguous entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-index-'))
    try {
      for (const name of ['valid', 'invalid-utf8', 'linked', 'duplicate']) await mkdir(join(root, name))
      await writeFile(join(root, 'valid', 'SKILL.md'), 'PRIVATE_BODY')
      await writeFile(join(root, 'invalid-utf8', 'SKILL.md'), Buffer.from([0xff]))
      await symlink(join(root, 'valid', 'SKILL.md'), join(root, 'linked', 'SKILL.md'))
      const other = join(root, 'other')
      await mkdir(join(other, 'duplicate'), { recursive: true })
      await writeFile(join(other, 'duplicate', 'SKILL.md'), 'second')
      await writeFile(join(root, 'duplicate', 'SKILL.md'), 'first')
      const pack = createSkillCapabilityPack({ trustedRoots: [root, other] })
      const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), capabilityPacks: [pack], enabledCapabilityPacks: ['skills'] })
      try {
        expect(await host.listSkills()).toEqual(['invalid-utf8', 'valid'])
        const index = await readFile(join(root, 'data', 'skills-index.json'), 'utf8')
        expect(index).not.toContain('PRIVATE_BODY')
        expect(JSON.parse(index).skills).toEqual(['invalid-utf8', 'valid'])
        expect((await pack.activate({ workspaceRoot: root, config: { skills: ['valid'] }, signal: new AbortController().signal })).instructions).toEqual([])
        await expect(pack.activate({ workspaceRoot: root, config: {}, selectedSkills: ['invalid-utf8'], signal: new AbortController().signal })).rejects.toThrow('SKILL_FILE_NOT_UTF8')
        await rm(join(root, 'valid'), { recursive: true })
        expect(await host.listSkills()).toEqual(['invalid-utf8'])
        expect(await pack.discoverSkills!({ skills: [] })).toEqual([])
      } finally { await host.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('injects the selected body for one run only and reloads current content at invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-lazy-host-'))
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requests.push(String(options.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: false, provider: { provider: 'openai', defaultModel: 'test' }, capabilityPacks: [createSkillCapabilityPack({ trustedRoots: [root] })], enabledCapabilityPacks: ['skills'] })
    try {
      await mkdir(join(root, 'review'))
      await writeFile(join(root, 'review', 'SKILL.md'), 'OLD_SKILL_BODY')
      await host.init()
      await writeFile(join(root, 'review', 'SKILL.md'), 'CURRENT_SKILL_BODY')
      const conversation = await host.createConversation()
      const batches: string[] = []
      for (const text of ['hello', '/review inspect source', 'hello again', '/skill:review inspect again']) {
        const start = requests.length
        const run = await host.sendMessage(conversation.id, { text })
        for await (const _ of run.events) { /* consume runtime */ }
        expect((await run.outcome()).status).toBe('succeeded')
        expect(requests.length).toBeGreaterThan(start)
        batches.push(requests.slice(start).join('\n'))
      }
      expect(batches).toHaveLength(4)
      expect(batches[0]).not.toContain('CURRENT_SKILL_BODY')
      expect(batches[1]).toContain('CURRENT_SKILL_BODY')
      expect(batches[1]).not.toContain('OLD_SKILL_BODY')
      expect(batches[2]).not.toContain('CURRENT_SKILL_BODY')
      expect(batches[3]).toContain('CURRENT_SKILL_BODY')
    } finally { vi.unstubAllGlobals(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('searches names, ranks prefixes first and preserves built-in command collisions', () => {
    const commands = [{ name: '/help', description: 'help' }, { name: '/h', description: 'alias' }]
    const items = [...commands, ...skillSuggestions(['help', 'h', 'review', 'code-review'], commands)]
    expect(items.map(item => item.name)).toContain('/skill:help')
    expect(items.map(item => item.name)).toContain('/skill:h')
    expect(searchSlashSuggestions('/rev', items).map(item => item.name)).toEqual(['/review', '/code-review'])
    expect(searchSlashSuggestions('/review task', items)).toEqual([])
    expect(searchSlashSuggestions('ordinary /review', items)).toEqual([])
    expect(searchSlashSuggestions('/', items)).toHaveLength(items.length)
  })
})
