import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'

export const EDIT_BYTES = 8_192
const MAX_DRAFT_BYTES = 500_000
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export function editingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false })
}
export function boundedEdit(text: string): void {
  if (Buffer.byteLength(text) > EDIT_BYTES) throw editingError('EDIT_TOO_LARGE', 'Limit each edit to 8192 UTF-8 bytes. Use a smaller fs.apply_patch, or fs.stage begin/append/commit for a genuinely new or rewritten file.')
}

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const draftId = z.string().uuid()
const stageCommand = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('begin'), path: z.string(), expectedHash: hash.optional() }),
  z.object({ operation: z.literal('inspect'), draftId }),
  z.object({ operation: z.literal('append'), draftId, revision: hash, content: z.string().min(1).max(EDIT_BYTES) }),
  z.object({ operation: z.literal('commit'), draftId, revision: hash, expectedBytes: z.number().int().min(0).max(MAX_DRAFT_BYTES) }),
])
// Providers require an object at the root of a tool JSON schema. Validate the
// operation-specific required fields separately before any filesystem action.
export const stageInput = z.object({
  operation: z.enum(['begin', 'inspect', 'append', 'commit']),
  path: z.string().optional(), expectedHash: hash.optional(), draftId: draftId.optional(),
  revision: hash.optional(), content: z.string().max(EDIT_BYTES).optional(),
  expectedBytes: z.number().int().min(0).max(MAX_DRAFT_BYTES).optional(),
})
const draftSchema = z.object({ version: z.literal(1), path: z.string(), baseline: hash.nullable(), content: z.string(), committed: z.boolean() })

/** Each revision is durable. Incomplete drafts never touch their target file. */
export class StagedEditor {
  constructor(private readonly files: FilesystemTool) {}
  async execute(raw: z.infer<typeof stageInput>, signal?: AbortSignal) {
    const input = stageCommand.parse(raw)
    if (input.operation === 'begin') {
      if (input.path.replaceAll('\\', '/').split('/').includes('.pulse')) throw editingError('INVALID_DRAFT_TARGET', 'Draft targets cannot modify Pulse configuration or draft storage.')
      const baseline = await this.files.hash(input.path, signal).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (baseline !== null && input.expectedHash !== baseline) throw editingError('FILE_BASELINE_CONFLICT', 'Read the target and supply its current hash before staging a replacement.')
      if (baseline === null && input.expectedHash !== undefined) throw editingError('FILE_BASELINE_MISSING', 'The expected target is missing.')
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
      if (Buffer.byteLength(draft.content) !== input.expectedBytes) throw editingError('DRAFT_SIZE_MISMATCH', 'Inspect the draft and confirm the complete byte count before committing.')
      if (!draft.committed) {
        // A crash after target commit but before checkpoint is safe to reconcile.
        const current = await this.files.hash(draft.path, signal).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
        if (current !== digest(draft.content)) await this.files.writeIfUnchanged(draft.path, draft.content, draft.baseline, signal)
        draft.committed = true
      }
    }
    const next = JSON.stringify(draft)
    if (input.operation !== 'inspect') await this.files.writeIfUnchanged(path, next, revision, signal)
    return { draftId: input.draftId, target: draft.path, revision: digest(next), bytes: Buffer.byteLength(draft.content), contentHash: digest(draft.content), committed: draft.committed }
  }
}
