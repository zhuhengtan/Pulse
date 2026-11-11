import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShell } from '../packages/adapters/src/tools/shell.js'

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pulse-multi-root-')))
  const primary = join(base, 'primary'), secondary = join(base, 'other-container', 'secondary'), outside = join(base, 'other-container', 'outside')
  for (const path of [primary, secondary, outside]) await mkdir(path, { recursive: true })
  await writeFile(join(secondary, 'source.txt'), 'secondary content')
  await writeFile(join(outside, 'secret.txt'), 'outside secret')
  return { base, primary, secondary, outside }
}

describe('shell explicit read roots', () => {
  it('reads and runs inside secondary roots without granting writes or sibling/symlink reads', async () => {
    const f = await fixture()
    try {
      await symlink(f.outside, join(f.secondary, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      const result = await runShell('node', ['-e', `
        const fs = require('node:fs');
        const [primary, secondary, outside] = process.argv.slice(1);
        const denied = (action) => { try { action(); return false } catch { return true } };
        console.log(JSON.stringify({
          cwd: process.cwd(), read: fs.readFileSync('source.txt', 'utf8'),
          writeDenied: denied(() => fs.writeFileSync('forbidden.txt', 'bad')),
          siblingDenied: denied(() => fs.readFileSync(outside + '/secret.txt')),
          symlinkDenied: denied(() => fs.readFileSync('escape/secret.txt')),
        }));
        fs.writeFileSync(primary + '/allowed.txt', 'primary write');
      `, f.primary, f.secondary, f.outside], { cwd: f.secondary, workspaceRoot: f.primary, canonicalReadRoots: [f.secondary], timeoutMs: 120_000 })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ cwd: f.secondary, read: 'secondary content', writeDenied: true, siblingDenied: true, symlinkDenied: true })
      expect(await readFile(join(f.primary, 'allowed.txt'), 'utf8')).toBe('primary write')
      await expect(runShell('node', ['-e', ''], { cwd: f.outside, workspaceRoot: f.primary, canonicalReadRoots: [f.secondary] })).rejects.toMatchObject({ code: 'INVALID_SHELL_CWD' })
      await expect(runShell('node', ['-e', ''], { cwd: join(f.secondary, 'escape'), workspaceRoot: f.primary, canonicalReadRoots: [f.secondary] })).rejects.toMatchObject({ code: 'INVALID_SHELL_CWD' })
    } finally { await rm(f.base, { recursive: true, force: true }) }
  }, 180_000)

  it.each([false, true])('keeps nested source roots readable without widening grants (readonly primary: %s)', async (readOnlyWorkspace) => {
    const f = await fixture()
    try {
      const primarySnapshot = join(f.primary, 'nested', 'snapshot')
      const secondarySnapshot = join(f.secondary, 'nested', 'snapshot')
      for (const path of [primarySnapshot, secondarySnapshot]) {
        await mkdir(path, { recursive: true })
        await writeFile(join(path, 'asset.txt'), 'nested content')
      }
      await writeFile(join(f.primary, 'nested', 'peer.txt'), 'primary peer')
      await writeFile(join(f.secondary, 'nested', 'peer.txt'), 'secondary peer')
      await writeFile(join(f.base, 'parent-secret.txt'), 'parent secret')
      await symlink(f.outside, join(f.secondary, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      const probe = join(primarySnapshot, 'probe.cjs')
      await writeFile(probe, `
        const fs = require('node:fs');
        const [primary, secondary, outside, base] = process.argv.slice(2);
        const denied = (action) => { try { action(); return false } catch { return true } };
        const read = (root, path) => fs.readFileSync(root + '/' + path, 'utf8');
        const write = (root, path) => denied(() => fs.writeFileSync(root + '/' + path, 'changed'));
        console.log(JSON.stringify({
          primaryAsset: read(primary, 'nested/snapshot/asset.txt'),
          primaryPeer: read(primary, 'nested/peer.txt'),
          secondaryAsset: read(secondary, 'nested/snapshot/asset.txt'),
          secondaryPeer: read(secondary, 'nested/peer.txt'),
          primaryWriteDenied: write(primary, 'allowed.txt'),
          secondaryWriteDenied: write(secondary, 'source.txt'),
          nestedWriteDenied: write(secondary, 'nested/snapshot/asset.txt'),
          parentReadDenied: denied(() => read(base, 'parent-secret.txt')),
          siblingReadDenied: denied(() => read(outside, 'secret.txt')),
          symlinkReadDenied: denied(() => read(secondary, 'escape/secret.txt')),
        }));
      `)
      const result = await runShell('node', [probe, f.primary, f.secondary, f.outside, f.base], {
        cwd: primarySnapshot, workspaceRoot: f.primary,
        canonicalReadRoots: [primarySnapshot, secondarySnapshot, f.secondary, f.primary],
        readOnlyWorkspace, timeoutMs: 120_000,
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        primaryAsset: 'nested content', primaryPeer: 'primary peer',
        secondaryAsset: 'nested content', secondaryPeer: 'secondary peer',
        primaryWriteDenied: readOnlyWorkspace, secondaryWriteDenied: true, nestedWriteDenied: true,
        parentReadDenied: true, siblingReadDenied: true, symlinkReadDenied: true,
      })
      expect(await readFile(join(f.secondary, 'source.txt'), 'utf8')).toBe('secondary content')
      expect(await readFile(join(secondarySnapshot, 'asset.txt'), 'utf8')).toBe('nested content')
    } finally { await rm(f.base, { recursive: true, force: true }) }
  }, 180_000)

  it('retains legacy read-root aliases while allowing their canonical cwd', async () => {
    const f = await fixture()
    try {
      const alias = join(f.base, 'alias')
      await symlink(f.secondary, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const result = await runShell('node', ['-e', "console.log(require('node:fs').readFileSync('source.txt', 'utf8'))"], {
        cwd: alias, workspaceRoot: f.primary, readRoots: [alias], timeoutMs: 120_000,
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('secondary content')
    } finally { await rm(f.base, { recursive: true, force: true }) }
  }, 180_000)

  it('rejects canonical roots replaced by aliases before launch', async () => {
    const f = await fixture()
    try {
      await rename(f.secondary, f.secondary + '-original')
      await symlink(f.outside, f.secondary, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(runShell('node', ['-e', ''], { cwd: f.primary, canonicalReadRoots: [f.secondary] })).rejects.toMatchObject({ code: 'SANDBOX_READ_ROOT_CHANGED' })
    } finally { await rm(f.base, { recursive: true, force: true }) }
  })

  it.each(['symlink', 'directory'])('rejects a %s root replacement during launch approval', async (replacement) => {
    const f = await fixture()
    try {
      await expect(runShell('node', ['-e', ''], {
        cwd: f.primary, canonicalReadRoots: [f.secondary],
        beforeLaunch: async () => {
          await rename(f.secondary, f.secondary + '-original')
          if (replacement === 'symlink') await symlink(f.outside, f.secondary, process.platform === 'win32' ? 'junction' : 'dir')
          else await mkdir(f.secondary)
          return undefined
        },
      })).rejects.toMatchObject({ code: 'SANDBOX_SETUP_FAILED', cause: { code: 'SANDBOX_READ_ROOT_CHANGED' } })
    } finally { await rm(f.base, { recursive: true, force: true }) }
  }, 180_000)

  it('keeps primary writes when a readonly root contains the primary', async () => {
    const f = await fixture()
    try {
      const result = await runShell('node', ['-e', `
        const fs = require('node:fs');
        fs.writeFileSync(process.argv[1] + '/allowed.txt', 'yes');
        try { fs.writeFileSync('denied.txt', 'bad'); process.exit(3) } catch {}
      `, f.primary], { cwd: f.base, workspaceRoot: f.primary, canonicalReadRoots: [f.base, f.primary], timeoutMs: 120_000 })
      expect(result.code, result.stderr).toBe(0)
      expect(await readFile(join(f.primary, 'allowed.txt'), 'utf8')).toBe('yes')
    } finally { await rm(f.base, { recursive: true, force: true }) }
  }, 180_000)

  it('retains broad home and filesystem-root guards', async () => {
    const f = await fixture()
    try {
      for (const root of [await realpath(homedir()), parse(f.base).root]) {
        await expect(runShell('node', ['-e', ''], { cwd: f.primary, canonicalReadRoots: [root] })).rejects.toMatchObject({ code: 'SANDBOX_READ_ROOT_TOO_BROAD' })
      }
    } finally { await rm(f.base, { recursive: true, force: true }) }
  })
})
