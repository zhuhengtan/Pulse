import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isIP } from 'node:net'
import { promises as dns } from 'node:dns'

export const CONVERSATION_ID = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEARCH_MAX_DEPTH = 8
const SEARCH_MAX_VISITED = 2_000
const SEARCH_MAX_RESULTS = 100

export function isConversationId(id: string): boolean {
  return CONVERSATION_ID.test(id)
}

export function conversationDirectory(dataDir: string, id: string): string {
  if (!isConversationId(id)) throw new Error('INVALID_CONVERSATION_ID')
  const root = resolve(dataDir, 'conversations')
  const target = resolve(root, id)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('INVALID_CONVERSATION_ID')
  return target
}

function lexicalWithin(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  const base = resolve(root)
  const absolute = resolve(base, path)
  const rel = relative(base, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  return absolute
}

export async function within(root: string, path: string): Promise<string> {
  const target = lexicalWithin(root, path)
  const resolvedRoot = await realpath(root)
  try {
    const resolved = await realpath(target)
    const rel = relative(resolvedRoot, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_WORKSPACE')
    return resolved
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    const parent = await realpath(resolve(target, '..'))
    const rel = relative(resolvedRoot, parent)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_WORKSPACE')
    return target
  }
}

export function ipv4FromDottedOrInteger(host: string): string | undefined {
  if (/^\d+$/.test(host)) {
    const value = Number(host)
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return undefined
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
  }
  if (/^\d{1,3}(\.\d{1,3}){0,3}$/.test(host)) {
    const parts = host.split('.').map(Number)
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
    if (parts.length === 1) return undefined
    if (parts.length === 2) return `${parts[0]}.0.0.${parts[1]}`
    if (parts.length === 3) return `${parts[0]}.${parts[1]}.0.${parts[2]}`
    return parts.join('.')
  }
  return undefined
}

export function mappedIpv4(host: string): string | undefined {
  const unwrapped = host.replace(/^\[|\]$/g, '')
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(unwrapped) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(unwrapped)
  if (!match) return undefined
  if (match[1]?.includes('.')) return match[1]
  const high = Number.parseInt(match[1] ?? '0', 16)
  const low = Number.parseInt(match[2] ?? '0', 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export function isPrivateIp(address: string): boolean {
  const mapped = mappedIpv4(address)
  if (mapped) return isPrivateIp(mapped)
  const ipv4 = ipv4FromDottedOrInteger(address) ?? (isIP(address) === 4 ? address : undefined)
  if (ipv4) {
    const [a = 0, b = 0] = ipv4.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 255
  }
  const host = address.replace(/^\[|\]$/g, '').toLocaleLowerCase()
  if (isIP(host) !== 6) return false
  if (host === '::' || host === '::1') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  return false
}

export function isBlockedHostname(host: string): boolean {
  const normalized = host.toLocaleLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'metadata.google.internal' || normalized === 'metadata.internal') return true
  if (isPrivateIp(normalized)) return true
  const dotted = ipv4FromDottedOrInteger(normalized)
  return dotted !== undefined && isPrivateIp(dotted)
}

export function hostAllowed(host: string, allowHosts: string[] | undefined): boolean {
  if (!allowHosts || allowHosts.includes('*')) return true
  const normalized = host.toLocaleLowerCase().replace(/^\[|\]$/g, '')
  return allowHosts.some((allowed) => {
    const rule = allowed.toLocaleLowerCase()
    return rule === normalized || (rule.startsWith('*.') && (normalized === rule.slice(2) || normalized.endsWith(`.${rule.slice(2)}`)))
  })
}

export function publicUrl(raw: string, allowHosts?: string[]): URL {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL_SCHEME_NOT_ALLOWED')
  const host = url.hostname
  if (isBlockedHostname(host)) throw new Error('PRIVATE_NETWORK_URL_NOT_ALLOWED')
  if (!hostAllowed(host, allowHosts)) throw new Error('NETWORK_HOST_NOT_ALLOWED')
  return url
}

export async function assertPublicNetworkUrl(raw: string, allowHosts?: string[]): Promise<URL> {
  const url = publicUrl(raw, allowHosts)
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) || ipv4FromDottedOrInteger(url.hostname) !== undefined) return url
  const lookup = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => {
    throw new Error('NETWORK_HOST_UNRESOLVABLE')
  })
  if (lookup.length === 0 || lookup.some((entry) => isPrivateIp(entry.address))) throw new Error('PRIVATE_NETWORK_URL_NOT_ALLOWED')
  return url
}

export async function searchFiles(root: string, query: string, directory = '.', depth = 0, visited = { count: 0 }): Promise<Array<{ path: string; line: number; text: string }>> {
  if (depth > SEARCH_MAX_DEPTH || visited.count >= SEARCH_MAX_VISITED) return []
  const base = await within(root, directory)
  const baseStat = await lstat(base).catch(() => undefined)
  if (!baseStat || baseStat.isSymbolicLink() || !baseStat.isDirectory()) return []
  const entries = await readdir(base, { withFileTypes: true })
  const result: Array<{ path: string; line: number; text: string }> = []
  const needle = query.toLocaleLowerCase()
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || result.length >= SEARCH_MAX_RESULTS || visited.count >= SEARCH_MAX_VISITED) break
    visited.count++
    const relativePath = directory === '.' ? entry.name : join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      result.push(...await searchFiles(root, query, relativePath, depth + 1, visited))
      continue
    }
    if (!entry.isFile()) continue
    const filePath = await within(root, relativePath).catch(() => undefined)
    if (!filePath) continue
    const file = await readFile(filePath).catch(() => undefined)
    if (!file || file.includes('\u0000') || file.byteLength > 1_000_000) continue
    const lines = file.toString('utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (line.toLocaleLowerCase().includes(needle) && result.length < SEARCH_MAX_RESULTS) result.push({ path: relativePath, line: index + 1, text: line.slice(0, 500) })
    })
  }
  return result.slice(0, SEARCH_MAX_RESULTS)
}

export function safeShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|BEARER|CREDENTIAL|COOKIE)/i.test(key) && key !== 'NODE_OPTIONS'))
}
