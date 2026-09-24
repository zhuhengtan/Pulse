import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { textWindow, workspaceStamp, checkpointReceipt, createCheckpoint, validateCheckpoint, operationAudit } from '../packages/server/src/task-controller/checkpoint.js'

const initial = { taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Read source, preserve every requirement', acceptanceCriteria: [{ id: 'criterion-1', description: 'Read source' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } }
const task = { id: 'read', goal: 'Read source', check: 'Evidence from file', criterionIds: ['criterion-1'], dependsOn: [] }
function global(runtime: PulseRuntime): any { const a = [...runtime.state.agents.values()][0]!; return a.globalVersions.get(a.latestGlobalVersion) }

describe('efficient task continuation', () => {
  it('reuses unchanged verified filesystem work with new evidence; invalidates on edits and never caches shell checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-checkpoint-'))
    try {
      execFileSync('git', ['init', '-q', root])
      await writeFile(join(root, 'source.txt'), 'evidence')
      const hash = createHash('sha256').update('evidence').digest('hex')
      let work = 0
      const first = new PulseRuntime({ effectExecutor: async (effect) => {
        if (effect.kind === 'tool') return { value: { path: 'source.txt', content: 'evidence', hash }, summary: { path: 'source.txt', content: 'evidence', hash } }
        if (effect.key?.startsWith('plan')) return { value: { tasks: [task] } }
        const refs = global(first).taskController.tasks[0].evidenceRefs
        if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Actual file evidence' }] } }
        if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Read source' } }
        return { value: ++work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'source.txt' } }] } : { text: 'done', finishReason: 'stop' } }
      } })
      const p = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 16 })
      const { agentId } = first.createAgent({ goal: initial.taskRecord.objective, program: p, initialGlobal: initial })
      expect(await first.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
      const checkpoint = (await createCheckpoint(first, root, 'old-run', global(first)))!
      expect(checkpoint.reusableIds).toEqual(['read'])
      expect(await validateCheckpoint(root, checkpoint, initial.taskRecord.objective)).toBeDefined()
      let models = 0; const toolCalls: string[] = []
      const second = new PulseRuntime({ effectExecutor: async (effect) => {
        if (effect.kind === 'tool') {
          toolCalls.push((effect.input as any).name)
          const receipt = checkpointReceipt(checkpoint)
          return { value: receipt, summary: receipt }
        }
        models++
        expect(effect.key).toMatch(/^verify-task/)
        const refs = global(second).taskController.tasks[0].evidenceRefs
        return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Validated reuse receipt' }] } }
      } })
      const next = buildTaskControllerProgram({ system: 'test', toolNames: ['task.recall','fs.read'], approvalMode: 'auto', maxTurns: 16, resumePlan: checkpoint.controller, reusableIds: checkpoint.reusableIds })
      const nextAgent = second.createAgent({ goal: '继续', program: next, initialGlobal: initial }).agentId
      expect(await second.start(nextAgent).outcome()).toMatchObject({ status: 'succeeded' })
      expect(global(second).taskOutcome.status).toBe('accepted')
      expect(toolCalls).toEqual(['task.recall'])
      expect(models).toBe(1)
      expect(global(second).taskController.usedTurns).toBe(1)
      const chained = await createCheckpoint(second, root, 'second-run', global(second), checkpoint)
      expect(chained?.reusableIds).toEqual(['read'])
      expect(chained?.evidence.read).toEqual(checkpoint.evidence.read)
      expect(checkpointReceipt(checkpoint).stages[0]?.evidence).toContain('evidence')
      await writeFile(join(root, 'source.txt'), 'changed')
      expect(await validateCheckpoint(root, checkpoint, initial.taskRecord.objective)).toBeUndefined()
      expect(await validateCheckpoint(root, checkpoint, 'different goal')).toBeUndefined()
      const tool = [...first.state.effects.values()].find((e) => e.kind === 'tool')!
      ;(tool.input as any).name = 'shell.exec'
      expect((await createCheckpoint(first, root, 'old-run', global(first)))!.reusableIds).toEqual([])
      const audit = operationAudit(first) as any
      expect(audit.operations[0]).toMatchObject({ tool: 'shell.exec', opaqueSideEffects: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('omits bulk implicit context while preserving original constraints and explicit tool evidence', async () => {
    const requests: any[] = []; let work = 0
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') return { value: { text: 'required evidence' } }
      requests.push((effect.input as any).request)
      if (effect.key?.startsWith('plan')) return { value: { tasks: [task] } }
      const refs = global(runtime).taskController.tasks[0].evidenceRefs
      if (effect.key?.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'done' }] } }
      if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'done' } }
      return { value: ++work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: {} }] } : { text: 'done', finishReason: 'stop' } }
    } })
    const program = buildTaskControllerProgram({ system: 'system policy', toolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 16, conversation: [{ role: 'assistant', content: 'Earlier agreed design remains available' }, { role: 'user', content: 'NEVER modify tests' }, { role: 'assistant', content: 'Latest answer' }] })
    const { agentId } = runtime.createAgent({ goal: 'Read source', program, initialGlobal: { ...initial, irrelevant: 'bulk'.repeat(20000) } })
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
    for (const request of requests) {
      expect(request.blocks.find((b: any) => b.kind === 'global').content).toEqual({})
      expect(request.blocks.find((b: any) => b.kind === 'history').content).toEqual([])
      const text = JSON.stringify(request.blocks)
      expect(text).toContain('NEVER modify tests')
      expect(text).toContain('Earlier agreed design remains available')
      expect(text).toContain(initial.taskRecord.objective)
      expect(text).toContain('maxTurns')
      expect(text).toContain('usedTurns')
      expect(text).toContain('priorStages')
      expect(text).not.toContain('bulkbulk')
    }
    expect(JSON.stringify(requests.at(-1))).toContain('required evidence')
  })
})


describe('efficiency safety boundaries', () => {
  it('retrieves every Unicode character without exceeding the inline JSON budget', () => {
    const text = '中文😀\n"\\'.repeat(3000)
    let offset = 0; let restored = ''
    do {
      const page = textWindow(text, offset)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3000)
      expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/)
      restored += page.content
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset
    } while (true)
    expect(restored).toBe(text)
  })
  it('fails closed for malformed checkpoints and oversized evidence', async () => {
    expect(await validateCheckpoint('/missing', {} as any, 'x')).toBeUndefined()
    const receipt = checkpointReceipt({ sourceRunId: 'old', reusableIds: ['read'], controller: { tasks: [{ ...task, note: 'old' }] }, evidence: { read: ['x'.repeat(5000)] } } as any)
    expect(receipt.reusableIds).toEqual([])
    expect(receipt.stages).toEqual([])
  })
  it('does not follow workspace symlinks when creating a reusable stamp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-stamp-'))
    const outside = await mkdtemp(join(tmpdir(), 'pulse-stamp-outside-'))
    try {
      execFileSync('git', ['init', '-q', root])
      // A Windows junction is traversed by Git. Point at a small sibling fixture,
      // not tmpdir() (which includes this repository and creates a traversal loop).
      await writeFile(join(outside, 'private.txt'), 'outside workspace')
      await symlink(outside, join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
      expect((await workspaceStamp(root)).available).toBe(false)
      expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('outside workspace')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
  it('keeps historical conversation retrievable and rejects access from child lanes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-retrieval-'))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), mockResponse: 'ok' })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Remember the original scope' }); await run.outcome()
      const runtime = new PulseRuntime()
      const p = buildTaskControllerProgram({ system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 8 })
      const agentId = runtime.createAgent({ goal: 'test', program: p }).agentId
      const laneId = runtime.state.agents.get(agentId)!.rootLaneId
      const registry = new ToolRegistry()
      ;(host as any).registerTaskInspection(registry, () => runtime, conversation.id, run.id, root)
      const context = { agentId, laneId, toolCallId: 'read-history', effectId: 'e', attemptId: 'a', signal: new AbortController().signal, emit: () => {} }
      const result = await registry.executeDetailed('task.conversation', {}, context)
      expect(JSON.stringify(result.output)).toContain('Remember the original scope')
      await expect(registry.executeDetailed('task.conversation', {}, { ...context, laneId: 'child-lane' })).rejects.toThrow('CONVERSATION_NOT_VISIBLE')
      await expect(registry.executeDetailed('task.recall', {}, { ...context, laneId: 'child-lane' })).rejects.toThrow('CHECKPOINT_NOT_VISIBLE')
      await expect(registry.executeDetailed('task.evidence', { ref: 'unknown' }, context)).rejects.toThrow('RESULT_NOT_VISIBLE')
      runtime.state.lanes.get(laneId)!.context.privacy = 'local_only'
      await expect(registry.executeDetailed('task.history', {}, context)).rejects.toThrow('HISTORY_NOT_VISIBLE')
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })
})


it('reuses passed dependency evidence in later work and verification without repeating its tool', async () => {
  let toolCount = 0; let work = 0; let depSeen = false; let finalReviews = 0
  const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
    if (effect.kind === 'tool') { toolCount++; return { value: { content: 'verified dependency' } } }
    const state = global(runtime).taskController
    if (effect.key?.startsWith('plan')) return { value: { tasks: [task, { ...task, id: 'report', goal: 'Report verified findings', dependsOn: ['read'] }] } }
    const refs = state.tasks[0].evidenceRefs
    if (effect.key?.startsWith('verify-task')) { expect(JSON.stringify((effect.input as any).request)).toContain('Report based on dependency evidence'); return { value: { criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ++finalReviews === 1 ? ['unavailable-history-ref'] : refs, rationale: 'Original evidence retained' }] } } }
    if (effect.key?.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Verified' } }
    if (state.activeId === 'report') {
      expect(JSON.stringify((effect.input as any).request)).toContain('verified dependency'); depSeen = true
      return { value: { text: 'Report based on dependency evidence', finishReason: 'stop' } }
    }
    return { value: ++work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: {} }] } : { text: 'done', finishReason: 'stop' } }
  } })
  const program = buildTaskControllerProgram({ system: 'test', toolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 16 })
  const { agentId } = runtime.createAgent({ goal: initial.taskRecord.objective, program, initialGlobal: initial })
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
  expect(global(runtime).taskOutcome.status).toBe('accepted')
  expect(toolCount).toBe(1); expect(depSeen).toBe(true); expect(finalReviews).toBe(2)
})
