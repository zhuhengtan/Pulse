import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { optimizeRuntime } from '../scripts/desktop/optimize-runtime.mjs'
import { refreshNativeManifest, verifyNativeManifest } from '../scripts/desktop/native-manifest.mjs'
import { verifyRuntimePlatform } from '../scripts/desktop/verify-runtime-platform.mjs'

async function file(root: string, name: string, text = name) {
 const path = join(root, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text)
}
async function pkg(root: string, path: string, manifest: Record<string, unknown>, text = 'module.exports = 42') {
 await file(root, `${path}/package.json`, JSON.stringify({ version: '1.0.0', main: 'index.cjs', ...manifest }))
 await file(root, `${path}/index.cjs`, text)
}
async function fixture(run: (root: string) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), 'pulse-runtime-optimization-'))
 try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

it.each([['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']])('keeps only %s/%s native payloads, executable resources and licenses', async (platform, arch) => fixture(async root => {
 const modules = 'app/node_modules', pty = `${modules}/node-pty`, server = `${modules}/@hunterzhu/pulse-server`, sandbox = `${modules}/@anthropic-ai/sandbox-runtime`
 await pkg(root, pty, { name: 'node-pty' }); await pkg(root, server, { name: '@hunterzhu/pulse-server' })
 await pkg(root, sandbox, { name: '@anthropic-ai/sandbox-runtime' })
 for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64']) {
  await file(root, `${pty}/prebuilds/${target}/pty.node`)
  await file(root, `${pty}/prebuilds/${target}/pty.pdb`)
  await file(root, `${server}/native/${target}/helper`)
  await file(root, `${server}/native/${target}/windows.ps1`)
  await file(root, `${server}/native/${target}/linux.py`)
  await file(root, `${server}/native/${target}/manifest.json`, JSON.stringify({ hashes: { helper: 'keep', 'windows.ps1': 'windows', 'linux.py': 'linux' } }))
 }
 for (const vendor of ['srt-win', 'seccomp']) for (const cpu of ['x64', 'arm64']) await file(root, `${sandbox}/vendor/${vendor}/${cpu}/executable`)
 for (const cpu of ['x64', 'arm64']) await file(root, `${pty}/third_party/conpty/1/win10-${cpu}/conpty.dll`)
 for (const name of ['LICENSE', 'worker.mjs', 'font.ttf', 'index.cjs.map']) await file(root, `${sandbox}/${name}`)
 await file(root, `${server}/index.js.map`); await file(root, 'browsers/chromium/browser')
 for (const ext of ['sh', 'ps1']) await file(root, `install.${ext}`)
 await optimizeRuntime(root, platform, arch)
 expect(await readdir(join(root, pty, 'prebuilds'))).toEqual([`${platform}-${arch}`])
 expect(await readdir(join(root, pty, 'prebuilds', `${platform}-${arch}`))).toEqual(['pty.node'])
 expect(await readdir(join(root, server, 'native'))).toEqual([`${platform}-${arch}`])
 if (platform === 'win32') expect(await readdir(join(root, pty, 'third_party/conpty/1'))).toEqual([`win10-${arch}`])
 const native = JSON.parse(await readFile(join(root, server, 'native', `${platform}-${arch}`, 'manifest.json'), 'utf8'))
 expect(Object.keys(native.hashes)).toEqual(['helper', ...(platform === 'win32' ? ['windows.ps1'] : platform === 'linux' ? ['linux.py'] : [])])
 for (const [vendor, system] of [['srt-win', 'win32'], ['seccomp', 'linux']]) {
  if (platform === system) expect(await readdir(join(root, sandbox, 'vendor', vendor))).toEqual([arch])
  else await expect(readFile(join(root, sandbox, 'vendor', vendor, arch, 'executable'))).rejects.toThrow()
 }
 for (const name of ['LICENSE', 'worker.mjs', 'font.ttf']) expect(await readFile(join(root, sandbox, name), 'utf8')).toBe(`${sandbox}/${name}`)
 await expect(readFile(join(root, sandbox, 'index.cjs.map'))).rejects.toThrow()
 expect(await readFile(join(root, server, 'index.js.map'), 'utf8')).toBe(`${server}/index.js.map`)
 expect(await readFile(join(root, 'browsers/chromium/browser'), 'utf8')).toBe('browsers/chromium/browser')
 expect(await readFile(join(root, platform === 'win32' ? 'install.ps1' : 'install.sh'), 'utf8')).toContain('install.')
}))

it('refreshes native helper checksums after signing and still detects subsequent corruption', async () => fixture(async root => {
 const native = 'app/node_modules/@hunterzhu/pulse-server/native/darwin-arm64'
 await file(root, `${native}/manifest.json`, JSON.stringify({ protocolVersion: 1, platform: 'darwin', arch: 'arm64', hashes: { 'pulse-desktop-helper': 'before-signing' } }))
 await file(root, `${native}/pulse-desktop-helper`, 'signed helper bytes')
 await expect(verifyNativeManifest(root, 'darwin', 'arm64')).rejects.toThrow('checksum mismatch')
 await refreshNativeManifest(root, 'darwin', 'arm64')
 await expect(verifyNativeManifest(root, 'darwin', 'arm64')).resolves.toBeUndefined()
 await file(root, `${native}/pulse-desktop-helper`, 'altered helper bytes')
 await expect(verifyNativeManifest(root, 'darwin', 'arm64')).rejects.toThrow('checksum mismatch')
 await expect(refreshNativeManifest(root, 'win32', 'x64')).rejects.toThrow()
}))

it.each(['darwin', 'win32', 'linux'])('rejects foreign executable payloads anywhere in a %s runtime', async platform => fixture(async root => {
 const headers: Record<string, Buffer> = { darwin: Buffer.from('cffaedfe', 'hex'), linux: Buffer.from('7f454c46', 'hex'), win32: Buffer.alloc(68) }
 headers.win32!.write('MZ'); headers.win32!.writeUInt32LE(64, 60); headers.win32!.write('PE\0\0', 64)
 await mkdir(join(root, 'vendor'))
 await writeFile(join(root, 'vendor/no-extension'), headers[platform]!)
 expect((await verifyRuntimePlatform(root, platform)).binaries).toEqual([join('vendor', 'no-extension')])
 for (const other of Object.keys(headers).filter(value => value !== platform)) {
  await writeFile(join(root, 'vendor/no-extension'), headers[other]!)
  await expect(verifyRuntimePlatform(root, platform)).rejects.toThrow('Foreign native payload')
 }
}))

it('removes equivalent ancestor copies without links and preserves executable dependency resolution', async () => fixture(async root => {
 await pkg(root, 'app/node_modules/dep', { name: 'dep' }, 'module.exports = {value: 42}')
 await pkg(root, 'app/node_modules/owner', { name: 'owner', dependencies: { dep: '*' } }, "module.exports = require('dep')")
 await pkg(root, 'app/node_modules/owner/node_modules/dep', { name: 'dep' }, 'module.exports = {value: 42}')
 const result = await optimizeRuntime(root, 'win32', 'x64')
 expect(result.deduplication.packagesBefore).toBe(3); expect(result.deduplication.packagesAfter).toBe(2)
 await expect(readFile(join(root, 'app/node_modules/owner/node_modules/dep/index.cjs'))).rejects.toThrow()
 const require = createRequire(join(root, 'app/probe.cjs'))
 expect(require('owner')).toBe(require('dep')); expect(require('owner').value).toBe(42)
}))

it('keeps identical versions isolated when peer dependencies or actual package contents differ', async () => fixture(async root => {
 await pkg(root, 'app/node_modules/peer', { name: 'peer' }, 'module.exports = 1')
 await pkg(root, 'app/node_modules/plugin', { name: 'plugin', peerDependencies: { peer: '*' } }, "module.exports = require('peer')")
 await pkg(root, 'app/node_modules/owner', { name: 'owner', dependencies: { plugin: '*', peer: '*' } }, "module.exports = [require('plugin'),require('peer')]")
 await pkg(root, 'app/node_modules/owner/node_modules/peer', { name: 'peer' }, 'module.exports = 2')
 await pkg(root, 'app/node_modules/owner/node_modules/plugin', { name: 'plugin', peerDependencies: { peer: '*' } }, "module.exports = require('peer')")
 const result = await optimizeRuntime(root, 'darwin', 'arm64')
 expect(result.deduplication.packagesAfter).toBe(5)
 const require = createRequire(join(root, 'app/probe.cjs'))
 expect(require('plugin')).toBe(1); expect(require('owner')).toEqual([2, 2])
}))

it('deduplicates matching cyclic dependency graphs while preserving nested version conflicts', async () => fixture(async root => {
 await pkg(root, 'app/node_modules/a', { name: 'a', dependencies: { b: '*' } })
 await pkg(root, 'app/node_modules/b', { name: 'b', dependencies: { a: '*' } })
 await pkg(root, 'app/node_modules/owner', { name: 'owner', dependencies: { a: '*', b: '*' } })
 await pkg(root, 'app/node_modules/owner/node_modules/a', { name: 'a', dependencies: { b: '*' } })
 await pkg(root, 'app/node_modules/owner/node_modules/b', { name: 'b', dependencies: { a: '*' } })
 await pkg(root, 'app/node_modules/other', { name: 'other', dependencies: { a: '*' } })
 await pkg(root, 'app/node_modules/other/node_modules/a', { name: 'a', version: '2.0.0', dependencies: { b: '*' } })
 const result = await optimizeRuntime(root, 'linux', 'x64')
 expect(result.deduplication.packagesAfter).toBe(5)
 expect(JSON.parse(await readFile(join(root, 'app/node_modules/other/node_modules/a/package.json'), 'utf8')).version).toBe('2.0.0')
}))
