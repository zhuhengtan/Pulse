import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SkillMarketplace, skillView, type RemoteSkill } from './skill-marketplace.js'
import { builtinSkillContents } from './builtin-skills-content.js'
import { skillCreatorFiles } from './skill-creator-content.js'
import { readSkillDirectory, skillRoot, snapshot, publishSkill, receipt, uninstallSkill } from './skill-store.js'

export class SkillManagement {
  private readonly marketplace = new SkillMarketplace()
  private readonly previews = new Map<string, { expires: number; skills: RemoteSkill[] }>()
  private protectedNames = builtinSkillContents.map(skill => skill.name)
  async search(query: string) { return { skills: await this.marketplace.search(query) } }
  async inspect(source: string) {
    this.previews.clear()
    const skills = await this.marketplace.discover(source)
    const size = skills.reduce((total, skill) => total + [...skill.files.values()].reduce((sum, bytes) => sum + bytes.length, 0), 0)
    if (size > 60 * 1024 * 1024) throw new Error('SKILL_PREVIEW_TOO_LARGE')
    const previewId = randomUUID()
    this.previews.set(previewId, { expires: Date.now() + 10 * 60_000, skills })
    return { previewId, skills: skills.map(skill => skillView(skill)) }
  }
  async installed() {
    const builtin = builtinSkillContents.map(skill => ({ name: skill.name, description: skill.description, builtin: true, managed: false, modified: false }))
    const entries = await readdir(skillRoot(), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const local = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory() || this.protectedNames.includes(entry.name)) continue
      try {
        const skill = snapshot(await readSkillDirectory(join(skillRoot(), entry.name))), origin = await receipt(entry.name)
        local.push({ name: entry.name, description: skill.description, builtin: false, managed: !!origin, modified: !!origin && origin.hash !== skill.hash, origin: origin?.origin })
      } catch { local.push({ name: entry.name, description: '技能目录需要检查', builtin: false, managed: false, modified: true }) }
    }
    return { skills: [...builtin, ...local] }
  }
  async detail(name: string) {
    const builtin = builtinSkillContents.find(skill => skill.name === name)
    if (builtin) {
      if (name === 'skill-creator') return { ...skillView(snapshot(new Map(Object.entries(skillCreatorFiles).map(([path, text]) => [path, Buffer.from(text)])))), builtin: true }
      return { name, description: builtin.description, content: builtin.content, files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(builtin.content) }], warnings: [], builtin: true }
    }
    // receipt validates the name even for manually installed skills.
    const prior = await receipt(name), skill = snapshot(await readSkillDirectory(join(skillRoot(), name)))
    return { ...skillView({ ...skill, ...(prior?.origin ? { origin: prior.origin } : {}) }), builtin: false }
  }
  async install(input: { previewId: string; name: string; directory: string }, enable: (name: string) => Promise<void>) {
    const preview = this.previews.get(input.previewId)
    if (!preview || preview.expires < Date.now()) throw new Error('SKILL_PREVIEW_EXPIRED')
    const found = preview.skills.filter(skill => skill.name === input.name && skill.origin.directory === input.directory)
    if (found.length !== 1) throw new Error('SKILL_AMBIGUOUS')
    const skill = found[0]!
    const installed = await publishSkill(skill, { origin: skill.origin, enable, protectedNames: this.protectedNames })
    return { name: installed.name, hash: installed.hash }
  }
  async update(name: string, enable: (name: string) => Promise<void>) {
    if (this.protectedNames.includes(name)) throw new Error('SKILL_BUILTIN_PROTECTED')
    const prior = await receipt(name)
    if (!prior?.origin) throw new Error('SKILL_NOT_REMOTE_MANAGED')
    // Check local edits before making a network request and again at commit time.
    if (snapshot(await readSkillDirectory(join(skillRoot(), name))).hash !== prior.hash) throw new Error('SKILL_LOCALLY_MODIFIED')
    const source = `https://github.com/${prior.origin.repository}/tree/${encodeURIComponent(prior.origin.ref)}${prior.origin.directory ? '/' + prior.origin.directory : ''}`
    const skill = await this.marketplace.resolve(source, name, prior.origin.directory)
    const installed = await publishSkill(skill, { origin: skill.origin, update: true, enable, protectedNames: this.protectedNames })
    return { name, hash: installed.hash }
  }
  async uninstall(name: string) { await uninstallSkill(name, this.protectedNames); return { name } }
}
