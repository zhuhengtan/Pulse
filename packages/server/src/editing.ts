import { createHash, randomUUID } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'

export const EDIT_BYTES = 8_192
export const STREAM_BYTES = 16_384
// Plans use a dedicated bounded writer with a no-overwrite contract.
export const PLAN_BYTES = 16_384
const MAX_DRAFT_BYTES = 500_000
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export function editingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false })
}
export function boundedEdit(text: string): void {
  if (Buffer.byteLength(text) > EDIT_BYTES) throw editingError('EDIT_TOO_LARGE', 'Limit each edit fragment to 8192 UTF-8 bytes. Use a smaller fs.apply_patch. Stream a new file with fs.stage in chunks of at most 16384 bytes.')
}

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const draftId = z.string().uuid()
const stageCommand = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('begin'), path: z.string(), expectedHash: hash.optional(), content: z.string().max(STREAM_BYTES).optional() }),
  z.object({ operation: z.literal('inspect'), draftId }),
  z.object({ operation: z.literal('append'), draftId, revision: hash, content: z.string().min(1).max(STREAM_BYTES) }),
  z.object({ operation: z.literal('commit'), draftId, revision: hash, expectedBytes: z.number().int().min(0).max(MAX_DRAFT_BYTES) }),
])
// Providers require an object at the root of a tool JSON schema. Validate the
// operation-specific required fields separately before any filesystem action.
export const stageInput = z.object({
  operation: z.enum(['begin', 'inspect', 'append', 'commit']).optional(),
  op: z.enum(['begin', 'inspect', 'append', 'commit']).optional(),
  path: z.string().optional(), expectedHash: hash.optional(), draftId: draftId.optional(),
  revision: hash.optional(), content: z.string().max(STREAM_BYTES).optional(),
  expectedBytes: z.number().int().min(0).max(MAX_DRAFT_BYTES).optional(),
})
const draftSchema = z.object({ version: z.literal(1), path: z.string(), baseline: hash.nullable(), content: z.string(), committed: z.boolean(), owner: z.string().optional() })
export const pulsePath = (path: string): boolean => path.replaceAll('\\', '/').split('/').includes('.pulse')
const draftReceipt = (id: string, serialized: string, draft: z.infer<typeof draftSchema>) => {
  const bytes = Buffer.from(draft.content)
  let offset = Math.max(0, bytes.length - 1024)
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++
  return { draftId: id, target: draft.path, revision: digest(serialized), bytes: bytes.length, contentHash: digest(draft.content), committed: draft.committed, tail: bytes.subarray(offset).toString('utf8') }
}

// Parse without executing. A rejected draft keeps its content and revision.
export async function checkNewJavaScript(path: string, content: string, signal?: AbortSignal): Promise<void> {
  if (!/\.(?:mjs|cjs)$/.test(path)) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', `--input-type=${path.endsWith('.cjs') ? 'commonjs' : 'module'}`], { stdio: ['pipe', 'ignore', 'pipe'], env: {}, signal })
    let diagnostic = ''
    const timer = setTimeout(() => child.kill(), 5000)
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(0, 2000) })
    child.stdin.on('error', () => undefined)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(editingError('DRAFT_SYNTAX_INVALID', `JavaScript syntax check failed; complete the source before writing or committing. ${diagnostic}`)) })
    child.stdin.end(content)
  })
}

/** Each revision is durable. Incomplete drafts never touch their target file. */
export class StagedEditor {
  constructor(private readonly files: FilesystemTool, private readonly owner = 'legacy') {}
  /** Host/CLI only: caller must have obtained a human ownership confirmation. Never a model tool. */
  async migrateLegacy(id: string, revision?: string, confirmed = false) {
    draftId.parse(id)
    const path = `.pulse/drafts/${id}.json`
    const serialized = await this.files.read(path)
    const draft = draftSchema.parse(JSON.parse(serialized))
    const current = digest(serialized)
    const preview = { draftId: id, target: draft.path, revision: current, bytes: Buffer.byteLength(draft.content), currentOwner: draft.owner ?? null, proposedOwner: this.owner, committed: draft.committed }
    if (!confirmed) return { ...preview, migrated: false }
    if (this.owner === 'legacy' || draft.owner !== undefined || draft.committed || pulsePath(draft.path)) throw editingError('DRAFT_MIGRATION_NOT_ALLOWED', 'Only an uncommitted ownerless draft can be explicitly assigned to a concrete run.')
    if (revision !== current) throw editingError('DRAFT_REVISION_CONFLICT', 'Preview the unchanged draft and explicitly confirm its revision.')
    const archive = `.pulse/draft-migrations/${id}-${revision}.json`
    try { await this.files.writeIfUnchanged(archive, serialized, null) } catch (error) { if ((error as { code?: string }).code !== 'FILE_BASELINE_CONFLICT') throw error; if (await this.files.read(archive) !== serialized) throw error }
    const key = digest(JSON.stringify([this.owner, resolve(this.files.root, draft.path)]))
    const indexPath = `.pulse/draft-targets/${key}.json`
    try { await this.files.writeIfUnchanged(indexPath, JSON.stringify({ draftId: id, owner: this.owner }), null) }
    catch (error) { if ((error as { code?: string }).code !== 'FILE_BASELINE_CONFLICT') throw error; const index = JSON.parse(await this.files.read(indexPath)); if (index.draftId !== id || index.owner !== this.owner) throw editingError('DRAFT_TARGET_CONFLICT', 'This run already has a different draft for this target.') }
    const next = JSON.stringify({ ...draft, owner: this.owner })
    await this.files.writeIfUnchanged(path, next, current)
    return { ...preview, revision: digest(next), migrated: true }
  }
  async execute(submitted: z.input<typeof stageInput>, signal?: AbortSignal) {
    const raw = { ...submitted, operation: submitted.operation ?? submitted.op }
    if (typeof raw.content === 'string' && Buffer.byteLength(raw.content) > STREAM_BYTES) throw editingError('CREATE_TOO_LARGE', 'Stream a new file with fs.stage begin, append at most 16384 UTF-8 bytes, then commit.')
    if (raw.operation === undefined) {
      if (typeof raw.path !== 'string' || raw.path.length === 0 || typeof raw.content !== 'string') throw editingError('INVALID_STAGE_INPUT', 'fs.stage requires operation, or path and content for a new file of at most 16384 bytes.')
      if (pulsePath(raw.path)) throw editingError('INVALID_DRAFT_TARGET', 'Draft targets cannot modify Pulse configuration or draft storage.')
      await checkNewJavaScript(raw.path, raw.content, signal)
      const saved = await this.files.writeIfUnchanged(raw.path, raw.content, null, signal)
      return { draftId: randomUUID(), target: raw.path, revision: saved.hash, bytes: saved.bytes, contentHash: saved.hash, committed: true }
    }
    const input = stageCommand.parse(raw)
    if (input.operation === 'begin') {
      if (pulsePath(input.path)) throw editingError('INVALID_DRAFT_TARGET', 'Draft targets cannot modify Pulse configuration or draft storage.')
      const baseline = await this.files.hash(input.path, signal).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (baseline !== null) throw editingError('EXISTING_FILE_NEEDS_PATCH', 'Existing files cannot be rewritten. Use fs.apply_patch or fs.apply_patches for a local change.')
      if (input.expectedHash !== undefined) throw editingError('FILE_BASELINE_MISSING', 'The expected target is missing.')
      // The owner is supplied by the Host, never by model arguments. A stable ID
      // makes the draft discoverable even if the process dies before indexing it.
      const key = digest(JSON.stringify([this.owner, resolve(this.files.root, input.path)]))
      let id = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`
      const indexPath = `.pulse/draft-targets/${key}.json`
      try {
        const index = JSON.parse(await this.files.read(indexPath)) as { draftId?: string; owner?: string }
        if (index.owner !== this.owner || !draftId.safeParse(index.draftId).success) throw editingError('DRAFT_OWNER_CONFLICT', 'Draft index does not belong to this run.')
        id = index.draftId!
      } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
      const draftPath = `.pulse/drafts/${id}.json`
      const initial = input.content ?? ''
      let draft: z.infer<typeof draftSchema> = { version: 1 as const, path: input.path, baseline, content: initial, committed: false, owner: this.owner }
      let serialized = JSON.stringify(draft)
      try { await this.files.writeIfUnchanged(draftPath, serialized, null, signal) }
      catch (error) {
        if ((error as { code?: string }).code !== 'FILE_BASELINE_CONFLICT') throw error
        serialized = await this.files.read(draftPath, signal)
        const prior = draftSchema.parse(JSON.parse(serialized))
        if (prior.owner !== this.owner || resolve(this.files.root, prior.path) !== resolve(this.files.root, input.path)) throw editingError('DRAFT_OWNER_CONFLICT', 'Draft belongs to another task.')
        if (prior.committed) throw editingError('DRAFT_TARGET_CHANGED', 'Previously committed target was removed. Retain the draft and review the external change.')
        draft = { ...prior, owner: this.owner }
      }
      // An index failure leaves the stable draft recoverable by repeating begin.
      try { await this.files.writeIfUnchanged(indexPath, JSON.stringify({ draftId: id, owner: this.owner }), null, signal) }
      catch (error) { if ((error as { code?: string }).code !== 'FILE_BASELINE_CONFLICT') throw error }
      return draftReceipt(id, serialized, draft)
    }
    const path = `.pulse/drafts/${input.draftId}.json`
    const serialized = await this.files.read(path, signal)
    const draft = draftSchema.parse(JSON.parse(serialized))
    if ((draft.owner ?? 'legacy') !== this.owner) throw editingError('DRAFT_OWNER_CONFLICT', 'Draft belongs to another task; explicit owner migration is required for legacy drafts.')
    const revision = digest(serialized)
    if (input.operation !== 'inspect' && input.revision !== revision) throw editingError('DRAFT_REVISION_CONFLICT', 'Inspect the draft and use its current revision. Do not blindly repeat an append.')
    if (input.operation === 'append') {
      if (draft.committed) throw editingError('DRAFT_ALREADY_COMMITTED', 'Begin another draft to make further changes.')
      // New-file ingestion has a separate bound from existing-file patches.
      if (Buffer.byteLength(draft.content + input.content) > MAX_DRAFT_BYTES) throw editingError('DRAFT_TOO_LARGE', 'Split the deliverable into smaller files.')
      draft.content += input.content
    }
    if (input.operation === 'commit') {
      if (pulsePath(draft.path)) throw editingError('INVALID_DRAFT_TARGET', 'Draft targets cannot modify Pulse configuration or draft storage.')
      if (Buffer.byteLength(draft.content) !== input.expectedBytes) throw editingError('DRAFT_SIZE_MISMATCH', 'Inspect the draft and confirm the complete byte count before committing.')
      if (draft.baseline !== null) throw editingError('EXISTING_FILE_NEEDS_PATCH', 'Existing files cannot be rewritten. Use fs.apply_patch or fs.apply_patches for a local change.')
      if (draft.committed && await this.files.hash(draft.path, signal).catch(error => { if (error.code === 'ENOENT') return null; throw error }) !== digest(draft.content)) throw editingError('DRAFT_TARGET_CHANGED', 'Committed target changed or was removed; the old receipt is no longer current. External content was preserved.')
      if (!draft.committed) {
        await checkNewJavaScript(draft.path, draft.content, signal)
        // A crash after target commit but before checkpoint is safe to reconcile.
        const current = await this.files.hash(draft.path, signal).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
        if (current !== digest(draft.content)) await this.files.writeIfUnchanged(draft.path, draft.content, null, signal)
        draft.committed = true
      }
    }
    const next = JSON.stringify(draft)
    if (input.operation !== 'inspect') await this.files.writeIfUnchanged(path, next, revision, signal)
    return draftReceipt(input.draftId, next, draft)
  }
}

/** True only for a .md target strictly inside docs/plans, so the plan exception cannot escape it. */
export function isPlanTarget(root: string, target: string): boolean {
  const plansDir = resolve(root, 'docs', 'plans')
  const absolute = resolve(root, target)
  const within = absolute === plansDir || absolute.startsWith(plansDir + sep)
  return within && /\.md$/i.test(absolute)
}

/**
 * Writes one complete docs/plans markdown deliverable in a single call so a long plan
 * does not need multi-step streaming. It keeps the general new-file creation contract
 * everywhere else, still refuses any path outside docs/plans (and a non-.md target),
 * and never overwrites an existing plan: the null baseline makes writeIfUnchanged
 * link a brand-new file only. writeIfUnchanged creates the parent directory automatically.
 */
export class PlanWriter {
  constructor(private readonly files: FilesystemTool) {}
  /** Set up the reserved output catalog before a planning agent inspects it. */
  async prepareDirectory(): Promise<void> {
    for (const path of ['docs', 'docs/plans']) {
      try { await this.files.list(path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Check each existing parent through FilesystemTool before creating its
        // child; never follow a docs symlink out of the workspace.
        try { await mkdir(resolve(this.files.root, path)) }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
        await this.files.list(path)
      }
    }
  }
  async execute(submitted: { path: string; content: string }, signal?: AbortSignal) {
    if (typeof submitted.path !== 'string' || submitted.path.length === 0) throw editingError('INVALID_PLAN_PATH', 'plan.write needs a workspace path under docs/plans.')
    if (pulsePath(submitted.path)) throw editingError('INVALID_PLAN_PATH', 'Plan writes cannot modify Pulse configuration or draft storage.')
    if (!isPlanTarget(this.files.root, submitted.path)) throw editingError('PLAN_PATH_NOT_ALLOWED', 'plan.write only writes a .md file under docs/plans.')
    if (Buffer.byteLength(submitted.content) > PLAN_BYTES) throw editingError('PLAN_TOO_LARGE', `Limit a plan write to ${PLAN_BYTES} UTF-8 bytes.`)
    return { path: submitted.path, ...(await this.files.writeIfUnchanged(submitted.path, submitted.content, null, signal)) }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface FragmentMatch {
  start: number
  end: number
  replace: string
}

function findFragmentMatches(source: string, find: string, replace: string): { matches: FragmentMatch[]; level: number } {
  // Level 0: Exact byte substring
  const level0Matches: FragmentMatch[] = []
  let pos = source.indexOf(find)
  while (pos >= 0) {
    level0Matches.push({ start: pos, end: pos + find.length, replace })
    pos = source.indexOf(find, pos + find.length)
  }
  if (level0Matches.length > 0) {
    return { matches: level0Matches, level: 0 }
  }

  // Level 1: CRLF / LF line ending normalization
  const l1Lines = find.split(/\r?\n/)
  if (l1Lines.length > 1 || find.includes('\n')) {
    const l1Pat = l1Lines.map(l => escapeRegex(l)).join('\\r?\\n')
    const l1Regex = new RegExp(l1Pat, 'g')
    const l1Matches: FragmentMatch[] = []
    let m: RegExpExecArray | null
    while ((m = l1Regex.exec(source)) !== null) {
      let adaptedReplace = replace
      if (m[0].includes('\r\n') && !replace.includes('\r\n')) {
        adaptedReplace = replace.replace(/\n/g, '\r\n')
      }
      l1Matches.push({ start: m.index, end: m.index + m[0].length, replace: adaptedReplace })
      if (m[0].length === 0) l1Regex.lastIndex++
    }
    if (l1Matches.length > 0) {
      return { matches: l1Matches, level: 1 }
    }
  }

  // Level 2: Ignore trailing line whitespace (trimEnd)
  const l2Lines = find.split(/\r?\n/)
  const l2Pat = l2Lines.map((line, idx) => {
    const isLast = idx === l2Lines.length - 1
    const trimmed = line.replace(/[ \t]+$/, '')
    if (!isLast) return escapeRegex(trimmed) + '[ \\t]*\\r?\\n'
    // A find that ends in a newline already consumed that newline on the previous segment.
    // The last line must not swallow the following line's indentation.
    if (trimmed.length === 0) return ''
    return escapeRegex(trimmed) + '[ \\t]*(?=\\r?\\n|$)'
  }).join('')
  if (l2Pat.length === 0) return { matches: [], level: -1 }
  const l2Regex = new RegExp(l2Pat, 'g')
  const l2Matches: FragmentMatch[] = []
  let m2: RegExpExecArray | null
  while ((m2 = l2Regex.exec(source)) !== null) {
    let adaptedReplace = replace
    if (m2[0].includes('\r\n') && !replace.includes('\r\n')) {
      adaptedReplace = replace.replace(/\n/g, '\r\n')
    }
    l2Matches.push({ start: m2.index, end: m2.index + m2[0].length, replace: adaptedReplace })
    if (m2[0].length === 0) l2Regex.lastIndex++
  }
  if (l2Matches.length > 0) {
    return { matches: l2Matches, level: 2 }
  }

  return { matches: [], level: -1 }
}

export interface ReadInterval {
  start: number
  end: number
}

export interface FileReadRecord {
  hash: string
  intervals: ReadInterval[]
  reachedEnd: boolean
  totalBytes?: number
}

export class LaneReadTracker {
  private readonly reads = new Map<string, Map<string, FileReadRecord>>()

  recordRead(laneId: string, canonicalPath: string, hash: string, offset: number, bytesRead: number, nextOffset: number | null): void {
    let laneMap = this.reads.get(laneId)
    if (!laneMap) {
      laneMap = new Map()
      this.reads.set(laneId, laneMap)
    }
    let record = laneMap.get(canonicalPath)
    if (!record || record.hash !== hash) {
      record = { hash, intervals: [], reachedEnd: false }
      laneMap.set(canonicalPath, record)
    }
    const end = offset + bytesRead
    record.intervals.push({ start: offset, end })
    if (nextOffset === null) {
      record.reachedEnd = true
      record.totalBytes = end
    }
  }

  getLatestReadHash(laneId: string, canonicalPath: string): string | undefined {
    return this.reads.get(laneId)?.get(canonicalPath)?.hash
  }

  hasFullReadCoverage(laneId: string, canonicalPath: string, expectedHash: string): boolean {
    const record = this.reads.get(laneId)?.get(canonicalPath)
    if (!record || record.hash !== expectedHash || !record.reachedEnd) {
      return false
    }
    const targetEnd = record.totalBytes ?? 0
    if (targetEnd === 0 && record.intervals.length === 0) {
      return true
    }
    const sorted = [...record.intervals].sort((a, b) => a.start - b.start)
    let coveredUpTo = 0
    for (const interval of sorted) {
      if (interval.start > coveredUpTo) {
        return false
      }
      if (interval.end > coveredUpTo) {
        coveredUpTo = interval.end
      }
    }
    return coveredUpTo >= targetEnd
  }
}

export interface ExactFragment { find: string; replace: string }
export type PatchMatching = 'exact' | 'normalized'
/** Compare-and-swap editing. Old snapshots stay on exact indexOf. Normalized matching is an explicit new surface. */
export interface PatchEditResult {
  path: string; replacements: number; bytes: number; hash: string; beforeHash: string; changed: boolean
  alreadyApplied?: boolean; rebased?: boolean; requestedBaseHash?: string
}
interface PatchEditInput { path: string; patches: ExactFragment[]; expectedHash?: string | undefined; all?: boolean | undefined }

export class ExactPatchEditor {
  constructor(private readonly files: FilesystemTool, private readonly validate?: (path: string, content: string) => Promise<void>, private readonly matching: PatchMatching = 'exact', private readonly applyVersion: 1 | 2 = 1) {}
  private conflict(input: PatchEditInput, content: string, code: string): never {
    const { path, patches, expectedHash } = input
    const toolName = patches.length === 1 ? 'fs.apply_patch' : 'fs.apply_patches'
    const candidates = patches.flatMap(p => [p.find, p.replace, ...p.replace.split('\n').filter(line => line.trim().length >= 12), ...(p.find.match(/[A-Za-z_$][A-Za-z0-9_$]{7,}/g) ?? [])]).filter(Boolean)
    const index = candidates.map(text => content.indexOf(text)).find(index => index >= 0) ?? 0
    let start = Math.max(0, index - 128)
    if (start > 0 && content.charCodeAt(start) >= 0xdc00 && content.charCodeAt(start) <= 0xdfff) start--
    const offset = Buffer.byteLength(content.slice(0, start))
    const canonicalPath = relative(this.files.root, resolve(this.files.root, path)).replaceAll('\\', '/')
    throw Object.assign(editingError(code, `${code}: no file written. Use the current file evidence or the suggested bounded fs.read, then verify the existing change or submit a new exact fragment against the current hash.`), { details: {
      kind: 'patch-conflict', toolName, path: canonicalPath, workspaceRoot: this.files.root, currentHash: digest(content),
      ...(expectedHash === undefined ? {} : { expectedHash }),
      findHashes: patches.map(p => digest(p.find)),
      missingFindHashes: patches.filter(p => !content.includes(p.find)).map(p => digest(p.find)),
      suggestedRead: { path: canonicalPath, offset, maxBytes: 3000 },
    } })
  }
  private prepare(input: PatchEditInput, source: string): { content: string; result: PatchEditResult } {
    const { path, patches, expectedHash, all = false } = input
    const beforeHash = digest(source), rebasing = this.applyVersion === 2 && expectedHash !== undefined && expectedHash !== beforeHash
    const conflict = (code: string): never => this.conflict(input, source, code)
    const receipt = (content: string, replacements: number, alreadyApplied = false) => ({ content, result: {
      path, replacements, bytes: Buffer.byteLength(content), hash: digest(content), beforeHash, changed: content !== source,
      ...(alreadyApplied ? { alreadyApplied: true } : {}),
      ...(this.applyVersion === 2 ? { rebased: rebasing && !alreadyApplied, ...(expectedHash ? { requestedBaseHash: expectedHash } : {}) } : {}),
    } })
    // Only the entire cryptographically proven post-image can settle a replay.
    // Finding replacement text alone, or a partially applied batch, proves nothing.
    if (expectedHash && expectedHash !== beforeHash && patches.every(p => p.replace.length > 0)) {
      const inverse = exactEdits(source, patches.map(p => ({ find: p.replace, replace: p.find })), all, this.matching)
      if (inverse) {
        const baseline = applyExactEdits(source, inverse)
        const forward = exactEdits(baseline, patches, all, this.matching)
        if (digest(baseline) === expectedHash && forward && applyExactEdits(baseline, forward) === source) return receipt(source, 0, true)
      }
    }
    if (this.applyVersion === 1 && expectedHash !== undefined && expectedHash !== beforeHash) conflict('FILE_BASELINE_CONFLICT')
    if ((expectedHash === undefined || rebasing) && patches.some(p => p.find !== p.replace && p.replace.includes(p.find) && source.includes(p.replace))) conflict('PATCH_CONTEXT_AMBIGUOUS')
    const edits: FragmentMatch[] = []
    for (const p of patches) {
      const { matches } = locateFragment(source, p.find, p.replace, this.matching)
      if (!matches.length) conflict('PATCH_CONTEXT_NOT_FOUND')
      if ((!all || rebasing) && matches.length > 1) conflict('PATCH_CONTEXT_AMBIGUOUS')
      const count = all ? matches.length : 1
      if (all && count * Math.max(Buffer.byteLength(p.find), Buffer.byteLength(p.replace)) > EDIT_BYTES) throw editingError('PATCH_TOO_BROAD', 'Split into smaller, unique-context patches.')
      edits.push(...(all ? matches : [matches[0]!]))
    }
    edits.sort((a, b) => a.start - b.start)
    if (edits.some((e, i) => i > 0 && edits[i - 1]!.end > e.start)) conflict('PATCH_RANGES_OVERLAP')
    return receipt(applyExactEdits(source, edits), edits.length)
  }
  async execute(input: PatchEditInput, signal?: AbortSignal): Promise<PatchEditResult> {
    const { path, patches, expectedHash, all = false } = input
    if (!patches.length || patches.length > 16 || all && patches.length !== 1 || patches.some(p => !p.find)) throw editingError('INVALID_PATCH_INPUT', 'Supply 1-16 nonempty exact fragments; all is only valid for a single fragment.')
    for (const patch of patches) { boundedEdit(patch.find); boundedEdit(patch.replace) }
    const read = async () => {
      const source = await this.files.readLimited(path, 500_000, signal)
      if (source.truncated) throw editingError('FILE_TOO_LARGE', 'File exceeds the bounded patch editor.')
      return source.content
    }
    try {
      if (this.applyVersion === 2) {
        if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) throw editingError('INVALID_FILE_BASELINE_HASH', 'Use the SHA-256 from a visible file read.')
        return await this.files.editText(path, 500_000, async source => {
          const proposed = this.prepare(input, source)
          if (proposed.result.changed) await this.validate?.(path, proposed.content)
          return proposed
        }, signal)
      }
      // Old runs retain their strict baseline and replay behavior.
      const source = await read(), proposed = this.prepare(input, source)
      if (proposed.result.alreadyApplied && await this.files.hash(path, signal) !== proposed.result.beforeHash) this.conflict(input, await read(), 'FILE_BASELINE_CONFLICT')
      if (!proposed.result.changed) return proposed.result
      await this.validate?.(path, proposed.content)
      await this.files.writeIfUnchanged(path, proposed.content, expectedHash ?? proposed.result.beforeHash, signal)
      return proposed.result
    } catch (error) {
      if ((error as { code?: string; details?: unknown }).code === 'FILE_BASELINE_CONFLICT' && !(error as { details?: unknown }).details && (this.applyVersion === 1 || (error as { beforeCommit?: boolean }).beforeCommit)) this.conflict(input, await read(), 'FILE_BASELINE_CONFLICT')
      throw error
    }
  }
}

interface ExactEdit { start: number; end: number; replace: string }
function locateFragment(source: string, find: string, replace: string, matching: PatchMatching): { matches: FragmentMatch[]; level: number } {
  if (matching === 'exact') {
    const matches: FragmentMatch[] = []
    let pos = source.indexOf(find)
    while (pos >= 0) {
      matches.push({ start: pos, end: pos + find.length, replace })
      pos = source.indexOf(find, pos + Math.max(find.length, 1))
    }
    return { matches, level: matches.length > 0 ? 0 : -1 }
  }
  return findFragmentMatches(source, find, replace)
}
function exactEdits(source: string, patches: ExactFragment[], all: boolean, matching: PatchMatching): ExactEdit[] | undefined {
  const edits: ExactEdit[] = []
  for (const { find, replace } of patches) {
    if (!find) return undefined
    const { matches } = locateFragment(source, find, replace, matching)
    if (matches.length === 0) return undefined
    if (!all && matches.length >= 2) return undefined
    if (all && matches.length * Math.max(Buffer.byteLength(find), Buffer.byteLength(replace)) > EDIT_BYTES) return undefined
    if (all) edits.push(...matches)
    else edits.push(matches[0]!)
  }
  edits.sort((a, b) => a.start - b.start)
  return edits.some((e, i) => i > 0 && edits[i - 1]!.end > e.start) ? undefined : edits
}
function applyExactEdits(source: string, edits: ExactEdit[]): string {
  let result = source
  for (const e of [...edits].reverse()) result = result.slice(0, e.start) + e.replace + result.slice(e.end)
  return result
}
