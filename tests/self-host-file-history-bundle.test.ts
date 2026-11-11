import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { stageConversationBundle } from '../packages/server/src/conversation-bundle.js'

const require = createRequire(import.meta.url)
const { ZipFile } = require('../packages/server/node_modules/yazl') as typeof import('../packages/server/node_modules/yazl')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// Same real ZIP pipeline as conversation-bundle.test.ts, with a minimal valid
// checksummed manifest so rejection cannot be attributed to a corrupt archive.
async function archive(root: string, extra: Record<string, unknown>) {
  const id = `conv-${randomUUID()}`, cwd = join(root, 'source')
  const manifest = JSON.stringify({ schemaVersion: 1, id, title: 'Synthetic transfer', cwd, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', runs: [], ...extra })
  const metadata = JSON.stringify({
    format: 'pulse-work-conversation', version: 1, exportedAt: '2026-01-01T00:00:00Z', conversationId: id,
    source: { cwd, executionCwd: cwd, stamp: { available: false, files: {} } },
    files: [{ path: 'conversation/manifest.json', bytes: Buffer.byteLength(manifest), sha256: createHash('sha256').update(manifest).digest('hex') }],
    blockedReasons: [], redactedFiles: [],
  })
  const path = join(root, `${randomUUID()}.zip`), zip = new ZipFile()
  const done = pipeline(zip.outputStream, createWriteStream(path))
  zip.addBuffer(Buffer.from(metadata), 'bundle.json')
  zip.addBuffer(Buffer.from(manifest), 'conversation/manifest.json')
  zip.end(); await done
  return path
}

describe('self-host external file history transfer boundary', () => {
  it('accepts the same synthetic archive without a self-host binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-history-bundle-')); roots.push(root)
    const staged = await stageConversationBundle(createReadStream(await archive(root, {})), join(root, 'imports'))
    expect(staged.manifest.title).toBe('Synthetic transfer')
  })

  it.each([
    ['required marker', { selfHostFileHistoryRequired: true }],
    ['binding without marker', { selfHostFileHistory: { version: 1, conversationId: 'foreign', projectRoot: '/synthetic/project', workspaceRoot: '/synthetic/candidate', storageRoot: '/synthetic/data/history', workspaceDev: 1, workspaceIno: 2 } }],
    ['closed marker', { selfHostFileHistoryClosed: true }],
  ] as const)('rejects %s before schema stripping can downgrade it to legacy storage', async (_label, fields) => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-history-bundle-')); roots.push(root)
    const imports = join(root, 'imports'), path = await archive(root, fields)
    await expect(stageConversationBundle(createReadStream(path), imports)).rejects.toMatchObject({ code: 'SELF_HOST_HISTORY_NOT_PORTABLE' })
    expect(await readdir(imports)).toEqual([])
  })
})
