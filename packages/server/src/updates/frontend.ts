import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import { inside, verifyListedFile } from './security.js'
import { bundledFrontendVersion } from './versions.js'
import type { UpdateManager } from './manager.js'

export const frontendTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
const versionPattern = /^\d+\.\d+\.\d+$/
export function decorateFrontendHtml(html: string, base: string, id: string, version?: string): string {
  const safeVersion = version && versionPattern.test(version) ? version : undefined
  const stripped = html.replace(/<meta\s+name="pulse-frontend-version"\s+content="[^"]*"\s*\/?>/gi, '')
  const versionTag = safeVersion ? `<meta name="pulse-frontend-version" content="${safeVersion}">` : ''
  return stripped.replace('<head>', `<head><base href="${base}">${versionTag}<meta name="pulse-frontend" content="${id}">`).replace(/(["'])\/assets\//g, `$1${base}assets/`)
}
export async function frontendResource(manager: UpdateManager, bundled: string | undefined, pathname: string, page: boolean): Promise<{ content: Buffer; type: string; immutable: boolean } | undefined> {
  const versioned = pathname.match(/^\/_pulse\/([a-zA-Z0-9.-]+)\/(assets\/.+)$/)
  const name = page ? 'index.html' : versioned ? decodeURIComponent(versioned[2]!) : decodeURIComponent(pathname.slice(1))
  let selected: Awaited<ReturnType<UpdateManager['frontend']>>
  try { selected = versioned && versioned[1] !== 'bundled' ? await manager.frontend(versioned[1]) : page ? await manager.frontend() : undefined } catch { selected = undefined }
  if (versioned && versioned[1] !== 'bundled' && !selected) return undefined
  if (selected) {
    const names = page ? Object.keys(selected.files) : [name]
    const current = selected
    const invalid = names.some(file => !current.files[file]) || (await Promise.all(names.map(file => verifyListedFile(current.directory, file, current.files[file]!).then(() => false, () => true)))).some(Boolean)
    if (invalid) { if (versioned) return undefined; selected = undefined }
  }
  const directory = selected?.directory ?? bundled
  if (!directory) return undefined
  const path = inside(directory, name), rel = relative(await realpath(directory), await realpath(path))
  if (rel === '..' || rel.startsWith('..' + sep)) return undefined
  let content = await readFile(path)
  if (page) {
    const id = selected?.id ?? 'bundled'
    const version = selected?.version ?? await bundledFrontendVersion(directory)
    content = Buffer.from(decorateFrontendHtml(content.toString(), `/_pulse/${id}/`, id, version))
  }
  return { content, type: frontendTypes[extname(path)] ?? 'application/octet-stream', immutable: !page }
}
