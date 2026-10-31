import { afterEach, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRootTooBroad, runShell } from '../packages/adapters/src/tools/shell.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('rejects a canonical home alias and case-variant or ancestor homes without matching a sibling prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-lsp-read-root-'))
  roots.push(root)
  const home = await realpath(homedir())
  const link = join(root, 'home-link')
  await symlink(home, link)
  await expect(runShell(process.execPath, ['-e', 'process.exit(0)'], { cwd: root, readRoots: [link], timeoutMs: 5000 })).rejects.toThrow('SANDBOX_READ_ROOT_TOO_BROAD')
  expect(readRootTooBroad(home, home)).toBe(true)
  expect(readRootTooBroad(link, home)).toBe(false)
  expect(readRootTooBroad(await realpath(link), home)).toBe(true)
  expect(readRootTooBroad('C:\\Users\\Name', 'c:\\users\\name', 'win32')).toBe(true)
  expect(readRootTooBroad('C:\\Users', 'C:\\Users\\Name', 'win32')).toBe(true)
  expect(readRootTooBroad('C:\\', 'C:\\Users\\Name', 'win32')).toBe(true)
  expect(readRootTooBroad('C:\\Users\\NameExtra', 'C:\\Users\\Name', 'win32')).toBe(false)
  expect(readRootTooBroad('C:\\Users\\Name\\project', 'C:\\Users\\Name', 'win32')).toBe(false)
  expect(readRootTooBroad('/Users', '/Users/name')).toBe(true)
  expect(readRootTooBroad('/', '/Users/name')).toBe(true)
  expect(readRootTooBroad('/Users/name2', '/Users/name')).toBe(false)
})
