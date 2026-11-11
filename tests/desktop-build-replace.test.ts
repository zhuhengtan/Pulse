import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rename, rm as remove } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { replaceInstalledDirectory } from '../scripts/automation/replace-installed-directory.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-replace-'))
  roots.push(root)
  const destination = join(root, 'native')
  const source = join(root, 'incoming')
  await mkdir(destination)
  await writeFile(join(destination, 'marker'), 'old')
  await mkdir(source)
  await writeFile(join(source, 'marker'), 'new')
  return { root, destination, source }
}

it('replaces a directory and removes the same-disk backup after success', async () => {
  const { root, destination, source } = await tree()
  await replaceInstalledDirectory(destination, source)
  expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('new')
  await expect(readFile(join(root, 'native.bak', 'marker'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(source, 'marker'), 'utf8')).rejects.toThrow()
})

it('restores the previous directory when the replacement fails', async () => {
  const { destination, source } = await tree()
  let calls = 0
  await expect(replaceInstalledDirectory(destination, source, {
    rename: async (from, to) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('injected'), { code: 'EIO' })
      await rename(from, to)
    },
    rm: remove,
  })).rejects.toThrow('injected')
  expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('old')
  expect(await readFile(join(source, 'marker'), 'utf8')).toBe('new')
})

it('does not invent a destination when the first install fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-replace-'))
  roots.push(root)
  const destination = join(root, 'native')
  const source = join(root, 'incoming')
  await mkdir(source)
  await writeFile(join(source, 'marker'), 'new')
  await expect(replaceInstalledDirectory(destination, source, {
    rename: async (from, to) => {
      if (String(from) === source) throw Object.assign(new Error('injected'), { code: 'EIO' })
      await rename(from, to)
    },
    rm: remove,
  })).rejects.toThrow('injected')
  await expect(readFile(join(destination, 'marker'), 'utf8')).rejects.toThrow()
  expect(await readFile(join(source, 'marker'), 'utf8')).toBe('new')
})

it('restores an interrupted backup and then installs the new tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-replace-'))
  roots.push(root)
  const destination = join(root, 'native')
  const source = join(root, 'incoming')
  const backup = `${destination}.bak`
  await mkdir(backup)
  await writeFile(join(backup, 'marker'), 'old')
  await mkdir(source)
  await writeFile(join(source, 'marker'), 'new')
  await replaceInstalledDirectory(destination, source)
  expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('new')
  await expect(readFile(join(backup, 'marker'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(source, 'marker'), 'utf8')).rejects.toThrow()
})

it('keeps the interrupted backup usable when the next replacement also fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-replace-'))
  roots.push(root)
  const destination = join(root, 'native')
  const source = join(root, 'incoming')
  const backup = `${destination}.bak`
  await mkdir(backup)
  await writeFile(join(backup, 'marker'), 'old')
  await mkdir(source)
  await writeFile(join(source, 'marker'), 'new')
  await expect(replaceInstalledDirectory(destination, source, {
    rename: async (from, to) => {
      if (String(from) === source) throw Object.assign(new Error('injected'), { code: 'EIO' })
      await rename(from, to)
    },
    rm: remove,
  })).rejects.toThrow('injected')
  expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('old')
  expect(await readFile(join(source, 'marker'), 'utf8')).toBe('new')
  await expect(readFile(join(backup, 'marker'), 'utf8')).rejects.toThrow()
})

it('leaves the only backup in place when restoring the interrupted tree fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-replace-'))
  roots.push(root)
  const destination = join(root, 'native')
  const source = join(root, 'incoming')
  const backup = `${destination}.bak`
  await mkdir(backup)
  await writeFile(join(backup, 'marker'), 'old')
  await mkdir(source)
  await writeFile(join(source, 'marker'), 'new')
  await expect(replaceInstalledDirectory(destination, source, {
    rename: async (from, to) => {
      if (String(from) === backup) throw Object.assign(new Error('restore failed'), { code: 'EIO' })
      await rename(from, to)
    },
    rm: remove,
  })).rejects.toThrow('restore failed')
  expect(await readFile(join(backup, 'marker'), 'utf8')).toBe('old')
  await expect(readFile(join(destination, 'marker'), 'utf8')).rejects.toThrow()
  expect(await readFile(join(source, 'marker'), 'utf8')).toBe('new')
})
