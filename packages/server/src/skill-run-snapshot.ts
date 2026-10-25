import { lstat, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { skillLimits, skillPath, type SkillSnapshot } from './skill-store.js'

export async function loadRunSkills(path: string): Promise<Map<string, SkillSnapshot> | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('SKILL_RUN_SNAPSHOT_INVALID')
    const values = JSON.parse(await readFile(path, 'utf8')) as Array<Omit<SkillSnapshot, 'files'> & { files: Array<[string, string]> }>
    if (!Array.isArray(values) || values.length > 32) throw new Error('SKILL_RUN_SNAPSHOT_INVALID')
    let total = 0
    return new Map(values.map(value => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name) || !Array.isArray(value.files) || value.files.length > skillLimits.files) throw new Error('SKILL_RUN_SNAPSHOT_INVALID')
      const files = new Map(value.files.map(([path, encoded]) => { skillPath(path); const bytes = Buffer.from(encoded, 'base64'); total += bytes.length; if (bytes.length > skillLimits.fileBytes || total > 40 * 1024 * 1024) throw new Error('SKILL_BYTES_LIMIT_EXCEEDED'); return [path, bytes] }))
      if (!files.has('SKILL.md')) throw new Error('SKILL_MD_REQUIRED')
      return [value.name, { ...value, files }]
    }))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function saveRunSkills(path: string, skills: Map<string, SkillSnapshot>): Promise<void> {
  const text = JSON.stringify([...skills.values()].map(value => ({ ...value, files: [...value.files].map(([path, bytes]) => [path, bytes.toString('base64')]) })))
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('SKILL_BYTES_LIMIT_EXCEEDED')
  const temporary = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), { recursive: true })
  try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}
