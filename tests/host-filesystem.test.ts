import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { createHostDirectory, hostBreadcrumbs, hostFilesystemError, listHostPaths, validateDirectoryName } from '../packages/server/src/h5/host-filesystem.js'
import type { HostPathListing } from '../packages/server/src/protocol.js'
const directories: string[] = []
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'pulse-host-paths-')); directories.push(root); return root }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('host filesystem service', () => {
  it('resolves canonical paths, sorts folders first, filters hidden entries and pages without recursion', async () => {
    const root = await fixture()
    await mkdir(join(root, '中文 空格'))
    await writeFile(join(root, '.hidden'), 'hidden')
    await Promise.all(Array.from({ length: 203 }, (_, i) => writeFile(join(root, `file-${i}.txt`), 'test')))
    const first = await listHostPaths(root, 'both', false, 0)
    expect(first.path).toBe(await realpath(root))
    expect(first.entries).toHaveLength(200)
    expect(first.entries[0]).toMatchObject({ name: '中文 空格', kind: 'directory' })
    expect(first.nextOffset).toBe(200)
    const last = await listHostPaths(root, 'both', false, first.nextOffset!)
    expect(last.entries).toHaveLength(4)
    expect(last.nextOffset).toBeNull()
    expect(new Set([...first.entries, ...last.entries].map(entry => entry.path)).size).toBe(204)
    expect((await listHostPaths(root, 'directory', false, 0)).entries.map(entry => entry.name)).toEqual(['中文 空格'])
    expect((await listHostPaths(root, 'both', true, 0)).entries.some(entry => entry.name === '.hidden')).toBe(true)
  })
  it('follows valid symlinks and exposes broken links as unavailable', async () => {
    const root = await fixture()
    await mkdir(join(root, 'target'))
    await symlink(join(root, 'target'), join(root, 'alias'), 'dir')
    await symlink(join(root, 'missing'), join(root, 'broken'), 'dir')
    const result = await listHostPaths(root, 'both', false, 0)
    expect(result.entries.find(entry => entry.name === 'alias')).toMatchObject({ path: await realpath(join(root, 'target')), kind: 'directory', symlink: true })
    expect(result.entries.find(entry => entry.name === 'broken')).toMatchObject({ unavailable: 'HOST_PATH_NOT_FOUND' })
    expect((await listHostPaths(join(root, 'alias'), 'both', false, 0)).path).toBe(await realpath(join(root, 'target')))
  })
  it('creates only empty directories, rejects overwrite and invalid/platform-reserved names', async () => {
    const root = await fixture()
    const made = await createHostDirectory(root, '中文 空格')
    expect(await readdir(made.path)).toEqual([])
    await expect(createHostDirectory(root, '中文 空格')).rejects.toMatchObject({ code: 'EEXIST' })
    for (const name of ['.', '..', '../escape', 'a/b', 'a\\b', '', '\0']) expect(() => validateDirectoryName(name)).toThrow()
    for (const name of ['CON', 'NUL.txt', 'a:', 'x.', 'trailing ', 'COM1']) expect(() => validateDirectoryName(name, 'win32')).toThrow()
    expect(() => validateDirectoryName('中文 空格', 'win32')).not.toThrow()
    await expect(listHostPaths('relative', 'both', false, 0)).rejects.toMatchObject({ code: 'HOST_ABSOLUTE_PATH_REQUIRED' })
    await expect(listHostPaths(root, 'both', false, -1)).rejects.toThrow()
  })
  it('constructs POSIX, drive and UNC breadcrumbs on the host', () => {
    expect(hostBreadcrumbs('/Users/me/中文 空格', false)).toEqual([{ name: '/', path: '/' }, { name: 'Users', path: '/Users' }, { name: 'me', path: '/Users/me' }, { name: '中文 空格', path: '/Users/me/中文 空格' }])
    expect(hostBreadcrumbs('C:\\Users\\me', true).map(item => item.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\me'])
    expect(hostBreadcrumbs('\\\\server\\share\\folder', true).map(item => item.path)).toEqual(['\\\\server\\share\\', '\\\\server\\share\\folder'])
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports OS permission failures', async () => {
    const root = await fixture(); const locked = join(root, 'locked'); await mkdir(locked); await chmod(locked, 0)
    try { await expect(listHostPaths(locked, 'both', false, 0).catch(error => { throw hostFilesystemError(error) })).rejects.toMatchObject({ code: 'HOST_PATH_FORBIDDEN', status: 403 }) }
    finally { await chmod(locked, 0o700) }
  })
})

describe('authenticated host filesystem HTTP flow', () => {
  it('lets an existing paired device browse outside projects, create and register without granting admin privileges', async () => {
    const root = await fixture(); const workspace = join(root, 'workspace'); const outside = join(root, 'outside'); await mkdir(workspace); await mkdir(outside)
    const dataDir = join(root, 'data'); const host = createLocalHost({ cwd: workspace, dataDir }); let server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
    try {
      let base = `http://127.0.0.1:${(await server.start()).port}`
      const paired = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Phone path regression' }) })
      const cookie = paired.headers.get('set-cookie')!
      const headers = () => ({ Cookie: cookie, Origin: base, 'Content-Type': 'application/json' })
      const get = (path: string) => fetch(`${base}${path}`, { headers: headers() })
      const post = (path: string, body: unknown, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers(), Origin: origin }, body: JSON.stringify(body) })
      // Persisted pairing works after a server restart, without a new pairing code.
      await server.stop(); server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 }); base = `http://127.0.0.1:${(await server.start()).port}`
      expect(await (await get('/api/session')).json()).toMatchObject({ localAdmin: false, canBrowseHostPaths: true, canRegisterProject: true, canUseTerminal: false, canEditConfig: false })
      expect((await fetch(`${base}/api/host-filesystem/roots`)).status).toBe(401)
      expect((await fetch(`${base}/api/host-filesystem/directories`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ parentPath: outside, name: 'anonymous' }) })).status).toBe(401)
      expect((await get('/api/host-filesystem/roots')).status).toBe(200)
      const query = new URLSearchParams({ path: outside, mode: 'both' })
      expect((await (await get(`/api/host-filesystem/entries?${query}`)).json() as HostPathListing).path).toBe(await realpath(outside))
      expect((await post('/api/host-filesystem/directories', { parentPath: outside, name: 'evil' }, 'http://evil.example')).status).toBe(403)
      const created = await post('/api/host-filesystem/directories', { parentPath: outside, name: '手机 新项目' })
      expect(created.status).toBe(201); const path = (await created.json() as { path: string }).path
      expect(await readdir(path)).toEqual([])
      expect((await post('/api/host-filesystem/directories', { parentPath: outside, name: '手机 新项目' })).status).toBe(409)
      expect((await post('/api/host-filesystem/directories', { parentPath: outside, name: '../escape' })).status).toBe(400)
      expect((await post('/api/projects', { name: 'Mobile', cwd: path }, 'http://evil.example')).status).toBe(403)
      const registered = await post('/api/projects', { name: 'Mobile', cwd: path }); expect(registered.status).toBe(201)
      expect(await registered.json()).toMatchObject({ cwd: path, name: 'Mobile' })
      for (const endpoint of ['/api/config', '/api/terminals']) expect((await get(endpoint)).status).toBe(403)
      expect((await post('/api/projects/select-directory', {})).status).toBe(403)
      expect((await get(`/api/host-filesystem/entries?path=${encodeURIComponent(join(outside, 'missing'))}`)).status).toBe(404)
    } finally { await server.stop(); await host.close() }
  })
})
