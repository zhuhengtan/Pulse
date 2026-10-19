import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { replaceStateFile } from '../packages/server/src/atomic-file.js'

const faults = vi.hoisted(() => ({ remaining: 0, code: 'EPERM', attempts: 0, prior: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (source: string, target: string) => {
    faults.attempts++
    if (faults.remaining-- > 0) {
      faults.prior.push(await fs.readFile(target, 'utf8'))
      throw Object.assign(new Error('Windows sharing violation'), { code: faults.code })
    }
    return fs.rename(source, target)
  } }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  faults.remaining = 0; faults.attempts = 0; faults.prior = []
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(os: string, code: string, remaining: number) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-state-replace-')); roots.push(root)
  const source = join(root, 'state.tmp'), target = join(root, 'state.json')
  await writeFile(source, 'new state'); await writeFile(target, 'old state')
  Object.defineProperty(process, 'platform', { ...platform, value: os })
  Object.assign(faults, { code, remaining })
  return { source, target }
}

it.each(['EPERM', 'EACCES', 'EBUSY'])('preserves the readable prior state across a transient Windows %s', async code => {
  const { source, target } = await fixture('win32', code, 2)
  await replaceStateFile(source, target)
  expect(faults.prior).toEqual(['old state', 'old state'])
  expect(await readFile(target, 'utf8')).toBe('new state')
  await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('bounds Windows sharing retries and preserves both files on permanent failure', async () => {
  const { source, target } = await fixture('win32', 'EPERM', 100)
  await expect(replaceStateFile(source, target)).rejects.toMatchObject({ code: 'EPERM' })
  expect(faults.attempts).toBeLessThanOrEqual(10)
  expect(await readFile(target, 'utf8')).toBe('old state')
  expect(await readFile(source, 'utf8')).toBe('new state')
})

it.each([['linux', 'EPERM'], ['win32', 'ENOENT']])('propagates %s %s without retrying', async (os, code) => {
  const { source, target } = await fixture(os, code, 2)
  await expect(replaceStateFile(source, target)).rejects.toMatchObject({ code })
  expect(faults.attempts).toBe(1)
  expect(await readFile(target, 'utf8')).toBe('old state')
})
