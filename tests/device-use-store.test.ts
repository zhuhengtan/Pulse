import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceStore } from '../packages/server/src/device-use/store.js'
import { HostDeviceService } from '../packages/server/src/device-use/host.js'
import { SceneSandbox } from '../packages/server/src/device-use/scene-sandbox.js'
import { TestDeviceStore } from './helpers/device-store.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open), lstat: vi.fn(actual.lstat), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})
const directories: string[] = []
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks(); vi.clearAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-device-store-')); directories.push(directory)
  return { directory, path: join(directory, 'private', 'ledger.json') }
}

it.each([true, false])('refuses Windows private ledger access before any I/O or callback (write=%s)', async write => {
  const { directory, path } = await fixture(), change = vi.fn(ledger => ledger.commands)
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  await expect(new DeviceStore(path).transaction(change, write)).rejects.toThrow('DEVICE_STORE_PRIVATE_STORAGE_UNSUPPORTED')
  expect(change).not.toHaveBeenCalled()
  for (const operation of [fs.mkdir, fs.open, fs.lstat, fs.readFile, fs.rename, fs.unlink]) expect(operation).not.toHaveBeenCalled()
  expect(await readdir(directory)).toEqual([])
})

it('persists and reopens a private ledger only on a supported platform', async () => {
  const { directory, path } = await fixture(), store = new DeviceStore(path)
  if (process.platform === 'win32') {
    await expect(store.transaction(ledger => ledger.enrolled.push('device'))).rejects.toThrow('DEVICE_STORE_PRIVATE_STORAGE_UNSUPPORTED')
    expect(await readdir(directory)).toEqual([])
    return
  }
  await store.transaction(ledger => ledger.enrolled.push('device'))
  expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(path, 'utf8')).enrolled).toEqual(['device'])
  const reopened = new DeviceStore(path)
  expect(await reopened.transaction(ledger => ledger.enrolled, false)).toEqual(['device'])
  await expect(reopened.transaction(ledger => { ledger.enrolled.push('not-committed'); throw new Error('abort') })).rejects.toThrow('abort')
  await expect(reopened.transaction(ledger => { (ledger as any).version = 2 })).rejects.toThrow()
  expect(await store.transaction(ledger => ledger.enrolled, false)).toEqual(['device'])
  expect((await readdir(join(directory, 'private'))).sort()).toEqual(['ledger.json', 'ledger.json.owner'])
})

it.each(['file', 'directory'] as const)('propagates %s fsync failures instead of acknowledging a durable commit', async kind => {
  const { directory, path } = await fixture(), store = new DeviceStore(path)
  if (process.platform === 'win32') {
    await expect(store.transaction(ledger => ledger.enrolled.push('device'))).rejects.toThrow('DEVICE_STORE_PRIVATE_STORAGE_UNSUPPORTED')
    expect(await readdir(directory)).toEqual([])
    return
  }
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const failure = Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' })
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    if (kind === 'file' ? String(args[0]).endsWith('.tmp') : String(args[0]) === join(directory, 'private')) vi.spyOn(handle, 'sync').mockRejectedValue(failure)
    return handle
  })
  await expect(store.transaction(ledger => ledger.enrolled.push('device'))).rejects.toBe(failure)
  expect((await readdir(join(directory, 'private'))).some(name => name.endsWith('.tmp'))).toBe(false)
  if (kind === 'file') await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(JSON.parse(await readFile(path, 'utf8')).enrolled).toEqual(['device'])
})

it('keeps the volatile fixture serialized, isolated and strict across reopened instances', async () => {
  const { directory, path } = await fixture(), store = new TestDeviceStore(path, false), reopened = store.reopen()
  await Promise.all([store.transaction(ledger => ledger.enrolled.push('first')), reopened.transaction(ledger => ledger.enrolled.push('second'))])
  const result = await store.transaction(ledger => ledger.enrolled, false); result.push('outside')
  await reopened.transaction(ledger => ledger.enrolled.push('read-only'), false)
  await expect(store.transaction(ledger => { ledger.enrolled.push('aborted'); throw new Error('abort') })).rejects.toThrow('abort')
  await expect(reopened.transaction(ledger => { (ledger as any).version = 2 })).rejects.toThrow()
  expect(await reopened.transaction(ledger => ledger.enrolled, false)).toEqual(['first', 'second'])
  await reopened.writeText('{broken')
  await expect(store.transaction(ledger => ledger.enrolled, false)).rejects.toThrow()
  expect(await readdir(directory)).toEqual([])
})

it('keeps the real Windows Host disabled and cleans up a refused temporary scene ledger', async () => {
  const { directory } = await fixture(), host = new HostDeviceService(directory), sandbox = new SceneSandbox()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const temporary: string[] = []
  vi.mocked(fs.mkdtemp).mockImplementation(async (...args) => {
    const path = await actual.mkdtemp(...args); temporary.push(String(path)); return path
  })
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  vi.clearAllMocks()
  try {
    expect((await host.activation()).tools).toEqual([])
    await expect(host.configure({ enabled: true, mode: 'simulator' })).rejects.toThrow('DEVICE_HOST_PRIVATE_STORAGE_UNSUPPORTED')
    expect((await host.activation()).tools).toEqual([])
    await expect(sandbox.act({ action: 'enable' }, 'local-owner')).rejects.toThrow('DEVICE_STORE_PRIVATE_STORAGE_UNSUPPORTED')
    expect(sandbox.snapshot()).toMatchObject({ enabled: false, cleanup: { state: 'completed' } })
    expect(temporary).toHaveLength(1)
    for (const path of temporary) await expect(actual.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.open).not.toHaveBeenCalled(); expect(fs.rename).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  } finally { await sandbox.close(); await host.close() }
})
