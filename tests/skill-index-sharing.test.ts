import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'
import { createSkillCapabilityPack } from '../packages/server/src/skill-pack.js'

const faults = vi.hoisted(() => ({ remaining: 0, attempts: 0, code: 'EPERM', prior: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (source: string, target: string) => {
    if (target.endsWith('skills-index.json')) {
      faults.attempts++
      if (faults.remaining-- > 0) {
        faults.prior.push(await fs.readFile(target, 'utf8'))
        throw Object.assign(new Error('Windows sharing violation'), { code: faults.code })
      }
    }
    return fs.rename(source, target)
  } }
})

async function fixture(os: string, code: string, failures: number, run: (value: {
  host: ReturnType<typeof createLocalHost>; directory: string; index: string; prior: string
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-skill-index-sharing-'))
  const directory = join(root, 'data'), skills = join(root, 'skills'), index = join(directory, 'skills-index.json')
  await mkdir(join(skills, 'demo'), { recursive: true }); await mkdir(directory)
  await writeFile(join(skills, 'demo', 'SKILL.md'), 'PRIVATE_SKILL_BODY')
  const prior = JSON.stringify({ schemaVersion: 1, skills: ['old'] }); await writeFile(index, prior)
  const host = createLocalHost({ cwd: root, dataDir: directory, jarvis: { enabled: false }, capabilityPacks: [createSkillCapabilityPack({ trustedRoots: [skills] })], enabledCapabilityPacks: ['skills'] })
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: os })
    Object.assign(faults, { remaining: failures, attempts: 0, code, prior: [] })
    await run({ host, directory, index, prior })
  } finally {
    Object.defineProperty(process, 'platform', platform)
    faults.remaining = 0
    await host.close(); await rm(root, { recursive: true, force: true })
  }
}

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries transient Windows %s while preserving the readable skills index', async code => {
  await fixture('win32', code, 2, async ({ host, directory, index, prior }) => {
    expect(await host.listSkills()).toEqual(['demo'])
    expect(faults.prior).toEqual([prior, prior])
    expect(JSON.parse(await readFile(index, 'utf8'))).toEqual({ schemaVersion: 1, skills: ['demo'] })
    expect(await readFile(index, 'utf8')).not.toContain('PRIVATE_SKILL_BODY')
    expect((await readdir(directory)).filter(name => name.startsWith('skills-index.'))).toEqual(['skills-index.json'])
  })
})

it('bounds persistent sharing failures, preserves the prior index and cleans its temporary file', async () => {
  await fixture('win32', 'EPERM', 100, async ({ host, directory, index, prior }) => {
    await expect(host.listSkills()).rejects.toMatchObject({ code: 'EPERM' })
    expect(faults.attempts).toBeGreaterThan(1); expect(faults.attempts).toBeLessThanOrEqual(10)
    expect(await readFile(index, 'utf8')).toBe(prior)
    expect((await readdir(directory)).filter(name => name.startsWith('skills-index.'))).toEqual(['skills-index.json'])
  })
})

it.each([['linux', 'EPERM'], ['win32', 'ENOENT']])('propagates %s %s without hiding another filesystem error', async (os, code) => {
  await fixture(os, code, 2, async ({ host, index, prior }) => {
    await expect(host.listSkills()).rejects.toMatchObject({ code })
    expect(faults.attempts).toBe(1); expect(await readFile(index, 'utf8')).toBe(prior)
  })
})

it('keeps concurrent skill refreshes readable and leaves no temporary index files', async () => {
  await fixture('win32', 'EPERM', 2, async ({ host, directory, index }) => {
    expect(await Promise.all([host.listSkills(), host.listSkills()])).toEqual([['demo'], ['demo']])
    expect(faults.prior.every(text => JSON.parse(text).schemaVersion === 1)).toBe(true)
    expect(JSON.parse(await readFile(index, 'utf8')).skills).toEqual(['demo'])
    expect((await readdir(directory)).filter(name => name.startsWith('skills-index.'))).toEqual(['skills-index.json'])
  })
})
