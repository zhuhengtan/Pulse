import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { within } from './security.js'

export const MAX_FILE_BYTES = 128 * 1024 * 1024
const types: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain', '.xml': 'text/xml', '.csv': 'text/csv', '.yaml': 'text/plain', '.yml': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2' }
export function fileMediaType(path: string): string { return types[extname(path).toLowerCase()] ?? 'application/octet-stream' }

const webResource = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?)$/i

/** A ticket reads its own file. HTML may also load static assets beneath that file's directory. */
export function ticketPathAllowed(ticketPath: string, requested: string): boolean {
  if (requested === ticketPath) return true
  if (!/\.html?$/i.test(ticketPath)) return false
  const slash = ticketPath.lastIndexOf('/')
  const directory = slash === -1 ? '' : ticketPath.slice(0, slash + 1)
  if (!directory || !requested.startsWith(directory) || requested.slice(directory.length).split('/').some(part => !part || part === '..' || part.startsWith('.'))) return false
  return webResource.test(requested)
}

/** Read and hash the same bounded bytes, including binary artifacts. */
export async function readPreviewFile(root: string, path: string, expectedHash?: string) {
  const absolutePath = await within(root, path)
  const handle = await open(absolutePath, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('FILE_REQUIRED')
    if (info.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
    const chunks: Buffer[] = []; let size = 0
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size))
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    const bytes = Buffer.concat(chunks)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (expectedHash && hash !== expectedHash) throw new Error('ARTIFACT_CHANGED')
    return { bytes, hash, size: bytes.length, mediaType: fileMediaType(path), absolutePath, path }
  } finally { await handle.close() }
}

export function sendPreviewBytes(res: ServerResponse, value: { bytes: Buffer; mediaType: string; path: string }, download = false) {
  const filename = value.path.split(/[\\/]/).at(-1) ?? 'file'
  res.writeHead(200, { 'Content-Type': value.mediaType, 'Content-Length': value.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    // Even when opened directly, HTML/SVG cannot acquire the Pulse origin.
    'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'",
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
  }).end(value.bytes)
}

/** Separate loopback origin for browser-use; H5 exposes the same ticket in a sandbox. */
export class FilePreviewServer {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private readonly tickets = new Map<string, { root: string; path: string; hash?: string; expiresAt: number }>()
  private start(): Promise<number> {
    return this.starting ??= new Promise((resolve, reject) => {
      this.server = createServer((req, res) => { void this.serve(req.url ?? '', res, req.method) })
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve((this.server!.address() as { port: number }).port))
    })
  }
  async ticket(root: string, path: string, hash?: string) {
    await readPreviewFile(root, path, hash)
    const port = await this.start(), id = randomUUID(), expiresAt = Date.now() + 60 * 60_000
    for (const [key, value] of this.tickets) if (value.expiresAt < Date.now()) this.tickets.delete(key)
    this.tickets.set(id, { root, path, ...(hash ? { hash } : {}), expiresAt })
    const suffix = `/file-preview/${id}/${path.split('/').map(encodeURIComponent).join('/')}`
    return { url: suffix, browserUrl: `http://127.0.0.1:${port}${suffix}`, expiresAt }
  }
  async serve(input: string, res: ServerResponse, method = 'GET'): Promise<void> {
    try {
      if (method !== 'GET') { res.writeHead(405).end(); return }
      const url = new URL(input, 'http://preview.local'), match = url.pathname.match(/^\/file-preview\/([0-9a-f-]{36})\/(.+)$/)
      const ticket = match && this.tickets.get(match[1]!)
      if (!ticket || ticket.expiresAt < Date.now()) { res.writeHead(404).end(); return }
      const path = decodeURIComponent(match![2]!)
      if (path.split('/').some(part => part.startsWith('.') || part === 'node_modules') || !ticketPathAllowed(ticket.path, path)) { res.writeHead(404).end(); return }
      const value = await readPreviewFile(ticket.root, path, path === ticket.path ? ticket.hash : undefined)
      const prefix = `/file-preview/${match![1]}/`
      if (value.mediaType === 'text/html') {
        let html = value.bytes.toString('utf8').replace(/(\b(?:src|href|action)=['"])\/(?!\/)/gi, `$1${prefix}`)
        const base = `<base href="${prefix}${path.split('/').slice(0, -1).map(encodeURIComponent).join('/')}${path.includes('/') ? '/' : ''}">`
        html = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + base) : base + html
        value.bytes = Buffer.from(html)
      } else if (value.mediaType === 'text/css') value.bytes = Buffer.from(value.bytes.toString('utf8').replace(/(url\(\s*['"]?)\/(?!\/)/gi, `$1${prefix}`))
      // Relative resources work from an opaque sandbox origin, without credentials.
      res.setHeader('Access-Control-Allow-Origin', '*')
      sendPreviewBytes(res, value)
    } catch (error) { res.writeHead(error instanceof Error && error.message === 'ARTIFACT_CHANGED' ? 409 : 404).end() }
  }
  async close() { this.tickets.clear(); this.server?.closeAllConnections(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); this.server = undefined; this.starting = undefined }
}
