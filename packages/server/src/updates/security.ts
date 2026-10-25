import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ZodType } from 'zod'
import type { ComponentManifest, SignedEnvelope } from './contracts.js'
import { trustedKeys } from './trusted-keys.js'

export { trustedKeys }
export function signedValue<T>(value: unknown, schema: ZodType<T, any, any>, keys: Record<string, string> = trustedKeys): { value: T; envelope: SignedEnvelope } {
  const e = value as SignedEnvelope
  if (!e || typeof e.keyId !== 'string' || typeof e.payload !== 'string' || typeof e.signature !== 'string' || e.payload.length > 32 * 1024 ** 2) throw new Error('UPDATE_SIGNATURE_INVALID')
  const key = keys[e.keyId]
  if (!key || createPublicKey(key).asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(e.payload), key, Buffer.from(e.signature, 'base64'))) throw new Error('UPDATE_SIGNATURE_INVALID')
  return { value: schema.parse(JSON.parse(e.payload)), envelope: e }
}
export function inside(root: string, name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error('UPDATE_PATH_INVALID')
  const path = resolve(root, name), rel = relative(resolve(root), path)
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('UPDATE_PATH_INVALID')
  return path
}
export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex')
}
export async function verifyFiles(root: string, manifest: ComponentManifest): Promise<void> {
  const base = await realpath(root)
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = inside(root, name), info = await lstat(path), rel = relative(base, await realpath(path))
    if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('UPDATE_PATH_INVALID')
    if ('link' in expected) {
      if (!info.isSymbolicLink() || await readlink(path) !== expected.link) throw new Error('UPDATE_FILE_INVALID')
    } else if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes || await sha256(path) !== expected.sha256) throw new Error('UPDATE_FILE_INVALID')
  }
  const required = manifest.component === 'backend' ? [process.platform === 'win32' ? 'node.exe' : 'node', 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js', 'app/node_modules/@hunterzhu/pulse-server/dist/updates/coordinator.js', 'app/node_modules/@hunterzhu/pulse-server/dist/updates/reader.js'] : manifest.component === 'frontend' ? ['index.html'] : []
  if (required.some(name => !manifest.files[name])) throw new Error('UPDATE_COMPONENT_INCOMPLETE')
}
export async function fetchBytes(url: string, limit: number, development = false): Promise<Buffer> {
  assertUpdateUrl(url, development)
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
  assertUpdateUrl(response.url || url, development)
  if (!response.ok || !response.body) throw new Error('UPDATE_FETCH_FAILED')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > limit) throw new Error('UPDATE_TOO_LARGE'); chunks.push(Buffer.from(chunk)) }
  return Buffer.concat(chunks)
}
export function assertUpdateUrl(value: string, development = false): void {
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(development && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('UPDATE_URL_INVALID')
}
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}
