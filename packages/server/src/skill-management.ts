import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { SkillMarketplace, skillView, type RemoteSkill } from './skill-marketplace.js'
import { builtinSkillContents } from './builtin-skills-content.js'
import { skillCreatorFiles } from './skill-creator-content.js'
import { readSkillDirectory, skillRoot, skillName, snapshot, publishSkill, receipt, uninstallSkill, type SkillOrigin } from './skill-store.js'

interface SkillUpdate {
  status: 'current' | 'available' | 'error'
  checkedAt: string
  latestCommit?: string
  error?: string
}
type CheckedUpdate = SkillUpdate & { identity: string }
const identity = (hash: string, origin: SkillOrigin) => JSON.stringify([hash, origin.repository, origin.directory, origin.ref, origin.commit])
const sourceOf = (origin: SkillOrigin) => `https://github.com/${origin.repository}/tree/${encodeURIComponent(origin.ref)}${origin.directory ? '/' + origin.directory.split('/').map(encodeURIComponent).join('/') : ''}`
const builtinVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version

export class SkillManagement {
  private readonly marketplace = new SkillMarketplace()
  private readonly previews = new Map<string, { expires: number; skills: RemoteSkill[] }>()
  private protectedNames = builtinSkillContents.map(skill => skill.name)
  private readonly updates = new Map<string, CheckedUpdate>()
  private readonly checking = new Map<string, Promise<void>>()
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
    const builtin = builtinSkillContents.map(skill => ({ name: skill.name, description: skill.description, builtin: true, managed: false, modified: false, version: builtinVersion }))
    const entries = await readdir(skillRoot(), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const local = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory() || this.protectedNames.includes(entry.name)) continue
      try {
        const skill = snapshot(await readSkillDirectory(join(skillRoot(), entry.name))), origin = await receipt(entry.name)
        const checked = origin?.origin && this.updates.get(entry.name)
        const update = checked && origin?.origin && checked.identity === identity(origin.hash, origin.origin) ? { status: checked.status, checkedAt: checked.checkedAt, latestCommit: checked.latestCommit, error: checked.error } : undefined
        local.push({ name: entry.name, description: skill.description, builtin: false, managed: !!origin, modified: !!origin && origin.hash !== skill.hash, version: origin?.origin?.commit ?? skill.hash, origin: origin?.origin, update })
      } catch { local.push({ name: entry.name, description: '技能目录需要检查', builtin: false, managed: false, modified: true }) }
    }
    return { skills: [...builtin, ...local] }
  }
  /** Checking never changes skill files, receipts or configuration. Failures stay per skill. */
  async checkUpdates(name?: string) {
    if (name !== undefined) skillName(name)
    const { skills } = await this.installed()
    const selected = skills.filter(item => (!name || item.name === name) && 'origin' in item && item.origin)
    if (name && !selected.length) throw new Error('SKILL_NOT_REMOTE_MANAGED')
    const queue = [...selected]
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const selectedName = item.name
        let checking = this.checking.get(selectedName)
        if (!checking) {
          checking = this.checkUpdate(selectedName).finally(() => this.checking.delete(selectedName))
          this.checking.set(selectedName, checking)
        }
        await checking
      }
    }))
    return this.installed()
  }
  private async checkUpdate(name: string): Promise<void> {
    const prior = await receipt(name)
    if (!prior?.origin) return
    const key = identity(prior.hash, prior.origin), checkedAt = new Date().toISOString()
    try {
      const source = sourceOf(prior.origin), commit = await this.marketplace.latestCommit(source)
      const latest = commit === prior.origin.commit ? undefined : await this.marketplace.resolve(source, name, prior.origin.directory, commit)
      this.updates.set(name, { identity: key, checkedAt, latestCommit: commit, status: !latest || latest.hash === prior.hash ? 'current' : 'available' })
    } catch (error) {
      this.updates.set(name, { identity: key, checkedAt, status: 'error', error: error instanceof Error ? error.message : 'SKILL_UPDATE_CHECK_FAILED' })
    }
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
    this.updates.delete(skill.name)
    return { name: installed.name, hash: installed.hash }
  }
  async update(name: string, enable: (name: string) => Promise<void>, expectedCommit?: string) {
    if (this.protectedNames.includes(name)) throw new Error('SKILL_BUILTIN_PROTECTED')
    const prior = await receipt(name)
    if (!prior?.origin) throw new Error('SKILL_NOT_REMOTE_MANAGED')
    // Check local edits before making a network request and again at commit time.
    if (snapshot(await readSkillDirectory(join(skillRoot(), name))).hash !== prior.hash) throw new Error('SKILL_LOCALLY_MODIFIED')
    const skill = await this.marketplace.resolve(sourceOf(prior.origin), name, prior.origin.directory)
    if (expectedCommit !== undefined && skill.origin.commit !== expectedCommit) { this.updates.delete(name); throw new Error('SKILL_UPDATE_CHANGED') }
    const installed = await publishSkill(skill, { origin: skill.origin, update: true, enable, protectedNames: this.protectedNames })
    this.updates.set(name, { identity: identity(installed.hash, skill.origin), status: 'current', latestCommit: skill.origin.commit, checkedAt: new Date().toISOString() })
    return { name, hash: installed.hash, version: skill.origin.commit }
  }
  async uninstall(name: string) { await uninstallSkill(name, this.protectedNames); this.updates.delete(name); return { name } }
}
