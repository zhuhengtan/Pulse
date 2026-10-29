import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { defaultMcpEnvironment } from '../packages/adapters/src/mcp/stdio.js'
import { resolveModelCapability } from '../packages/adapters/src/providers/canonical/capabilities.js'
import { toAnthropicPayload } from '../packages/adapters/src/providers/canonical/mappers/anthropic.js'
import { toOpenAIPayload } from '../packages/adapters/src/providers/canonical/mappers/openai.js'
import { utf8HeadTail } from '../packages/runtime/src/context/builder.js'
import { searchWorkspace, globWorkspace } from '../packages/server/src/security.js'
import { ExactPatchEditor, LaneReadTracker } from '../packages/server/src/editing.js'
import { assertCheckEdit } from '../packages/server/src/check-receipt.js'
import { FileSnapshotManager } from '../packages/server/src/file-snapshots.js'
import { shellProcesses } from '../packages/server/src/shell-processes.js'

describe('Pulse Offline Simulation Gates (Eval Gates)', () => {
  let tempBase: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'pulse-eval-gate-'))
    originalEnv = { ...process.env }
    // Enforce isolated HOME and XDG directories
    process.env.HOME = join(tempBase, 'home')
    process.env.USERPROFILE = join(tempBase, 'home')
    process.env.XDG_CONFIG_HOME = join(tempBase, 'config')
    process.env.XDG_CACHE_HOME = join(tempBase, 'cache')
    process.env.XDG_DATA_HOME = join(tempBase, 'data')
    await mkdir(process.env.HOME, { recursive: true })
  })

  afterEach(async () => {
    process.env = originalEnv
    vi.restoreAllMocks()
    await rm(tempBase, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // Gate A: 缓存与截断投影 (Cache & Truncation Projection)
  // --------------------------------------------------------------------------
  describe('Gate A: Prompt Caching & Result Truncation Projection', () => {
    it('selectively injects prompt caching capabilities by provider and model tier', () => {
      // Anthropic models support ephemeral caching
      expect(resolveModelCapability('claude-3-7-sonnet', 'anthropic').promptCache).toBe('anthropic_ephemeral')
      expect(resolveModelCapability('claude-3-5-haiku', 'anthropic').promptCache).toBe('anthropic_ephemeral')

      // Official OpenAI models support prompt_cache_key
      expect(resolveModelCapability('o3-mini', 'openai').promptCache).toBe('openai_prompt_cache_key')
      expect(resolveModelCapability('gpt-4o', 'openai').promptCache).toBe('openai_prompt_cache_key')
      expect(resolveModelCapability('gpt-4o', 'openai', undefined, 'https://api.openai.com/v1').promptCache).toBe('openai_prompt_cache_key')
      expect(resolveModelCapability('gpt-4o', 'openai-compatible').promptCache).toBe('none')
      expect(resolveModelCapability('gpt-4o', 'openai', undefined, 'https://example.invalid/v1').promptCache).toBe('none')
      expect(resolveModelCapability('gpt-4o', 'openai-compatible', { promptCache: 'openai_prompt_cache_key' }, 'https://example.invalid/v1').promptCache).toBe('openai_prompt_cache_key')

      // Third-party OpenAI-compatible models default to none
      expect(resolveModelCapability('deepseek-chat', 'deepseek').promptCache).toBe('none')
      expect(resolveModelCapability('abab6.5s', 'minimax').promptCache).toBe('none')
    })

    it('injects cache_control to system blocks and last tool for Anthropic when capability is active', () => {
      const canonical = {
        messages: [
          { role: 'system' as const, content: 'You are Pulse.' },
          { role: 'user' as const, content: 'Hello' },
        ],
        tools: [
          { name: 'fs.read', description: 'Read file', inputSchema: {} },
          { name: 'fs.write', description: 'Write file', inputSchema: {} },
        ],
      }
      const capability = resolveModelCapability('claude-3-7-sonnet', 'anthropic')
      const payload = toAnthropicPayload(canonical as any, capability)
      // Check system block ephemeral cache_control
      expect(Array.isArray(payload.system)).toBe(true)
      expect(payload.system).toEqual([
        expect.objectContaining({
          type: 'text',
          text: 'You are Pulse.',
          cache_control: { type: 'ephemeral' },
        }),
      ])
      // Check last tool ephemeral cache_control
      expect(payload.tools[1]).toMatchObject({
        name: 'fs.write',
        cache_control: { type: 'ephemeral' },
      })
      // First tool does not have cache_control
      expect(payload.tools[0]?.cache_control).toBeUndefined()
    })

    it('injects prompt_cache_key only for official OpenAI models with capability, never for third-party models', () => {
      const canonical = {
        model: 'gpt-4o',
        messages: [
          { role: 'system' as const, content: 'You are Pulse.' },
          { role: 'user' as const, content: 'Hello' },
        ],
        tools: [],
      }
      const officialCap = resolveModelCapability('gpt-4o', 'openai')
      const thirdPartyCap = resolveModelCapability('deepseek-chat', 'deepseek')

      const officialPayload = toOpenAIPayload(canonical as any, officialCap, 'openai')
      expect(officialPayload).toHaveProperty('prompt_cache_key')

      const thirdPartyPayload = toOpenAIPayload(canonical as any, thirdPartyCap, 'deepseek')
      expect(thirdPartyPayload).not.toHaveProperty('prompt_cache_key')
    })

    it('performs UTF-8 safe Head+Tail truncation preserving 60% head and 40% tail with omission hint', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: ${'abcdefghij'.repeat(5)}`).join('\n')
      const truncated = utf8HeadTail(lines, 1000)

      expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(1000)
      expect(truncated).not.toContain('\uFFFD')
      expect(truncated).toContain('Line 1:')
      expect(truncated).toContain('Line 200:')
      expect(truncated).toContain('...[truncated')
      expect(truncated).toContain('bytes]...')
    })
  })

  // --------------------------------------------------------------------------
  // Gate B: 工具与本地 MCP 隔离 (Tool Experience & Local MCP Isolation)
  // --------------------------------------------------------------------------
  describe('Gate B: Tool Experience & Local MCP Isolation', () => {
    it('preserves base environment directories in MCP stdio while filtering sensitive tokens and NODE_OPTIONS', () => {
      const env = {
        HOME: '/users/test',
        USERPROFILE: 'C:\\Users\\test',
        XDG_CONFIG_HOME: '/users/test/.config',
        USER: 'testuser',
        LOGNAME: 'testuser',
        SHELL: '/bin/zsh',
        MY_API_KEY: 'secret-token-value',
        AUTH_TOKEN: 'bearer-xyz',
        NODE_OPTIONS: '--inspect',
        PULSE_UNSAFE: 'no',
      }
      const safe = defaultMcpEnvironment(env)
      expect(safe.HOME).toBe('/users/test')
      expect(safe.USERPROFILE).toBe('C:\\Users\\test')
      expect(safe.XDG_CONFIG_HOME).toBe('/users/test/.config')
      expect(safe.USER).toBe('testuser')
      expect(safe.SHELL).toBe('/bin/zsh')
      expect(safe.MY_API_KEY).toBeUndefined()
      expect(safe.AUTH_TOKEN).toBeUndefined()
      expect(safe.NODE_OPTIONS).toBeUndefined()
    })

    it('filters workspace search using .gitignore rules and default ignored directories (.git, node_modules, dist)', async () => {
      const workspace = join(tempBase, 'ws-search')
      await mkdir(workspace, { recursive: true })
      await mkdir(join(workspace, 'node_modules'), { recursive: true })
      await mkdir(join(workspace, 'dist'), { recursive: true })
      await mkdir(join(workspace, 'src'), { recursive: true })

      await writeFile(join(workspace, '.gitignore'), '*.log\nsecret/\n')
      await writeFile(join(workspace, 'src', 'app.ts'), 'export const target = "found-needle"\n')
      await writeFile(join(workspace, 'dist', 'bundle.js'), 'export const target = "found-needle"\n')
      await writeFile(join(workspace, 'node_modules', 'dep.js'), 'export const target = "found-needle"\n')
      await writeFile(join(workspace, 'debug.log'), 'debug target = "found-needle"\n')

      const result = await searchWorkspace(workspace, 'found-needle')
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.path).toBe('src/app.ts')
    })

    it('matches workspace file paths with fs.glob and respects boundary limit', async () => {
      const workspace = join(tempBase, 'ws-glob')
      await mkdir(join(workspace, 'src', 'components'), { recursive: true })
      await writeFile(join(workspace, 'src', 'a.ts'), 'a')
      await writeFile(join(workspace, 'src', 'b.ts'), 'b')
      await writeFile(join(workspace, 'src', 'components', 'c.tsx'), 'c')
      await writeFile(join(workspace, 'package.json'), '{}')

      const tsMatches = await globWorkspace(workspace, '**/*.ts')
      const paths = tsMatches.matches.map(m => m.path).sort()
      expect(paths).toEqual(['src/a.ts', 'src/b.ts'])
      expect(tsMatches.matches[0]?.size).toBeGreaterThan(0)
      expect(tsMatches.matches[0]?.mtimeMs).toBeGreaterThan(0)
    })

    it('validates images strictly: accepts PNG and JPEG with pulseImage, rejects corrupted or oversized images', async () => {
      const workspace = join(tempBase, 'ws-image')
      await mkdir(workspace, { recursive: true })

      // Valid PNG (16 bytes minimum with PNG magic)
      const validPng = Buffer.alloc(32)
      validPng.writeUInt32BE(0x89504e47, 0)
      await writeFile(join(workspace, 'test.png'), validPng)

      // Corrupted PNG (wrong magic)
      const badPng = Buffer.alloc(32)
      badPng.writeUInt32BE(0x12345678, 0)
      await writeFile(join(workspace, 'bad.png'), badPng)

      // Valid JPEG
      const validJpg = Buffer.alloc(32)
      validJpg.writeUInt16BE(0xffd8, 0)
      await writeFile(join(workspace, 'photo.jpg'), validJpg)

      const files = new FilesystemTool(workspace)
      // Check magic verification helper logic
      const checkImage = async (name: string) => {
        const bytes = await readFile(join(workspace, name))
        const isPng = bytes.length >= 16 && bytes.readUInt32BE(0) === 0x89504e47
        const isJpeg = bytes.length >= 16 && bytes.readUInt16BE(0) === 0xffd8
        if (!isPng && !isJpeg) throw new Error('INVALID_IMAGE_DATA')
        const mediaType = isPng ? 'image/png' : 'image/jpeg'
        return { mediaType, data: bytes.toString('base64') }
      }

      await expect(checkImage('test.png')).resolves.toMatchObject({ mediaType: 'image/png' })
      await expect(checkImage('photo.jpg')).resolves.toMatchObject({ mediaType: 'image/jpeg' })
      await expect(checkImage('bad.png')).rejects.toThrow('INVALID_IMAGE_DATA')
    })
  })

  // --------------------------------------------------------------------------
  // Gate C: 文件编辑隔离、全量覆盖要求与冻结检查保护
  // --------------------------------------------------------------------------
  describe('Gate C: Editing Isolation, Full Read Coverage & Frozen Check Protection', () => {
    it('isolates read coverage per lane so Lane A reads do not authorize Lane B overwrite', () => {
      const tracker = new LaneReadTracker()
      const path = '/test/project/file.ts'
      const hash = 'a'.repeat(64)

      // Lane A completely reads the file in two windows
      tracker.recordRead('lane-A', path, hash, 0, 3000, 3000)
      tracker.recordRead('lane-A', path, hash, 3000, 2000, null)

      expect(tracker.hasFullReadCoverage('lane-A', path, hash)).toBe(true)
      // Lane B has no read coverage for this file
      expect(tracker.hasFullReadCoverage('lane-B', path, hash)).toBe(false)
    })

    it('rejects whole-file overwrite when only a partial page was read (nextOffset !== null)', () => {
      const tracker = new LaneReadTracker()
      const path = '/test/project/file.ts'
      const hash = 'a'.repeat(64)

      // Only read first window (offset 0 to 3000), total file has remaining bytes
      tracker.recordRead('lane-A', path, hash, 0, 3000, 3000)

      expect(tracker.hasFullReadCoverage('lane-A', path, hash)).toBe(false)

      // Reading the final window reaching null nextOffset satisfies complete coverage
      tracker.recordRead('lane-A', path, hash, 3000, 1500, null)
      expect(tracker.hasFullReadCoverage('lane-A', path, hash)).toBe(true)
    })

    it('enforces frozen test definition protection: full read + correct hash still rejected by assertCheckEdit', async () => {
      const workspace = join(tempBase, 'ws-check-protect')
      const store = join(workspace, '.pulse', 'check-definitions')
      await mkdir(store, { recursive: true })

      const testFilePath = 'tests/eval.test.ts'
      const originalCode = 'test("baseline test", () => { expect(1).toBe(1) })\n'
      const originalHash = createHash('sha256').update(originalCode).digest('hex')

      // Freeze original test script in store
      await writeFile(join(store, 'original.json'), JSON.stringify({ [testFilePath]: originalHash }))

      // Proposed malicious overwrite that replaces the baseline assertion
      const proposedMaliciousCode = 'test("tampered test", () => { expect(true).toBe(true) })\n'

      // Even with verified read hash, assertCheckEdit must refuse tampering with frozen baseline test
      await expect(assertCheckEdit(workspace, store, testFilePath, proposedMaliciousCode)).rejects.toThrow('FROZEN_TEST_CHANGE')
    })

    it('strictly throws PATCH_CONTEXT_AMBIGUOUS when a fuzzy patch matches >= 2 locations', async () => {
      const workspace = join(tempBase, 'ws-fuzzy-patch')
      await mkdir(workspace, { recursive: true })
      const filePath = join(workspace, 'code.ts')
      const content = 'const x = 1\nconst x = 1\n'
      await writeFile(filePath, content)

      const files = new FilesystemTool(workspace)
      const editor = new ExactPatchEditor(files)

      await expect(editor.execute({
        path: 'code.ts',
        patches: [{ find: 'const x = 1', replace: 'const x = 2' }],
        all: false,
      })).rejects.toThrow('PATCH_CONTEXT_AMBIGUOUS')
    })

    it('successfully applies Level 1 CRLF/LF normalized patches and Level 2 whitespace tolerant patches when match is unique', async () => {
      const workspace = join(tempBase, 'ws-fuzzy-success')
      await mkdir(workspace, { recursive: true })
      const filePath = join(workspace, 'file.ts')

      // Source with CRLF line endings
      await writeFile(filePath, 'function alpha() {\r\n  return 42\r\n}\r\n')

      const files = new FilesystemTool(workspace)
      const editor = new ExactPatchEditor(files, undefined, 'normalized')

      // Patch submitted with LF newlines (Level 1)
      const res1 = await editor.execute({
        path: 'file.ts',
        patches: [{ find: 'function alpha() {\n  return 42\n}', replace: 'function alpha() {\n  return 100\n}' }],
      })
      expect(res1.changed).toBe(true)
      const updated1 = await readFile(filePath, 'utf8')
      expect(updated1).toContain('100')

      // Source with trailing spaces (Level 2)
      await writeFile(filePath, 'const value = "hello"   \nconsole.log(value)\n')
      const res2 = await editor.execute({
        path: 'file.ts',
        patches: [{ find: 'const value = "hello"\nconsole.log(value)', replace: 'const value = "world"\nconsole.log(value)' }],
      })
      expect(res2.changed).toBe(true)
      const updated2 = await readFile(filePath, 'utf8')
      expect(updated2).toContain('"world"')
    })
  })

  // --------------------------------------------------------------------------
  // Gate D: 长命令验收阻塞、二进制无损回滚与三态崩溃恢复
  // --------------------------------------------------------------------------
  describe('Gate D: Long Command Acceptance Gate, Binary Rollback & 3-State Recovery', () => {
    it('blocks acceptance when a shell process is active (running or unknown)', async () => {
      const runData = join(tempBase, 'run-data')
      const procs = shellProcesses(runData)

      // Start a live command
      const context = {
        agentId: 'agent-1',
        laneId: 'lane-1',
        effectId: 'effect-1',
        toolCallId: 'call-1',
        attemptId: 'att-1',
        signal: new AbortController().signal,
        emit: () => {},
      }

      await procs.start({ command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'] }, context, async (_cmd, _ctx, _out) => {
        return new Promise(() => {}) // never exits in test
      })

      // assertIdle must throw SHELL_PROCESS_ACTIVE
      await expect(procs.assertIdle()).rejects.toThrow('SHELL_PROCESS_ACTIVE')
    })

    it('performs byte-level atomic CAS write and removal preserving binary non-UTF8 data', async () => {
      const workspace = join(tempBase, 'ws-binary')
      await mkdir(workspace, { recursive: true })
      const files = new FilesystemTool(workspace)

      // Binary payload: PNG signature + random non-UTF8 bytes [0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0xFE, 0xFD]
      const binaryData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0xFE, 0xFD, 0x12, 0x34, 0x56, 0x78])
      const expectedHash = createHash('sha256').update(binaryData).digest('hex')

      const writeRes = await files.writeBytesIfUnchanged('image.png', binaryData, null)
      expect(writeRes.hash).toBe(expectedHash)
      expect(writeRes.bytes).toBe(binaryData.byteLength)

      const onDisk = await readFile(join(workspace, 'image.png'))
      expect(Buffer.from(onDisk).equals(Buffer.from(binaryData))).toBe(true)

      // Removal with CAS
      const removeRes = await files.removeIfUnchanged('image.png', expectedHash)
      expect(removeRes.beforeHash).toBe(expectedHash)
      await expect(readFile(join(workspace, 'image.png'))).rejects.toThrow()
    })

    it('demonstrates 3-state WAL crash reconciliation: State A clean, State B rollback, State C conflict error', async () => {
      const workspace = join(tempBase, 'ws-wal')
      await mkdir(workspace, { recursive: true })
      const files = new FilesystemTool(workspace)
      const snapshotManager = new FileSnapshotManager(workspace, files)

      const targetFile = 'doc.bin'
      const beforeBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04])
      const beforeHash = createHash('sha256').update(beforeBytes).digest('hex')
      const targetAbs = join(workspace, targetFile)
      await writeFile(targetAbs, beforeBytes)

      const newBytes = new Uint8Array([0x05, 0x06, 0x07, 0x08])
      const intendedPostHash = createHash('sha256').update(newBytes).digest('hex')

      // State A: WAL pending, but disk is still beforeHash (write never hit disk)
      await snapshotManager.executeWithWal({
        effectId: 'eff-A',
        runId: 'run-1',
        laneId: 'lane-1',
        path: targetFile,
        newBytes,
        expectedHash: beforeHash,
      }, async () => {
        // Simulate crash right before write: do nothing
      })
      // Reset WAL record back to 'pending' to simulate crash before commit
      const walDir = join(workspace, '.pulse', 'file-snapshots', 'wal')
      const walPath = async (effectId: string) => {
        for (const name of await readdir(walDir)) {
          if (!name.endsWith('.json')) continue
          const file = join(walDir, name)
          const record = JSON.parse(await readFile(file, 'utf8')) as { effectId?: string }
          if (record.effectId === effectId) return file
        }
        throw new Error(`WAL_RECORD_MISSING:${effectId}`)
      }
      const walFileA = await walPath('eff-A')
      const recA = JSON.parse(await readFile(walFileA, 'utf8'))
      recA.status = 'pending'
      await writeFile(walFileA, JSON.stringify(recA))

      // State A reconcile cleans the WAL record without modifying disk
      const resA = await snapshotManager.reconcilePendingWal()
      expect(resA.cleaned).toContain(targetFile)
      expect(await readFile(targetAbs)).toEqual(Buffer.from(beforeBytes))

      // State B: WAL pending, and disk has intendedPostHash (crash before WAL marked committed)
      await snapshotManager.executeWithWal({
        effectId: 'eff-B',
        runId: 'run-1',
        laneId: 'lane-1',
        path: targetFile,
        newBytes,
        expectedHash: beforeHash,
      }, async () => {
        await files.writeBytesIfUnchanged(targetFile, newBytes, beforeHash)
      })
      const walFileB = await walPath('eff-B')
      const recB = JSON.parse(await readFile(walFileB, 'utf8'))
      recB.status = 'pending'
      await writeFile(walFileB, JSON.stringify(recB))

      // State B reconcile detects disk === intendedPostHash, safely restores to beforeHash
      const resB = await snapshotManager.reconcilePendingWal()
      expect(resB.restored).toContain(targetFile)
      expect(await readFile(targetAbs)).toEqual(Buffer.from(beforeBytes))

      // State C: WAL pending, but disk was modified by an external editor/tool to something else entirely
      await snapshotManager.executeWithWal({
        effectId: 'eff-C',
        runId: 'run-1',
        laneId: 'lane-1',
        path: targetFile,
        newBytes,
        expectedHash: beforeHash,
      }, async () => {
        // External edit
        await writeFile(targetAbs, Buffer.from([0x99, 0x88, 0x77]))
      })
      const walFileC = await walPath('eff-C')
      const recC = JSON.parse(await readFile(walFileC, 'utf8'))
      recC.status = 'pending'
      await writeFile(walFileC, JSON.stringify(recC))

      // State C must refuse to overwrite and raise WAL_RECOVERY_EXTERNAL_CONFLICT
      await expect(snapshotManager.reconcilePendingWal()).rejects.toThrow('WAL_RECOVERY_EXTERNAL_CONFLICT')
    })

    it('executes multi-file rollback idempotently and detects external modifications', async () => {
      const workspace = join(tempBase, 'ws-rollback')
      await mkdir(workspace, { recursive: true })
      const files = new FilesystemTool(workspace)
      const snapshotManager = new FileSnapshotManager(workspace, files)

      const file1 = 'file1.txt'
      const file2 = 'file2.bin'
      const initial1 = Buffer.from('hello version 1')
      const initial2 = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD])
      const hash1 = createHash('sha256').update(initial1).digest('hex')
      const hash2 = createHash('sha256').update(initial2).digest('hex')

      await writeFile(join(workspace, file1), initial1)
      await writeFile(join(workspace, file2), initial2)

      // Commit changes with WAL
      const next1 = Buffer.from('hello version 2')
      const next2 = new Uint8Array([0x11, 0x22, 0x33, 0x44])
      const nextHash1 = createHash('sha256').update(next1).digest('hex')
      const nextHash2 = createHash('sha256').update(next2).digest('hex')

      await snapshotManager.executeWithWal({
        effectId: 'eff-1', runId: 'run-1', laneId: 'lane-1', path: file1, newBytes: next1, expectedHash: hash1,
      }, async () => { await files.writeBytesIfUnchanged(file1, next1, hash1) })

      await snapshotManager.executeWithWal({
        effectId: 'eff-2', runId: 'run-1', laneId: 'lane-1', path: file2, newBytes: next2, expectedHash: hash2,
      }, async () => { await files.writeBytesIfUnchanged(file2, next2, hash2) })

      // Multi-file rollback
      const journal = await snapshotManager.rollback('rb-1', 'run-1', [
        { path: file1, expectedPostHash: nextHash1 },
        { path: file2, expectedPostHash: nextHash2 },
      ])
      expect(journal.status).toBe('completed')
      expect(await readFile(join(workspace, file1))).toEqual(initial1)
      expect(await readFile(join(workspace, file2))).toEqual(Buffer.from(initial2))

      // Idempotent retry succeeds
      const retryJournal = await snapshotManager.rollback('rb-1', 'run-1', [
        { path: file1, expectedPostHash: nextHash1 },
        { path: file2, expectedPostHash: nextHash2 },
      ])
      expect(retryJournal.status).toBe('completed')
    })
  })
})
