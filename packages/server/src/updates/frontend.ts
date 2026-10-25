import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import { inside } from './security.js'
import type { UpdateManager } from './manager.js'

export const frontendTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
export async function frontendResource(manager: UpdateManager, bundled: string | undefined, pathname: string, page: boolean): Promise<{ content: Buffer; type: string; immutable: boolean } | undefined> {
  const versioned = pathname.match(/^\/_pulse\/([a-zA-Z0-9.-]+)\/(assets\/.+)$/)
  let selected = versioned && versioned[1] !== 'bundled' ? await manager.frontend(versioned[1]) : page ? await manager.frontend() : undefined
  const directory = selected?.directory ?? bundled
  if (!directory || versioned && versioned[1] !== 'bundled' && !selected) return undefined
  const name = page ? 'index.html' : versioned ? decodeURIComponent(versioned[2]!) : decodeURIComponent(pathname.slice(1))
  const path = inside(directory, name), rel = relative(await realpath(directory), await realpath(path))
  if (rel === '..' || rel.startsWith('..' + sep)) return undefined
  let content = await readFile(path)
  if (page) {
    const base = `/_pulse/${selected?.id ?? 'bundled'}/`
    const html = content.toString().replace('<head>', `<head><base href="${base}"><meta name="pulse-frontend" content="${selected?.id ?? 'bundled'}">`).replace(/(["'])\/assets\//g, `$1${base}assets/`)
    content = Buffer.from(html)
  }
  return { content, type: frontendTypes[extname(path)] ?? 'application/octet-stream', immutable: !page }
}
