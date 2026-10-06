import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'

export const EDIT_BYTES = 8_192
export const STREAM_BYTES = 2_048
const MAX_DRAFT_BYTES = 500_000
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export function editingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false })
}
export function boundedEdit(text: string): void {
  if (Buffer.byteLength(text) > EDIT_BYTES) throw editingError('EDIT_TOO_LARGE', 'Limit each edit fragment to 8192 UTF-8 bytes. Use a smaller fs.apply_patch. Stream a new file with fs.stage in chunks of at most 2048 bytes.')
}

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const draftId = z.string().uuid()
const stageCommand = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('begin'), path: z.string(), expectedHash: hash.optional() }),
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
const draftSchema = z.object({ version: z.literal(1), path: z.string(), baseline: hash.nullable(), content: z.string(), committed: z.boolean() })
const pulsePath = (path: string): boolean => path.replaceAll('\\', '/').split('/').includes('.pulse')

/** Each revision is durable. Incomplete drafts never touch their target file. */
export class StagedEditor {
  constructor(private readonly files: FilesystemTool) {}
  async execute(submitted: z.input<typeof stageInput>, signal?: AbortSignal) {
    const raw = { ...submitted, operation: submitted.operation ?? submitted.op }
    if (typeof raw.content === 'string' && Buffer.byteLength(raw.content) > STREAM_BYTES) throw editingError('CREATE_TOO_LARGE', 'Stream a new file with fs.stage begin, append at most 2048 UTF-8 bytes, then commit.')
    if (raw.operation === undefined) {
      if (typeof raw.path !== 'string' || raw.path.length === 0 || typeof raw.content !== 'string') throw editingError('INVALID_STAGE_INPUT', 'fs.stage requires operation, or path and content for a new file of at most 2048 bytes.')
      if (pulsePath(raw.path)) throw editingError('INVALID_DRAFT_TARGET', 'Draft targets cannot modify Pulse configuration or draft storage.')
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
      const id = randomUUID()
      const draft = { version: 1 as const, path: input.path, baseline, content: '', committed: false }
      const serialized = JSON.stringify(draft)
      await this.files.writeIfUnchanged(`.pulse/drafts/${id}.json`, serialized, null, signal)
      return { draftId: id, target: draft.path, revision: digest(serialized), bytes: 0, contentHash: digest(''), committed: false }
    }
    const path = `.pulse/drafts/${input.draftId}.json`
    const serialized = await this.files.read(path, signal)
    const draft = draftSchema.parse(JSON.parse(serialized))
    const revision = digest(serialized)
    if (input.operation !== 'inspect' && input.revision !== revision) throw editingError('DRAFT_REVISION_CONFLICT', 'Inspect the draft and use its current revision. Do not blindly repeat an append.')
    if (input.operation === 'append') {
      if (draft.committed) throw editingError('DRAFT_ALREADY_COMMITTED', 'Begin another draft to make further changes.')
      boundedEdit(input.content)
      if (Buffer.byteLength(draft.content + input.content) > MAX_DRAFT_BYTES) throw editingError('DRAFT_TOO_LARGE', 'Split the deliverable into smaller files.')
      draft.content += input.content
    }
    if (input.operation === 'commit') {
      if (pulsePath(draft.path)) throw editingError('INVALID_DRAFT_TARGET', 'Draft targets cannot modify Pulse configuration or draft storage.')
      if (Buffer.byteLength(draft.content) !== input.expectedBytes) throw editingError('DRAFT_SIZE_MISMATCH', 'Inspect the draft and confirm the complete byte count before committing.')
      if (draft.baseline !== null) throw editingError('EXISTING_FILE_NEEDS_PATCH', 'Existing files cannot be rewritten. Use fs.apply_patch or fs.apply_patches for a local change.')
      if (!draft.committed) {
        // A crash after target commit but before checkpoint is safe to reconcile.
        const current = await this.files.hash(draft.path, signal).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
        if (current !== digest(draft.content)) await this.files.writeIfUnchanged(draft.path, draft.content, null, signal)
        draft.committed = true
      }
    }
    const next = JSON.stringify(draft)
    if (input.operation !== 'inspect') await this.files.writeIfUnchanged(path, next, revision, signal)
    return { draftId: input.draftId, target: draft.path, revision: digest(next), bytes: Buffer.byteLength(draft.content), contentHash: digest(draft.content), committed: draft.committed }
  }
}
