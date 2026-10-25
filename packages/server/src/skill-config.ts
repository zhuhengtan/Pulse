import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function withEnabledSkill(config: Record<string, unknown>, name: string): Record<string, unknown> {
  const caps = (config.capabilities ?? {}) as Record<string, unknown>
  if (!caps || typeof caps !== 'object' || Array.isArray(caps) || caps.enabled !== undefined && !Array.isArray(caps.enabled) || caps.skills !== undefined && !Array.isArray(caps.skills)) throw new Error('INVALID_SKILL_CONFIGURATION')
  return { ...config, capabilities: { ...caps, enabled: [...new Set([...(caps.enabled as string[] ?? []), 'skills'])], ...(Array.isArray(caps.skills) ? { skills: [...new Set([...caps.skills, name])] } : {}) } }
}
/** Same optimistic version check used by the configuration API; unrelated fields are preserved. */
export async function enableSkillConfig(path: string, name: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error })
  const config = JSON.parse(current) as Record<string, unknown>
  const text = JSON.stringify(withEnabledSkill(config, name), null, 2) + '\n', temporary = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    if (await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error }) !== current) throw new Error('CONFIG_VERSION_CONFLICT')
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
