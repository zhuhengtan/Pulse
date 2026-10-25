import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileRuntimePersistenceBackend, PulseRuntime } from '@hunterzhu/pulse-runtime'

const faults = vi.hoisted(() => ({ remaining: 0, attempts: 0, code: 'EPERM', prior: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (source: string, target: string) => {
    if (target.endsWith('runtime.json')) {
      faults.attempts++
      if (faults.remaining-- > 0) {
        faults.prior.push(await fs.readFile(target, 'utf8'))
        throw Object.assign(new Error('Windows sharing violation'), { code: faults.code })
      }
    }
    return fs.rename(source, target)
  } }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  Object.assign(faults, { remaining: 0, attempts: 0, code: 'EPERM', prior: [] })
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(os: string, code: string, remaining: number) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-runtime-sharing-')); roots.push(root)
  const backend = new FileRuntimePersistenceBackend(join(root, 'runtime.json'))
  const first = new PulseRuntime(); first.state.now = 1
  const before = first.exportPersistence()
  await backend.save(before)
  const prior = await readFile(backend.filePath, 'utf8')
  const second = new PulseRuntime(); second.state.now = 2
  Object.defineProperty(process, 'platform', { ...platform, value: os })
  Object.assign(faults, { code, remaining, attempts: 0 })
  return { root, backend, prior, before, next: second.exportPersistence() }
}

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries transient Windows %s while retaining the committed snapshot and digest guard', async code => {
  const { root, backend, before, prior, next } = await fixture('win32', code, 2)
  await backend.save(next, before.integrity!.digest)
  expect(faults.prior).toEqual([prior, prior])
  expect((await backend.load())?.state.state.now).toBe(2)
  await expect(backend.save(before, before.integrity!.digest)).rejects.toThrow('RUNTIME_PERSISTENCE_CONFLICT')
  expect(await readdir(root)).toEqual(['runtime.json'])
})

it('propagates persistent sharing failures, cleans temporary files, and permits a later valid save', async () => {
  const { root, backend, before, prior, next } = await fixture('win32', 'EPERM', 100)
  await expect(backend.save(next, before.integrity!.digest)).rejects.toMatchObject({ code: 'EPERM' })
  expect(faults.attempts).toBe(10)
  expect(await readFile(backend.filePath, 'utf8')).toBe(prior)
  expect(await readdir(root)).toEqual(['runtime.json'])
  faults.remaining = 0
  await backend.save(next, before.integrity!.digest)
  expect((await backend.load())?.state.state.now).toBe(2)
})

it.each([['linux', 'EPERM'], ['win32', 'ENOENT']])('propagates %s %s without masking a different filesystem failure', async (os, code) => {
  const { backend, before, prior, next } = await fixture(os, code, 2)
  await expect(backend.save(next, before.integrity!.digest)).rejects.toMatchObject({ code })
  expect(faults.attempts).toBe(1)
  expect(await readFile(backend.filePath, 'utf8')).toBe(prior)
})
