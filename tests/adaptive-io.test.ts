import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ContextBuilder, defineLaneProgram, hydrateRuntimeResultBodies, type AgentCreateRequest, type PulseRuntime } from '@hunterzhu/pulse-runtime'
import { MockAdapter } from '@hunterzhu/pulse-adapters'
import { FilesystemTool } from '../packages/adapters/src/tools/filesystem.js'
import { adaptiveReadBytes, MAX_READ_BYTES, READ_SUMMARY_BYTES } from '../packages/server/src/adaptive-read.js'
import { FileSnapshotManager } from '../packages/server/src/file-snapshots.js'
import { LocalHost } from '../packages/server/src/index.js'
import { runPersistence } from '../packages/server/src/run-persistence.js'

async function surface(version: 1 | 2 | 3) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-adaptive-io-'))
  const options = { cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' as const, maxContextTokens: 262144 }, approvalMode: 'auto' as const, taskController: false, jarvis: { enabled: false }, mockToolCalls: [{ name: 'fs.read', input: { path: 'large.txt', maxBytes: 200000 } }], mockAfterToolResponse: 'Local page read' }
  const host = new LocalHost(options)
  await host.init()
  const conversation = await host.createConversation()
  const runId = 'io-test'
  const runDir = join(root, 'data/conversations', conversation.id, 'runs', runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'input.json'), JSON.stringify({ fileSurfaceVersion: version }))
  const open = host as unknown as { runtimeFor: (...args: unknown[]) => Promise<{ runtime: PulseRuntime }> }
  const { runtime } = await open.runtimeFor(conversation.id, runId, root, 'read local file', '', options)
  return { root, host, runtime, conversation }
}

const reader = defineLaneProgram({ id: 'adaptive-reader', version: '1' }, builder => {
  builder.addStep('read', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'read', toolCallId: 'read', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.read', arguments: { path: 'large.txt', maxBytes: 200000 }, toolCallId: 'read' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'done' }))
  builder.addStep('done', () => ({ actions: [{ type: 'complete', result: 'read completed' }], next: 'done' }))
})

describe('adaptive production file surface', () => {
  it('persists v3 for real new Host runs without upgrading old runs', async () => {
    const test = await surface(2)
    try {
      await writeFile(join(test.root, 'large.txt'), 'a'.repeat(100000))
      const run = await test.host.sendMessage(test.conversation.id, { text: 'read the local file' })
      expect((await run.outcome()).status).toBe('succeeded')
      const runDir = join(test.root, 'data/conversations', test.conversation.id, 'runs', run.id)
      expect(JSON.parse(await readFile(join(runDir, 'input.json'), 'utf8')).fileSurfaceVersion).toBe(3)
      expect(JSON.parse(await readFile(join(test.root, 'data/conversations', test.conversation.id, 'runs/io-test/input.json'), 'utf8')).fileSurfaceVersion).toBe(2)
      const backend = await runPersistence(runDir)
      const disk = (await backend.load())!
      const snapshot = backend.resultStore ? await hydrateRuntimeResultBodies(disk, backend.resultStore) : disk
      const read = (snapshot.state.state.results.find(([, result]) => (result.value as { path?: string } | undefined)?.path === 'large.txt')?.[1])!
      expect(read).toBeDefined()
      await backend.close?.()
      expect(Buffer.byteLength((read.value as { content: string }).content)).toBeGreaterThan(3000)
      expect((read.summary as { content: string }).content).toBe((read.value as { content: string }).content)
    } finally { await test.host.close(); await rm(test.root, { recursive: true, force: true }) }
  })
  it.each([1, 2, 3] as const)('keeps old v%s windows and exposes the entire v3 window to model projection', async version => {
    const test = await surface(version)
    try {
      const content = ('汉字"\n').repeat(20000)
      await writeFile(join(test.root, 'large.txt'), content)
      const { agentId } = test.runtime.createAgent('read', reader)
      expect((await test.runtime.start(agentId).outcome()).status).toBe('succeeded')
      const result = [...test.runtime.state.results.values()].find(value => (value.value as { path?: string } | undefined)?.path === 'large.txt')!
      expect(result).toBeDefined()
      const value = result.value as { content: string; hash: string; nextOffset: number }
      const bytes = Buffer.byteLength(value.content)
      expect(bytes).toBeLessThanOrEqual(version === 3 ? MAX_READ_BYTES : 3000)
      if (version === 3) {
        expect(bytes).toBeGreaterThan(3000)
        expect(result.summary).toEqual(value)
        expect(test.runtime.state.maxResultSummaryBytes).toBe(READ_SUMMARY_BYTES)
      } else expect(test.runtime.state.maxResultSummaryBytes).toBe(4096)
      expect(value.hash).toBe(createHash('sha256').update(content).digest('hex'))
      expect(value.nextOffset).toBe(bytes)
      expect(value.content).not.toContain('\uFFFD')
      const effect = test.runtime.state.effects.get(result.effectId!)!
      const lane = test.runtime.state.lanes.get(effect.ownerLaneId)!
      const agent = test.runtime.state.agents.get(agentId)!
      const projection = new ContextBuilder(test.runtime.state).build({ agent, lane, resultRefs: [result.id], instruction: 'inspect the visible page', toolSetId: 'io' })
      const projected = projection.blocks.find(block => block.kind === 'results')!.content as unknown as Array<{ value: { content: string } }>
      expect(projected[0]!.value.content).toBe(value.content)
      test.runtime.state.historyHardTokens = 2100
      expect(adaptiveReadBytes(test.runtime, lane.id)).toBe(3072)
      expect(adaptiveReadBytes(test.runtime, lane.id, 17)).toBe(17)
      expect(adaptiveReadBytes(undefined, lane.id)).toBe(3072)
    } finally { await test.host.close(); await rm(test.root, { recursive: true, force: true }) }
  })

  it.each([3, 2] as const)('restored human follow-up preserves only a v3 read window (%i)', async version => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-adaptive-followup-'))
    const options = { cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' as const, maxContextTokens: 262144 }, jarvis: { enabled: false }, taskController: false, approvalMode: 'auto' as const, mockToolCalls: [{ name: 'ask.choice', input: { prompt: 'Hold primary task', options: [{ label: 'Hold', value: 'hold' }] } }] }
    let first: LocalHost | undefined = new LocalHost(options)
    let second: LocalHost | undefined
    try {
      await writeFile(join(root, 'large.txt'), 'x'.repeat(100000))
      const conversation = await first.createConversation()
      const run = await first.sendMessage(conversation.id, { text: 'Hold primary task.' })
      for await (const event of run.events) if (event.type === 'waiting') break
      await first.close({ preserveRuns: true })
      first = undefined
      const inputPath = join(root, 'data/conversations', conversation.id, 'runs', run.id, 'input.json')
      if (version !== 3) {
        const saved = JSON.parse(await readFile(inputPath, 'utf8')) as { fileSurfaceVersion?: number }
        saved.fileSurfaceVersion = version
        await writeFile(inputPath, JSON.stringify(saved))
      }
      second = new LocalHost(options)
      const resumed = await second.resumeRun(conversation.id)
      for await (const event of resumed.events) if (event.type === 'waiting') break
      const runtime = (second as unknown as { active: Map<string, { runtime: PulseRuntime }> }).active.get(resumed.id)!.runtime
      let calls = 0
      vi.spyOn(MockAdapter.prototype, 'executeAttempt').mockImplementation(async () => (++calls === 1
        ? { text: '', toolCalls: [{ toolCallId: 'followup-read', name: 'fs.read', input: { path: 'large.txt', maxBytes: 200000 } }], finishReason: 'tool_calls' as const }
        : { text: 'Read completed', toolCalls: [], finishReason: 'stop' as const }) as Awaited<ReturnType<MockAdapter['executeAttempt']>>)
      const parent = [...runtime.state.agents.values()].find(agent => agent.parentAgentId === undefined)!
      const child = runtime.createAgent({ goal: 'Human followup reads local file.', program: (runtime as unknown as { humanInputProgram: AgentCreateRequest['program'] }).humanInputProgram, parentAgentId: parent.id })
      expect((await runtime.start(child.agentId).outcome()).status).toBe('succeeded')
      const read = [...runtime.state.results.values()].find(result => (result.value as { path?: string } | undefined)?.path === 'large.txt')
      expect(read).toBeDefined()
      const bytes = Buffer.byteLength((read!.value as { content: string }).content)
      expect(JSON.parse(await readFile(inputPath, 'utf8')).fileSurfaceVersion).toBe(version)
      if (version === 3) {
        expect(bytes).toBeGreaterThan(3000)
        expect(bytes).toBeLessThanOrEqual(MAX_READ_BYTES)
      } else expect(bytes).toBe(3000)
    } finally {
      vi.restoreAllMocks()
      await second?.close()
      await first?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})

function owner(effectId = 'effect-1', runId = 'run-1') { return { conversationId: 'conv', runId, effectId, laneId: 'lane', agentId: 'agent' } }

describe('owner-indexed durable WAL settlement', () => {
  it('keeps identities unambiguous, preserves a failed settlement, supports old names and reconstructs after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-wal-index-'))
    try {
      const files = new FilesystemTool(root), manager = new FileSnapshotManager(root, files)
      const a = owner('c', 'a/b'), b = { ...owner('b/c', 'a') }
      for (const [id, path] of [[a, 'a.txt'], [b, 'b.txt']] as const) await manager.beginJournal({ ...id, path, before: Buffer.from('before'), next: Buffer.from('after') })
      const wal = join(root, '.pulse/file-snapshots/wal'), history = join(root, '.pulse/file-snapshots/history')
      expect(await readdir(wal)).toHaveLength(2)
      const failedHistory = vi.spyOn(manager as unknown as { retainHistory: (record: unknown) => Promise<void> }, 'retainHistory').mockRejectedValueOnce(new Error('disk full'))
      await expect(manager.settleConfirmed([a])).rejects.toThrow('disk full')
      expect(await readdir(wal)).toHaveLength(2)
      failedHistory.mockRestore()
      await new FileSnapshotManager(root, files).settleConfirmed([a])
      expect(await readdir(wal)).toHaveLength(1)
      expect(await readdir(history)).toHaveLength(1)
      const legacy = (await readdir(wal))[0]!
      await rename(join(wal, legacy), join(wal, 'old-effect-id.json'))
      await new FileSnapshotManager(root, files).markLanded(b)
      expect(JSON.parse(await readFile(join(wal, 'old-effect-id.json'), 'utf8')).status).toBe('landed')
      await new FileSnapshotManager(root, files).settleConfirmed([b])
      expect(await readdir(wal)).toEqual([])
      expect(await readdir(history)).toHaveLength(2)
      await new FileSnapshotManager(root, files).settleConfirmed([a, b])
      expect(await readdir(history)).toHaveLength(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
