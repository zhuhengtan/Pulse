import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ConversationSummary } from '../index.js'
import type { WebProject } from '../protocol.js'

interface StoredProject {
  id: string
  name: string
  cwd: string
  createdAt: string
  updatedAt: string
  pinned: boolean
  previewUrl?: string
}

interface ProjectFile { schemaVersion: 1; projects: StoredProject[] }

function automaticProjectId(cwd: string): string {
  return `project-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`
}

export class H5ProjectCatalog {
  private readonly path: string
  private projects: StoredProject[] = []
  private loaded = false
  private pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string) { this.path = resolve(dataDir, 'h5-projects.json') }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as ProjectFile
      if (value.schemaVersion === 1 && Array.isArray(value.projects)) {
        this.projects = value.projects.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.cwd === 'string')
          .map(item => ({ ...item, cwd: resolve(item.cwd), pinned: item.pinned === true }))
      }
    } catch { this.projects = [] }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, projects: this.projects }, null, 2), { flag: 'wx', mode: 0o600 })
        await rename(temporary, this.path)
      } finally { await rm(temporary, { force: true }).catch(() => undefined) }
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }

  async list(): Promise<WebProject[]> {
    await this.load()
    return Promise.all(this.projects.map(async project => ({
      ...project,
      available: await lstat(project.cwd).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false),
    })))
  }

  async get(id: string): Promise<WebProject | undefined> { return (await this.list()).find(project => project.id === id) }

  async findByCwd(cwd: string): Promise<WebProject | undefined> {
    await this.load()
    const canonical = await realpath(resolve(cwd)).catch(() => resolve(cwd))
    const item = this.projects.find(project => project.cwd === canonical)
    return item ? this.get(item.id) : undefined
  }

  /** First-run migration groups historical conversations by their recorded work directory. */
  async migrate(conversations: ConversationSummary[]): Promise<void> {
    await this.load()
    let changed = false
    for (const conversation of conversations) {
      const canonical = await realpath(resolve(conversation.cwd)).catch(() => resolve(conversation.cwd))
      if (this.projects.some(project => project.cwd === canonical)) continue
      const base = canonical.split(/[\\/]/).filter(Boolean).at(-1) || '工作区'
      const now = new Date().toISOString()
      this.projects.push({ id: automaticProjectId(canonical), name: base, cwd: canonical, createdAt: now, updatedAt: now, pinned: false })
      changed = true
    }
    if (changed) await this.save()
  }

  async add(name: string, inputPath: string): Promise<WebProject> {
    await this.load()
    const cwd = await realpath(resolve(inputPath))
    if (!(await stat(cwd)).isDirectory()) throw new Error('PROJECT_DIRECTORY_REQUIRED')
    const existing = this.projects.find(item => item.cwd === cwd)
    if (existing) throw new Error('PROJECT_ALREADY_REGISTERED')
    const now = new Date().toISOString()
    const project: StoredProject = { id: `project-${randomUUID()}`, name: name.trim().slice(0, 80), cwd, createdAt: now, updatedAt: now, pinned: false }
    if (!project.name) throw new Error('PROJECT_NAME_REQUIRED')
    this.projects.unshift(project)
    await this.save()
    return { ...project, available: true }
  }

  async update(id: string, update: { name?: string; pinned?: boolean; previewUrl?: string | null }): Promise<WebProject> {
    await this.load()
    const project = this.projects.find(item => item.id === id)
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    if (update.name !== undefined) {
      const name = update.name.trim().slice(0, 80)
      if (!name) throw new Error('PROJECT_NAME_REQUIRED')
      project.name = name
    }
    if (update.pinned !== undefined) project.pinned = update.pinned
    if (update.previewUrl !== undefined) {
      if (update.previewUrl === null || update.previewUrl.trim() === '') delete project.previewUrl
      else {
        const url = new URL(update.previewUrl)
        if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || !url.port || Number(url.port) < 1024 || [7330, 7331, 7332, 11434].includes(Number(url.port)) || url.username || url.password) throw new Error('PREVIEW_URL_NOT_ALLOWED')
        project.previewUrl = url.origin
      }
    }
    project.updatedAt = new Date().toISOString()
    await this.save()
    return { ...project, available: await lstat(project.cwd).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false) }
  }

  async reorder(ids: string[]): Promise<void> {
    await this.load()
    if (ids.length !== this.projects.length || new Set(ids).size !== ids.length || ids.some(id => !this.projects.some(project => project.id === id))) throw new Error('PROJECT_ORDER_INVALID')
    const byId = new Map(this.projects.map(project => [project.id, project]))
    this.projects = ids.map(id => byId.get(id)!).map(project => ({ ...project, updatedAt: new Date().toISOString() }))
    await this.save()
  }

  async remove(id: string): Promise<void> {
    await this.load()
    const next = this.projects.filter(project => project.id !== id)
    if (next.length === this.projects.length) throw new Error('PROJECT_NOT_FOUND')
    this.projects = next
    await this.save()
  }
}
