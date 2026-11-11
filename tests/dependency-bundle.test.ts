import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyPackagePayload, copyProductionDependency, resolveInstalledPackage, sandboxPackage, sandboxPatch, verifySandboxBundle, portableTarArguments } from '../scripts/release/dependency-bundle.mjs'

import { npmInvocation, privatePathVariants } from '../scripts/release/npm-stage.mjs'

describe('clean production dependency bundles', () => {
  let root: string
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'pulse-dependency-bundle-')) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('normalizes metadata with explicit GNU/BSD options and rejects unknown tar', () => {
    const bsd = portableTarArguments('bsdtar 3.5.3 - libarchive 3.7.4', 'archive space.tgz', 'stage & space')
    const gnu = portableTarArguments('tar (GNU tar) 1.35', 'archive space.tgz', 'stage & space')
    expect(bsd).toEqual(expect.arrayContaining(['--uid=0', '--gid=0', '--uname=root', '--gname=root', '--no-xattrs', '--no-acls', '--no-fflags']))
    expect(gnu).toEqual(expect.arrayContaining(['--owner=0', '--group=0', '--numeric-owner', '--no-xattrs', '--no-acls', '--pax-option=delete=atime,delete=ctime']))
    expect(bsd.slice(-5)).toEqual(['-czf', 'archive space.tgz', '-C', 'stage & space', 'pulse'])
    expect(() => portableTarArguments('unrecognized tar', 'out', 'stage')).toThrow('UNSUPPORTED_TAR_METADATA_FORMAT')
  })

  it('writes a real neutral-header archive preserving long names and executable payloads', async () => {
    const stage = join(root, 'tar stage & space'), directory = join(stage, 'pulse', 'long-'.repeat(35))
    const archive = join(root, 'portable.tgz'), payload = 'executable fixture\n'
    await mkdir(directory, { recursive: true })
    const source = join(directory, 'run.sh')
    await writeFile(source, payload); await chmod(source, 0o755)
    if (process.platform === 'darwin') {
      const tagged = spawnSync('/usr/bin/xattr', ['-w', 'com.pulse.archive-fixture', 'header-must-not-ship', source], { encoding: 'utf8' })
      expect(tagged.status, tagged.stderr).toBe(0)
    }
    const version = spawnSync('tar', ['--version'], { encoding: 'utf8' })
    expect(version.status).toBe(0)
    const env = { ...process.env, COPYFILE_DISABLE: '1' }
    delete env.TAR_OPTIONS; delete env.GZIP
    const packed = spawnSync('tar', portableTarArguments(version.stdout, archive, stage), { env, encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    const bytes = gunzipSync(await readFile(archive))
    expect(bytes.includes(Buffer.from('header-must-not-ship'))).toBe(false)
    let regular = 0, sawLongPath = false
    for (let offset = 0; offset + 512 <= bytes.length;) {
      const header = bytes.subarray(offset, offset + 512)
      if (header.every(byte => byte === 0)) break
      const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '').trim()
      const size = parseInt(field(124, 12) || '0', 8), type = field(156, 1)
      expect(parseInt(field(108, 8) || '0', 8)).toBe(0)
      expect(parseInt(field(116, 8) || '0', 8)).toBe(0)
      expect(['', 'root']).toContain(field(265, 32)); expect(['', 'root']).toContain(field(297, 32))
      const body = bytes.subarray(offset + 512, offset + 512 + size)
      if (type === 'x' || type === 'g') {
        for (const line of body.toString().trim().split('\n')) {
          const key = line.match(/^\d+ ([^=]+)=/)?.[1]
          expect(['path', 'mtime', 'size']).toContain(key)
          if (key === 'path' && line.includes('long-'.repeat(35))) sawLongPath = true
        }
      } else if (type === '' || type === '0') {
        expect(body.toString()).toBe(payload)
        if (process.platform !== 'win32') expect(parseInt(field(100, 8), 8) & 0o777).toBe(0o755)
        regular++
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }
    expect(regular).toBe(1); expect(sawLongPath).toBe(true)
  })

  it('recognizes raw, escaped, slash and file-URL private path spellings', () => {
    const path = String.raw`C:\Users\Fixture User\candidate`
    const variants = privatePathVariants([path])
    expect(variants).toContain(path)
    expect(variants).toContain(JSON.stringify(path).slice(1, -1))
    expect(variants).toContain('C:/Users/Fixture User/candidate')
    expect(variants).toContain('file:///C:/Users/Fixture%20User/candidate')
  })

  it('passes npm paths as literal argv without a Windows command shell', () => {
    const args = ['pack', 'C:\\release files\\candidate & verify', '--pack-destination', 'C:\\out space']
    const invocation = npmInvocation(args)
    expect(invocation.file).toBe(process.execPath)
    expect(invocation.args.slice(1)).toEqual(args)
    expect(invocation.args[0]).toMatch(/npm-cli\.js$/)
  })

  it('rebuilds declared dependencies without copying local shims or metadata', async () => {
    const source = join(root, 'owner'), target = join(root, 'copy')
    await mkdir(join(source, 'node_modules', '.bin'), { recursive: true })
    await mkdir(join(source, 'node_modules', 'child'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'owner', dependencies: { child: '1.0.0' } }))
    await writeFile(join(source, 'node_modules', 'child', 'package.json'), JSON.stringify({ name: 'child', version: '1.0.0' }))
    await writeFile(join(source, 'node_modules', '.bin', 'tool'), source)
    await writeFile(join(source, 'pnpm-lock.yaml'), source)
    await writeFile(join(source, '.npmrc'), 'fixture local config')
    await writeFile(join(source, '.DS_Store'), source)
    await writeFile(join(source, 'LICENSE'), 'fixture license')
    await copyProductionDependency('owner', source, target)
    expect(JSON.parse(await readFile(join(target, 'node_modules/child/package.json'), 'utf8')).version).toBe('1.0.0')
    await expect(lstat(join(target, 'node_modules/.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const name of ['pnpm-lock.yaml', '.npmrc', '.DS_Store']) await expect(lstat(join(target, name))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(target, 'LICENSE'), 'utf8')).toBe('fixture license')
  })

  it('fails closed on a package payload link escaping its package', async () => {
    const source = join(root, 'escaping'), secret = join(root, 'private')
    await mkdir(source); await mkdir(secret)
    await symlink(secret, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(copyPackagePayload(source, join(root, 'escape-copy'))).rejects.toThrow('DEPENDENCY_LINK_ESCAPE')
  })

  it('keeps the pinned SDK, full closure, licenses and modification provenance', async () => {
    const target = join(root, 'sdk'), owner = new URL('../packages/adapters/', import.meta.url)
    const { fileURLToPath } = await import('node:url')
    await copyProductionDependency(sandboxPackage, await resolveInstalledPackage(sandboxPackage, fileURLToPath(owner)), target)
    expect(await verifySandboxBundle(target)).toEqual({ version: '0.0.77', patchedSha256: sandboxPatch.patchedSha256, packages: 5 })
    const provenance = await readFile(join(target, 'dist/PULSE-PROVENANCE.json'), 'utf8')
    expect(provenance).not.toContain(root)
    expect(await readFile(join(target, 'dist/PULSE-MODIFICATIONS.txt'), 'utf8')).toContain('Pulse modification')
    await writeFile(join(target, sandboxPatch.file), '// unexpected replacement')
    await expect(verifySandboxBundle(target)).rejects.toThrow('SANDBOX_PATCH_MISSING')
  }, 60_000)
})
