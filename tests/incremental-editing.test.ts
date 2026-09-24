import { mkdtemp, readFile, rm, writeFile, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { StagedEditor, boundedEdit } from '../packages/server/src/editing.js'

describe('incremental file editing', () => {
  it('keeps the original intact until a complete draft is committed, including after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-draft-'))
    try {
      const files = new FilesystemTool(root)
      await writeFile(join(root, 'file.ts'), 'original')
      await chmod(join(root, 'file.ts'), 0o755)
      const editor = new StagedEditor(files)
      let draft = await editor.execute({ operation: 'begin', path: 'file.ts', expectedHash: await files.hash('file.ts') })
      draft = await editor.execute({ operation: 'append', draftId: draft.draftId, revision: draft.revision, content: 'a'.repeat(8000) })
      expect(await files.read('file.ts')).toBe('original')
      const restored = new StagedEditor(new FilesystemTool(root))
      const saved = await restored.execute({ operation: 'inspect', draftId: draft.draftId })
      expect(saved).toEqual(draft)
      draft = await restored.execute({ operation: 'append', draftId: draft.draftId, revision: saved.revision, content: '雪'.repeat(2000) })
      await expect(restored.execute({ operation: 'commit', draftId: draft.draftId, revision: draft.revision, expectedBytes: 1 })).rejects.toMatchObject({ code: 'DRAFT_SIZE_MISMATCH' })
      expect(await files.read('file.ts')).toBe('original')
      const result = await restored.execute({ operation: 'commit', draftId: draft.draftId, revision: draft.revision, expectedBytes: 14000 })
      expect(result.committed).toBe(true)
      expect(await files.read('file.ts')).toBe('a'.repeat(8000) + '雪'.repeat(2000))
      if (process.platform !== 'win32') expect((await stat(join(root, 'file.ts'))).mode & 0o777).toBe(0o755)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects stale appends, concurrent target changes, and aborted commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-draft-conflict-'))
    try {
      const files = new FilesystemTool(root)
      const editor = new StagedEditor(files)
      const empty = await editor.execute({ operation: 'begin', path: 'new.txt' })
      const filled = await editor.execute({ operation: 'append', draftId: empty.draftId, revision: empty.revision, content: 'new' })
      await expect(editor.execute({ operation: 'append', draftId: empty.draftId, revision: empty.revision, content: 'duplicate' })).rejects.toMatchObject({ code: 'DRAFT_REVISION_CONFLICT' })
      const controller = new AbortController(); controller.abort()
      await expect(editor.execute({ operation: 'commit', draftId: filled.draftId, revision: filled.revision, expectedBytes: 3 }, controller.signal)).rejects.toThrow()
      await expect(readFile(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(join(root, 'new.txt'), 'someone else')
      await expect(editor.execute({ operation: 'commit', draftId: filled.draftId, revision: filled.revision, expectedBytes: 3 })).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT' })
      expect(await files.read('new.txt')).toBe('someone else')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not overwrite existing files without a baseline and bounds UTF-8 edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-create-only-'))
    try {
      const files = new FilesystemTool(root)
      await files.writeIfUnchanged('file.txt', 'first', null)
      await expect(files.writeIfUnchanged('file.txt', 'second', null)).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT' })
      expect(await files.read('file.txt')).toBe('first')
      expect(() => boundedEdit('雪'.repeat(3000))).toThrow('8192')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
