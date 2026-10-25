import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import * as yauzl from 'yauzl'
import type { ComponentManifest } from './contracts.js'
import { assertUpdateUrl, inside, verifyFiles } from './security.js'

export async function downloadArtifact(path: string, m: ComponentManifest, progress: (bytes: number) => void, development: boolean): Promise<void> {
  assertUpdateUrl(m.artifact.url, development)
  const response = await fetch(m.artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60000) })
  assertUpdateUrl(response.url || m.artifact.url, development)
  if (!response.ok || !response.body) throw new Error('UPDATE_FETCH_FAILED')
  let bytes = 0; const hash = createHash('sha256')
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length
    if (bytes > m.artifact.bytes) { callback(new Error('UPDATE_SIZE_INVALID')); return }
    hash.update(chunk); progress(bytes); callback(null, chunk)
  } })
  await pipeline(response.body as unknown as AsyncIterable<Uint8Array>, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
  if (bytes !== m.artifact.bytes || hash.digest('hex') !== m.artifact.sha256) throw new Error('UPDATE_DIGEST_INVALID')
}

/** Extract files first, links last. No archive-controlled symlink can redirect a write. */
export async function extractArtifact(archive: string, destination: string, manifest: ComponentManifest): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolveZip, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, value) => error || !value ? reject(error) : resolveZip(value)))
  const seen = new Set<string>(), links: Array<{ name: string; target: string }> = []
  await new Promise<void>((resolveZip, reject) => {
    let failed = false
    const fail = (error: unknown) => { if (!failed) { failed = true; zip.close(); reject(error) } }
    zip.on('error', fail)
    zip.on('end', resolveZip)
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      const name = entry.fileName, path = inside(destination, name.replace(/\/$/, ''))
      if (name.endsWith('/')) { if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error('UPDATE_PATH_INVALID'); await mkdir(path, { recursive: true }); zip.readEntry(); return }
      const expected = manifest.files[name]
      if (!expected || seen.has(name)) throw new Error('UPDATE_ARCHIVE_INVALID')
      seen.add(name)
      const mode = entry.externalFileAttributes >>> 16
      if (mode & 0o170000 && ![0o100000, 0o120000].includes(mode & 0o170000)) throw new Error('UPDATE_ARCHIVE_INVALID')
      const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, value) => error || !value ? rejectStream(error) : resolveStream(value)))
      await mkdir(dirname(path), { recursive: true })
      if ('link' in expected) {
        if (entry.uncompressedSize > 4096) throw new Error('UPDATE_PATH_INVALID')
        const chunks: Buffer[] = []; for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(chunk)
        const target = Buffer.concat(chunks).toString('utf8')
        if (target !== expected.link || isAbsolute(target) || /^[A-Za-z]:/.test(target)) throw new Error('UPDATE_PATH_INVALID')
        const rel = relative(resolve(destination), resolve(dirname(path), target))
        if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('UPDATE_PATH_INVALID')
        links.push({ name, target })
      } else {
        if (entry.uncompressedSize !== expected.bytes || (mode & 0o170000) === 0o120000) throw new Error('UPDATE_SIZE_INVALID')
        await pipeline(stream, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
        await chmod(path, expected.mode === undefined ? 0o644 : expected.mode & 0o777)
      }
      zip.readEntry()
    })().catch(fail) })
    zip.readEntry()
  })
  if (seen.size !== Object.keys(manifest.files).length) throw new Error('UPDATE_ARCHIVE_INCOMPLETE')
  // Symlink targets may themselves be other in-tree links, as in pnpm bundles.
  let pending = links
  while (pending.length) {
    const next: typeof links = []
    for (const link of pending) {
      const path = inside(destination, link.name), target = await stat(resolve(dirname(path), link.target)).catch(() => undefined)
      if (!target) { next.push(link); continue }
      await symlink(link.target, path, target.isDirectory() ? 'dir' : 'file')
    }
    if (next.length === pending.length) throw new Error('UPDATE_LINK_INVALID')
    pending = next
  }
  await verifyFiles(destination, manifest)
}
