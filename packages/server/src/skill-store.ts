import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { pulseHomePath } from './paths.js'

export const skillLimits = { files: 1000, fileBytes: 8 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, bodyBytes: 64 * 1024 }
export type SkillFiles = Map<string, Buffer>
export interface SkillMetadata { name: string; description: string; compatibility?: string; license?: string }
export interface SkillSnapshot extends SkillMetadata { files: SkillFiles; hash: string; warnings: string[] }
export interface SkillOrigin { repository: string; directory: string; commit: string; ref: string }
export interface SkillReceipt { schemaVersion: 1; name: string; hash: string; files: Record<string, string>; installedAt: string; origin?: SkillOrigin }
export const skillRoot = () => join(pulseHomePath(), 'skills')
const receiptName = '.pulse-install.json'
export function skillPath(path: string): string {
  if (!path || path.length > 1024 || path.includes('\\') || path.includes('\0') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('SKILL_PATH_INVALID')
  return path
}
export function skillName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('INVALID_SKILL_NAME')
  return name
}
export function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('SKILL_FILE_NOT_UTF8') }
}
export function metadata(bytes: Buffer): SkillMetadata {
  if (bytes.length > skillLimits.bodyBytes) throw new Error('SKILL_FILE_BYTES_LIMIT_EXCEEDED')
  const body = utf8(bytes), match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)
  if (!match) throw new Error('SKILL_FRONTMATTER_REQUIRED')
  const doc = parseDocument(match[1]!, { uniqueKeys: true })
  if (doc.errors.length) throw new Error('SKILL_FRONTMATTER_INVALID')
  const data = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024) throw new Error('SKILL_METADATA_INVALID')
  skillName(data.name)
  if (data.compatibility !== undefined && (typeof data.compatibility !== 'string' || data.compatibility.length > 500)) throw new Error('SKILL_COMPATIBILITY_INVALID')
  return { name: data.name, description: data.description, ...(typeof data.compatibility === 'string' ? { compatibility: data.compatibility } : {}), ...(typeof data.license === 'string' ? { license: data.license } : {}) }
}
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function snapshot(files: SkillFiles): SkillSnapshot {
  if (!files.has('SKILL.md')) throw new Error('SKILL_MD_REQUIRED')
  if (files.size > skillLimits.files) throw new Error('SKILL_FILE_LIMIT_EXCEEDED')
  let total = 0
  const folded = new Set<string>(), hashes: Record<string, string> = Object.create(null)
  for (const [path, bytes] of files) {
    skillPath(path)
    if (path === receiptName || folded.has(path.toLowerCase())) throw new Error('SKILL_FILE_COLLISION')
    folded.add(path.toLowerCase())
    total += bytes.length
    if (bytes.length > skillLimits.fileBytes || total > skillLimits.totalBytes) throw new Error('SKILL_BYTES_LIMIT_EXCEEDED')
    hashes[path] = digest(bytes)
  }
  const info = metadata(files.get('SKILL.md')!), warnings: string[] = []
  const body = utf8(files.get('SKILL.md')!).replace(/```[\s\S]*?```/g, '')
  for (const match of body.matchAll(/\]\(([^\s)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1]!
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue
    if (!files.has(target) && ![...files.keys()].some(path => path.startsWith(target.replace(/\/$/, '') + '/'))) warnings.push(`引用文件不存在：${target}`)
  }
  const hash = digest(Buffer.from(JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
  return { ...info, files: new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)])), hash, warnings }
}
/** No symlink components or special files; all resource bytes are captured at activation. */
export async function readSkillDirectory(directory: string): Promise<SkillFiles> {
  const base = await realpath(dirname(directory)), path = join(base, directory.split(/[\\/]/).pop()!)
  if ((await lstat(path)).isSymbolicLink() || !(await lstat(path)).isDirectory()) throw new Error('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED')
  const files: SkillFiles = new Map(); let total = 0, visited = 0
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('SKILL_DIRECTORY_DEPTH_EXCEEDED')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 2000) throw new Error('SKILL_FILE_LIMIT_EXCEEDED')
      if (entry.name === receiptName && !prefix) continue
      const name = skillPath(prefix + entry.name), target = join(dir, entry.name), info = await lstat(target)
      if (info.isSymbolicLink()) throw new Error('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED')
      if (info.isDirectory()) { await walk(target, name + '/', depth + 1); continue }
      if (!info.isFile()) throw new Error('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED')
      if (info.size > skillLimits.fileBytes || files.size >= skillLimits.files || total + info.size > skillLimits.totalBytes) throw new Error('SKILL_BYTES_LIMIT_EXCEEDED')
      if (await realpath(target) !== target) throw new Error('SKILL_SYMLINK_OR_PATH_TRAVERSAL_REJECTED')
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const current = await handle.stat()
        if (!current.isFile() || current.size > skillLimits.fileBytes) throw new Error('SKILL_BYTES_LIMIT_EXCEEDED')
        const bytes = await handle.readFile(); total += bytes.length
        if (bytes.length > skillLimits.fileBytes || total > skillLimits.totalBytes) throw new Error('SKILL_BYTES_LIMIT_EXCEEDED')
        files.set(name, bytes)
      } finally { await handle.close() }
    }
  }
  await walk(path, '', 0)
  return files
}
export async function writeSkillFiles(directory: string, files: SkillFiles): Promise<void> {
  for (const [path, bytes] of files) {
    skillPath(path)
    const file = join(directory, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
  }
}
export async function withSkillLock<T>(work: () => Promise<T>): Promise<T> {
  const root = skillRoot(); await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('SKILL_TRUSTED_ROOT_INVALID')
  const lock = join(root, '.store-lock')
  const deadline = Date.now() + 10_000
  for (;;) {
    try { await mkdir(lock); await writeFile(join(lock, 'owner'), String(process.pid), { flag: 'wx' }); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => '0'))
      let alive = true
      if (owner > 0) { try { process.kill(owner, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false } }
      if (!alive) { await rm(lock, { recursive: true, force: true }); continue }
      if (Date.now() >= deadline) throw new Error('SKILL_STORE_BUSY')
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
  }
  try { return await work() } finally { await rm(lock, { recursive: true, force: true }) }
}
export async function receipt(name: string): Promise<SkillReceipt | undefined> {
  const directory = join(skillRoot(), skillName(name)), target = join(directory, receiptName)
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED')
    if (!(await lstat(target)).isFile() || (await lstat(target)).isSymbolicLink() || (await lstat(target)).size > 1024 * 1024) throw new Error('SKILL_RECEIPT_INVALID')
    const value = JSON.parse(await readFile(target, 'utf8')) as SkillReceipt
    if (value.schemaVersion !== 1 || value.name !== name || typeof value.hash !== 'string' || !value.files || typeof value.files !== 'object') throw new Error('SKILL_RECEIPT_INVALID')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function publishSkill(skill: SkillSnapshot, options: { origin?: SkillOrigin; update?: boolean; enable?: (name: string) => Promise<void>; protectedNames?: readonly string[] } = {}): Promise<SkillReceipt> {
  skillName(skill.name)
  if (options.protectedNames?.includes(skill.name)) throw new Error('SKILL_BUILTIN_PROTECTED')
  return withSkillLock(async () => {
    const root = skillRoot(), target = join(root, skill.name), stage = join(root, `.stage-${randomUUID()}`), backup = join(root, `.backup-${randomUUID()}`)
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing && !options.update) throw new Error('SKILL_ALREADY_INSTALLED')
    if (options.update) {
      if (!existing) throw new Error('SKILL_NOT_FOUND')
      const prior = await receipt(skill.name)
      if (!prior || snapshot(await readSkillDirectory(target)).hash !== prior.hash) throw new Error('SKILL_LOCALLY_MODIFIED')
    }
    const value: SkillReceipt = { schemaVersion: 1, name: skill.name, hash: skill.hash, files: Object.fromEntries([...skill.files].map(([path, bytes]) => [path, digest(bytes)])), installedAt: new Date().toISOString(), ...(options.origin ? { origin: options.origin } : {}) }
    let moved = false, published = false
    try {
      await mkdir(stage); await writeSkillFiles(stage, skill.files); await writeFile(join(stage, receiptName), JSON.stringify(value, null, 2), { mode: 0o600 })
      if (existing) { await rename(target, backup); moved = true }
      await rename(stage, target); published = true
      await options.enable?.(skill.name)
    } catch (error) {
      if (published) await rm(target, { recursive: true, force: true })
      if (moved) await rename(backup, target)
      throw error
    } finally { await rm(stage, { recursive: true, force: true }) }
    await rm(backup, { recursive: true, force: true })
    return value
  })
}
export async function uninstallSkill(name: string, protectedNames: readonly string[]): Promise<void> {
  skillName(name)
  if (protectedNames.includes(name)) throw new Error('SKILL_BUILTIN_PROTECTED')
  await withSkillLock(async () => {
    const prior = await receipt(name)
    if (!prior) throw new Error('SKILL_NOT_MANAGED')
    const target = join(skillRoot(), name)
    if (snapshot(await readSkillDirectory(target)).hash !== prior.hash) throw new Error('SKILL_LOCALLY_MODIFIED')
    const removed = join(skillRoot(), `.removed-${randomUUID()}`)
    await rename(target, removed); await rm(removed, { recursive: true, force: true })
  })
}
