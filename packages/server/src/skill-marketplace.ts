/** GitHub-only source adapter, following vercel-labs/skills source/discovery conventions.
 * No CLI execution, repository hooks, or dependency installation is performed. */
import { fromBuffer, type ZipFile, type Entry } from 'yauzl'
import { metadata, snapshot, skillPath, type SkillFiles, type SkillOrigin, type SkillSnapshot } from './skill-store.js'

export interface SkillSource { repository: string; ref: string; directory?: string; skill?: string }
export interface MarketSkill { id: string; name: string; source: string; installs: number }
export interface RemoteSkill extends SkillSnapshot { origin: SkillOrigin }
export function parseSkillSource(raw: string): SkillSource {
  let repository: string, ref = 'HEAD', directory: string | undefined, skill: string | undefined
  if (raw.startsWith('https://')) {
    const url = new URL(raw)
    if (url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('SKILL_GITHUB_SOURCE_REQUIRED')
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1)
    repository = parts.slice(0, 2).join('/').replace(/\.git$/, '')
    if (parts.length > 2) {
      if (parts[2] !== 'tree' || !parts[3]) throw new Error('SKILL_SOURCE_INVALID')
      ref = decodeURIComponent(parts[3]); directory = parts.slice(4).map(decodeURIComponent).join('/') || undefined
    }
  } else {
    const match = /^([^@]+)(?:@([^@]+))?$/.exec(raw.trim())
    if (!match) throw new Error('SKILL_SOURCE_INVALID')
    repository = match[1]!.replace(/\.git$/, ''); skill = match[2]
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || /(?:^|\/)\.\.?$/.test(repository) || !ref || ref.length > 200 || /[\x00-\x20]/.test(ref)) throw new Error('SKILL_SOURCE_INVALID')
  if (directory) skillPath(directory)
  if (skill && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skill)) throw new Error('INVALID_SKILL_NAME')
  return { repository, ref, ...(directory ? { directory } : {}), ...(skill ? { skill } : {}) }
}
async function boundedFetch(url: string, maxBytes: number, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pulse-Skills' }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(response.status === 429 || response.status === 403 ? 'SKILL_REMOTE_RATE_LIMITED' : response.status === 404 ? 'SKILL_REMOTE_NOT_FOUND' : `SKILL_REMOTE_HTTP_${response.status}`)
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('SKILL_DOWNLOAD_TOO_LARGE')
  const reader = response.body?.getReader(); if (!reader) throw new Error('SKILL_REMOTE_EMPTY')
  const chunks: Buffer[] = []; let size = 0
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) throw new Error('SKILL_DOWNLOAD_TOO_LARGE'); chunks.push(Buffer.from(part.value)) }
  } finally { await reader.cancel().catch(() => undefined) }
  return Buffer.concat(chunks)
}
export class SkillMarketplace {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async search(query: string): Promise<MarketSkill[]> {
    if (query.trim().length < 2 || query.length > 200) throw new Error('SKILL_QUERY_INVALID')
    const url = new URL('https://skills.sh/api/search'); url.searchParams.set('q', query.trim()); url.searchParams.set('limit', '20')
    const data = JSON.parse((await boundedFetch(url.toString(), 1024 * 1024, this.fetcher)).toString()) as { skills?: unknown }
    if (!Array.isArray(data.skills)) throw new Error('SKILL_SEARCH_RESPONSE_CHANGED')
    return data.skills.flatMap(item => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.source !== 'string' || typeof item.installs !== 'number') throw new Error('SKILL_SEARCH_RESPONSE_CHANGED')
      try { const parsed = parseSkillSource(item.source); if (parsed.directory || parsed.skill || !item.id.startsWith(parsed.repository + '/')) return [] } catch { return [] }
      return [{ id: item.id, name: item.name, source: item.source, installs: item.installs }]
    })
  }
  async discover(raw: string): Promise<RemoteSkill[]> {
    const source = parseSkillSource(raw)
    const data = JSON.parse((await boundedFetch(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`, 1024 * 1024, this.fetcher)).toString()) as { sha?: string }
    if (!data.sha || !/^[a-f0-9]{40}$/.test(data.sha)) throw new Error('SKILL_COMMIT_INVALID')
    const archive = await boundedFetch(`https://codeload.github.com/${source.repository}/zip/${data.sha}`, 100 * 1024 * 1024, this.fetcher)
    const { files, unsafe } = await readArchive(archive), candidates: RemoteSkill[] = []
    let candidateBytes = 0
    for (const [path, bytes] of files) {
      if (!(path === 'SKILL.md' || path.endsWith('/SKILL.md'))) continue
      const directory = path === 'SKILL.md' ? '' : path.slice(0, -9)
      if (source.directory !== undefined && directory !== source.directory && !directory.startsWith(source.directory + '/')) continue
      let info
      try { info = metadata(bytes) } catch { continue }
      if (source.skill && info.name !== source.skill) continue
      const prefix = directory ? directory + '/' : ''
      if (unsafe.some(path => path.startsWith(prefix))) { if (source.skill || source.directory === directory) throw new Error('SKILL_SYMLINK_OR_FILE_TYPE_REJECTED'); continue }
      const selected = new Map([...files].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]))
      candidateBytes += [...selected.values()].reduce((total, bytes) => total + bytes.length, 0)
      if (candidateBytes > 60 * 1024 * 1024) throw new Error('SKILL_PREVIEW_TOO_LARGE')
      const skill = snapshot(selected)
      candidates.push({ ...skill, origin: { repository: source.repository, directory, commit: data.sha, ref: source.ref } })
      if (candidates.length > 200) throw new Error('SKILL_CANDIDATE_LIMIT_EXCEEDED')
    }
    if (!candidates.length) throw new Error(unsafe.length ? 'SKILL_SYMLINK_OR_FILE_TYPE_REJECTED' : 'SKILL_REMOTE_NOT_FOUND')
    return candidates
  }
  async resolve(raw: string, name: string, directory?: string): Promise<RemoteSkill> {
    const matches = (await this.discover(raw)).filter(skill => skill.name === name && (directory === undefined || skill.origin.directory === directory))
    if (matches.length !== 1) throw new Error(matches.length ? 'SKILL_AMBIGUOUS' : 'SKILL_REMOTE_NOT_FOUND')
    return matches[0]!
  }
}
async function readArchive(bytes: Buffer): Promise<{ files: SkillFiles; unsafe: string[] }> {
  const zip = await new Promise<ZipFile>((resolveZip, reject) => fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error) : resolveZip(zip)))
  return new Promise((resolveFiles, reject) => {
    const files: SkillFiles = new Map(), folded = new Set<string>(), unsafe: string[] = []; let entries = 0, total = 0, settled = false
    const fail = (error: unknown) => { if (!settled) { settled = true; zip.close(); reject(error) } }
    zip.on('error', fail)
    zip.on('end', () => { if (!settled) { settled = true; resolveFiles({ files, unsafe }) } })
    zip.on('entry', (entry: Entry) => { void (async () => {
      if (++entries > 30_000) throw new Error('SKILL_ARCHIVE_ENTRY_LIMIT')
      const parts = entry.fileName.split('/'); parts.shift(); const path = parts.join('/').replace(/\/$/, '')
      if (!path) { zip.readEntry(); return }
      skillPath(path)
      const kind = entry.externalFileAttributes >>> 16 & 0o170000
      if (kind && kind !== 0o100000 && kind !== 0o40000) { unsafe.push(path); zip.readEntry(); return }
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
      if (folded.has(path.toLowerCase())) throw new Error('SKILL_FILE_COLLISION')
      folded.add(path.toLowerCase())
      if (entry.uncompressedSize > 20 * 1024 * 1024 || total + entry.uncompressedSize > 100 * 1024 * 1024) throw new Error('SKILL_DOWNLOAD_TOO_LARGE')
      const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error || !stream ? rejectStream(error) : resolveStream(stream)))
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of stream) { const value = Buffer.from(chunk); size += value.length; total += value.length; if (size > 20 * 1024 * 1024 || total > 100 * 1024 * 1024) throw new Error('SKILL_DOWNLOAD_TOO_LARGE'); chunks.push(value) }
      files.set(path, Buffer.concat(chunks)); zip.readEntry()
    })().catch(fail) })
    zip.readEntry()
  })
}
export function skillView(skill: SkillSnapshot & { origin?: SkillOrigin }) {
  return { name: skill.name, description: skill.description, compatibility: skill.compatibility, license: skill.license, hash: skill.hash, warnings: skill.warnings, content: skill.files.get('SKILL.md')!.toString('utf8'), files: [...skill.files].map(([path, bytes]) => ({ path, bytes: bytes.length })), origin: skill.origin }
}
