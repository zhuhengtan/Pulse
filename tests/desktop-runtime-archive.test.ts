import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { archiveWindowsRuntime } from '../packages/desktop/scripts/archive-windows-runtime.mjs'
import { archiveName, extractRuntimeArchive, readRuntimeArchive } from '../packages/desktop/src/runtime-archive.mjs'
import { fileDigest, verifyRuntime, writeRuntimeManifest } from '../packages/desktop/src/runtime-manifest.mjs'
const { c } = createRequire(new URL('../packages/desktop/package.json', import.meta.url))('tar')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const deep = 'app/node_modules/@hunterzhu/pulse-adapters/node_modules/exceljs/node_modules/archiver/node_modules/archiver-utils/node_modules/glob/node_modules/inflight/node_modules/wrappy/'
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'pulse-archive space-')); roots.push(root)
 const source = join(root, 'unpacked'), packaged = join(root, 'resources/runtime'), target = join(root, 'managed/runtime')
 const names = ['node.exe', 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js', 'app/node_modules/@hunterzhu/pulse-cli/dist/config.js', 'app/node_modules/@hunterzhu/pulse-server/dist/index.js', 'app/node_modules/@hunterzhu/pulse-server/dist/web/index.html', 'app/node_modules/@hunterzhu/pulse-server/dist/diagnostics.js', 'app/node_modules/@hunterzhu/pulse-server/dist/jarvis/privacy.js', deep + 'LICENSE', deep + 'package.json', deep + 'wrappy.js']
 for (const name of names) { await mkdir(dirname(join(source, name)), { recursive: true }); await writeFile(join(source, name), 'fixture:' + name) }
 const manifest = await writeRuntimeManifest(source, '0.11.0', 'win32', 'x64')
 await archiveWindowsRuntime(source, packaged, 'x64')
 await mkdir(target, { recursive: true })
 return { root, source, packaged, target, manifest, names }
}
it('ships a shallow Windows payload and restores every deep dependency with full integrity checks', async () => {
 const f = await fixture()
 expect(await readdir(f.packaged)).toEqual(expect.arrayContaining(['runtime.tar', 'runtime-archive.json', 'desktop-runtime.json']))
 await expect(readFile(join(f.packaged, deep + 'LICENSE'))).rejects.toMatchObject({ code: 'ENOENT' })
 expect(await readFile(join(f.packaged, 'app/node_modules/@hunterzhu/pulse-server/dist/diagnostics.js'), 'utf8')).toContain('fixture:')
 // The NSIS output alone must suffice; remove the original build tree.
 await rm(f.source, { recursive: true })
 await extractRuntimeArchive(f.packaged, f.target, await readRuntimeArchive(f.packaged), f.manifest)
 for (const name of f.names) expect(await readFile(join(f.target, name), 'utf8')).toBe('fixture:' + name)
 await expect(verifyRuntime(f.target, f.manifest, true)).resolves.toBeUndefined()
}, 30000)
it('rejects corrupted payloads before extracting anything', async () => {
 const f = await fixture(), metadata = await readRuntimeArchive(f.packaged)
 await writeFile(join(f.packaged, archiveName), 'damaged archive')
 await expect(extractRuntimeArchive(f.packaged, f.target, metadata, f.manifest)).rejects.toThrow('RUNTIME_ARCHIVE_CHANGED')
 expect(await readdir(f.target)).toEqual([])
})
it('rejects archives missing a noncritical dependency even with a matching archive digest', async () => {
 const f = await fixture()
 await rm(join(f.source, deep + 'LICENSE'))
 await c({ cwd: f.source, file: join(f.packaged, archiveName) }, ['.'])
 const metadata = { sha256: await fileDigest(join(f.packaged, archiveName)) }
 await expect(extractRuntimeArchive(f.packaged, f.target, metadata, f.manifest)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('keeps legacy directory bundles readable and rejects malformed metadata', async () => {
 const f = await fixture()
 expect(await readRuntimeArchive(f.source)).toBeUndefined()
 await writeFile(join(f.packaged, 'runtime-archive.json'), '{"schema":1,"sha256":"broken"}')
 await expect(readRuntimeArchive(f.packaged)).rejects.toThrow('INVALID_RUNTIME_ARCHIVE')
})
