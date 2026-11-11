import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isIP } from 'node:net'
import { promises as dns } from 'node:dns'

export const CONVERSATION_ID = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEARCH_MAX_DEPTH = 8
const SEARCH_MAX_VISITED = 2_000
const SEARCH_MAX_RESULTS = 100
const SEARCH_MAX_FILE_BYTES = 1_000_000
export const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', '.pulse', 'dist', 'build', 'target', '.venv'])

export interface IgnoreRule {
  pattern: RegExp
  negated: boolean
  dirOnly: boolean
  /** Path prefix relative to the workspace, including a trailing slash. Empty means the workspace root. */
  base?: string
}

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/')
  const anchored = normalized.startsWith('/')
  const raw = anchored ? normalized.slice(1) : normalized
  const hasSlash = raw.includes('/')

  let reStr = ''
  let i = 0
  while (i < raw.length) {
    const c = raw[i]
    if (!c) break
    if (c === '*') {
      if (raw[i + 1] === '*') {
        if (raw[i + 2] === '/') {
          reStr += '(?:.+/)?'
          i += 3
          continue
        } else {
          reStr += '.*'
          i += 2
          continue
        }
      } else {
        reStr += '[^/]*'
        i++
        continue
      }
    } else if (c === '?') {
      reStr += '[^/]'
      i++
      continue
    } else if (c === '.') {
      reStr += '\\.'
      i++
      continue
    } else if ('+|^$()[]{}!\\'.includes(c)) {
      reStr += '\\' + c
      i++
      continue
    } else {
      reStr += c
      i++
      continue
    }
  }

  if (!anchored && !hasSlash) {
    return new RegExp(`(?:^|/)${reStr}(?:/|$)`)
  }
  return new RegExp(`^${reStr}(?:/|$)`)
}

export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    let pat = line
    const negated = pat.startsWith('!')
    if (negated) pat = pat.slice(1).trim()
    const dirOnly = pat.endsWith('/')
    if (dirOnly) pat = pat.slice(0, -1)
    if (!pat) continue
    rules.push({ pattern: globToRegExp(pat), negated, dirOnly })
  }
  return rules
}

export function isPathIgnored(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    const base = rule.base ?? ''
    let local = normalized
    if (base) {
      if (!normalized.startsWith(base)) continue
      local = normalized.slice(base.length)
    }
    if (rule.pattern.test(local) || (isDir && rule.pattern.test(`${local}/`))) ignored = !rule.negated
  }
  return ignored
}

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
  const base = resolve(root)
  const absolute = resolve(base, path)
  const rel = relative(base, absolute)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  return absolute
}

export async function within(root: string, path: string): Promise<string> {
  const target = lexicalWithin(root, path)
  const resolvedRoot = await realpath(root)
  try {
    const resolved = await realpath(target)
    const rel = relative(resolvedRoot, resolved)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_WORKSPACE')
    return resolved
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    const parent = await realpath(resolve(target, '..'))
    const rel = relative(resolvedRoot, parent)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_WORKSPACE')
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

export type SearchMatch = {
  path: string
  line: number
  text: string
  context?: { before: string[]; after: string[] } | undefined
}

export type SearchTruncationReason = 'depth' | 'visited' | 'results'

/**
 * Bounded workspace search statistics. `truncated` and `reason` separate
 * "the workspace has no match" from "the search stopped before it finished".
 */
export interface WorkspaceSearchResult {
  matches: SearchMatch[]
  truncated: boolean
  reason: SearchTruncationReason | null
  visited: number
  matched: number
}

export interface SearchWorkspaceOptions {
  directory?: string | undefined
  include?: string | undefined
  exclude?: string | undefined
  contextLines?: number | undefined
  signal?: AbortSignal | undefined
}

interface SearchCounters {
  count: number
}

interface SearchProgress {
  truncated: boolean
  reason: SearchTruncationReason | null
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('SEARCH_ABORTED')
}

async function directoryIgnoreRules(root: string, directory: string): Promise<IgnoreRule[]> {
  const base = directory === '.' ? '' : `${directory.replace(/\\/g, '/').replace(/\/$/, '')}/`
  const content = await readFile(join(root, directory === '.' ? '.gitignore' : join(directory, '.gitignore')), 'utf8').catch(() => undefined)
  if (!content) return []
  return parseGitignore(content).map((rule) => ({ ...rule, base }))
}

async function inheritedIgnoreRules(root: string, directory: string): Promise<IgnoreRule[]> {
  const parts = directory === '.' ? [] : directory.replace(/\\/g, '/').split('/').filter(Boolean)
  const chain: IgnoreRule[] = [...await directoryIgnoreRules(root, '.')]
  let current = '.'
  for (const part of parts) {
    current = current === '.' ? part : `${current}/${part}`
    chain.push(...await directoryIgnoreRules(root, current))
  }
  return chain
}

function rulesForDirectory(root: string, directory: string, inherited: IgnoreRule[]): Promise<IgnoreRule[]> {
  if (inherited.length > 0 || directory === '.') return directoryIgnoreRules(root, directory).then((own) => inherited.concat(own))
  return inheritedIgnoreRules(root, directory)
}

function markTruncated(progress: SearchProgress, reason: SearchTruncationReason): void {
  progress.truncated = true
  progress.reason = progress.reason ?? reason
}

/** Reads a file only after its size is known to be in budget, then rejects binary content. */
async function readSearchableLines(filePath: string, size: number): Promise<string[] | undefined> {
  if (size > SEARCH_MAX_FILE_BYTES) return undefined
  const file = await readFile(filePath).catch(() => undefined)
  if (!file || file.byteLength > SEARCH_MAX_FILE_BYTES || file.includes('\u0000')) return undefined
  return file.toString('utf8').split(/\r?\n/)
}

async function collectMatches(
  root: string,
  query: string,
  directory: string,
  depth: number,
  visited: SearchCounters,
  matched: SearchCounters,
  progress: SearchProgress,
  signal: AbortSignal | undefined,
  includeRegex?: RegExp,
  excludeRegex?: RegExp,
  contextLines?: number,
  ignoreRules: IgnoreRule[] = [],
): Promise<SearchMatch[]> {
  throwIfAborted(signal)
  if (depth > SEARCH_MAX_DEPTH) {
    markTruncated(progress, 'depth')
    return []
  }
  if (visited.count >= SEARCH_MAX_VISITED) {
    markTruncated(progress, 'visited')
    return []
  }
  if (matched.count >= SEARCH_MAX_RESULTS) {
    markTruncated(progress, 'results')
    return []
  }
  const base = await within(root, directory)
  throwIfAborted(signal)
  const baseStat = await lstat(base).catch(() => undefined)
  if (!baseStat || baseStat.isSymbolicLink()) return []
  const needle = query.toLocaleLowerCase()
  if (baseStat.isFile()) {
    visited.count++
    const lines = await readSearchableLines(base, baseStat.size)
    throwIfAborted(signal)
    if (!lines) return []
    const result: SearchMatch[] = []
    for (const [index, line] of lines.entries()) {
      if (matched.count >= SEARCH_MAX_RESULTS) {
        markTruncated(progress, 'results')
        break
      }
      if (line.toLocaleLowerCase().includes(needle)) {
        const item: SearchMatch = { path: directory, line: index + 1, text: line.slice(0, 500) }
        if (contextLines && contextLines > 0) {
          item.context = {
            before: lines.slice(Math.max(0, index - contextLines), index),
            after: lines.slice(index + 1, Math.min(lines.length, index + 1 + contextLines)),
          }
        }
        result.push(item)
        matched.count++
      }
    }
    return result
  }
  if (!baseStat.isDirectory()) return []
  const rules = await rulesForDirectory(root, directory, ignoreRules)
  const entries = await readdir(base, { withFileTypes: true })
  throwIfAborted(signal)
  const result: SearchMatch[] = []
  for (const entry of entries) {
    if (matched.count >= SEARCH_MAX_RESULTS) {
      markTruncated(progress, 'results')
      break
    }
    if (visited.count >= SEARCH_MAX_VISITED) {
      markTruncated(progress, 'visited')
      break
    }
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || DEFAULT_IGNORED_DIRS.has(entry.name)) continue
    const relativePath = directory === '.' ? entry.name : join(directory, entry.name).replace(/\\/g, '/')
    if (isPathIgnored(relativePath, entry.isDirectory(), rules)) continue
    visited.count++
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      result.push(...await collectMatches(root, query, relativePath, depth + 1, visited, matched, progress, signal, includeRegex, excludeRegex, contextLines, rules))
      continue
    }
    if (!entry.isFile()) continue
    if (includeRegex && !includeRegex.test(relativePath)) continue
    if (excludeRegex && excludeRegex.test(relativePath)) continue
    const filePath = await within(root, relativePath).catch(() => undefined)
    if (!filePath) continue
    const entryStat = await lstat(filePath).catch(() => undefined)
    if (!entryStat || entryStat.isSymbolicLink()) continue
    const lines = await readSearchableLines(filePath, entryStat.size)
    throwIfAborted(signal)
    if (!lines) continue
    for (const [index, line] of lines.entries()) {
      if (matched.count >= SEARCH_MAX_RESULTS) {
        markTruncated(progress, 'results')
        break
      }
      if (line.toLocaleLowerCase().includes(needle)) {
        const item: SearchMatch = { path: relativePath, line: index + 1, text: line.slice(0, 500) }
        if (contextLines && contextLines > 0) {
          item.context = {
            before: lines.slice(Math.max(0, index - contextLines), index),
            after: lines.slice(index + 1, Math.min(lines.length, index + 1 + contextLines)),
          }
        }
        result.push(item)
        matched.count++
      }
    }
  }
  return result.slice(0, SEARCH_MAX_RESULTS)
}

/**
 * Backwards-compatible workspace search. Returns only the match array, exactly
 * as before, while still honoring the shared depth/visit/result counters so
 * callers that pass their own `visited`/`matched` objects keep working.
 */
export async function searchFiles(
  root: string,
  query: string,
  directory = '.',
  depth = 0,
  visited: SearchCounters = { count: 0 },
  matched: SearchCounters = { count: 0 },
  signal?: AbortSignal,
): Promise<SearchMatch[]> {
  const progress: SearchProgress = { truncated: false, reason: null }
  return collectMatches(root, query, directory, depth, visited, matched, progress, signal, undefined, undefined, undefined, [])
}

/**
 * Workspace search with statistics. Consumers can tell an empty workspace from
 * a truncated result and see why the traversal stopped.
 */
export async function searchWorkspace(
  root: string,
  query: string,
  optionsOrDir: string | SearchWorkspaceOptions = '.',
  legacySignal?: AbortSignal,
): Promise<WorkspaceSearchResult> {
  const options: SearchWorkspaceOptions = typeof optionsOrDir === 'string' ? { directory: optionsOrDir, signal: legacySignal } : optionsOrDir
  const directory = options.directory ?? '.'
  const signal = options.signal ?? legacySignal
  const visited: SearchCounters = { count: 0 }
  const matched: SearchCounters = { count: 0 }
  const progress: SearchProgress = { truncated: false, reason: null }
  const includeRegex = options.include ? globToRegExp(options.include) : undefined
  const excludeRegex = options.exclude ? globToRegExp(options.exclude) : undefined
  const matches = await collectMatches(root, query, directory, 0, visited, matched, progress, signal, includeRegex, excludeRegex, options.contextLines, [])
  return { matches, truncated: progress.truncated, reason: progress.reason, visited: visited.count, matched: matched.count }
}

export interface GlobMatch {
  path: string
  size: number
  mtimeMs: number
  isDirectory: boolean
}

export interface WorkspaceGlobResult {
  matches: GlobMatch[]
  truncated: boolean
  total: number
}

export interface GlobWorkspaceOptions {
  path?: string | undefined
  limit?: number | undefined
  includeHidden?: boolean | undefined
  signal?: AbortSignal | undefined
}

export async function globWorkspace(
  root: string,
  pattern: string,
  optionsOrDir: string | GlobWorkspaceOptions = '.',
  legacySignal?: AbortSignal,
): Promise<WorkspaceGlobResult> {
  const options: GlobWorkspaceOptions = typeof optionsOrDir === 'string' ? { path: optionsOrDir, signal: legacySignal } : optionsOrDir
  const startDir = options.path ?? '.'
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const signal = options.signal ?? legacySignal
  const includeHidden = options.includeHidden ?? false

  throwIfAborted(signal)
  await within(root, startDir)
  const regex = globToRegExp(pattern)

  const matches: GlobMatch[] = []
  let truncated = false
  let visitedCount = 0

  async function walk(currentDir: string, depth: number, inherited: IgnoreRule[]): Promise<void> {
    throwIfAborted(signal)
    if (depth > 16 || visitedCount >= 5000) {
      truncated = true
      return
    }
    const currentAbs = await within(root, currentDir)
    const rules = await rulesForDirectory(root, currentDir, inherited)
    const entries = await readdir(currentAbs, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      throwIfAborted(signal)
      if (matches.length >= limit) {
        truncated = true
        return
      }
      visitedCount++
      const relFromRoot = currentDir === '.' ? entry.name : join(currentDir, entry.name).replace(/\\/g, '/')
      const isDir = entry.isDirectory()

      if (!includeHidden && (entry.name.startsWith('.') || DEFAULT_IGNORED_DIRS.has(entry.name))) {
        continue
      }
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
        continue
      }
      if (isPathIgnored(relFromRoot, isDir, rules)) {
        continue
      }
      if (entry.isSymbolicLink()) {
        continue
      }

      if (regex.test(relFromRoot)) {
        const fullPath = await within(root, relFromRoot).catch(() => undefined)
        if (fullPath) {
          const s = await lstat(fullPath).catch(() => undefined)
          if (s && !s.isSymbolicLink()) {
            matches.push({
              path: relFromRoot,
              size: s.size,
              mtimeMs: s.mtimeMs,
              isDirectory: isDir,
            })
          }
        }
      }

      if (isDir) {
        await walk(relFromRoot, depth + 1, rules)
      }
    }
  }

  await walk(startDir, 0, [])
  return { matches, truncated, total: matches.length }
}

export function safeShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|BEARER|CREDENTIAL|COOKIE)/i.test(key) && key !== 'NODE_OPTIONS'))
}
