import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileRuntimePersistenceBackend, QuarantineScope, exportRuntimeCheckpoint, hydrateRuntimeSnapshotBodies, importRuntimePersistence, withRuntimePersistenceIntegrity } from '@hunterzhu/pulse-runtime'
import { createLocalHost } from '../packages/server/src/index.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { failureFromNote, failureRecord } from '../packages/server/src/task-controller/recovery.js'
import { progressFacts } from '../packages/server/src/task-controller/reliability.js'
import { initialController, unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'
import { projectRunHealth } from '../packages/server/src/run-presentation.js'

const task = (id: string, dependsOn: string[] = []) => ({ id, goal: `Implement ${id}`, check: 'Read and verify result', dependsOn, criterionIds: [id.replace('task-', 'criterion-')] })
const initialGlobal = (count: number): JsonValue => ({ taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Complete the checklist', acceptanceCriteria: Array.from({ length: count }, (_, index) => ({ id: `criterion-${index + 1}`, description: `Requirement ${index + 1}` })), status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } })
function globalFor(runtime: PulseRuntime, agentId: string, laneId?: string): any { const agent = runtime.state.agents.get(agentId)!; const global = agent.globalVersions.get(agent.latestGlobalVersion) as any; const chain = laneId ? (runtime.state.lanes.get(laneId)?.context.state as any)?.taskControllerChain : undefined; return chain ? { ...global, taskController: chain } : global }

describe('F5 failure classification', () => {
  it('does not treat business text or context budget as model-call budget', () => {
    expect(failureRecord('CHECK_FAILED', 'Assertion expected BUDGET_REMAINING=2, received 1').recoverable).toBe(true)
    expect(failureRecord('CONTEXT_BUDGET_EXCEEDED', 'context window exceeded').recoverable).toBe(true)
    expect(failureFromNote('CHECK_FAILED: Assertion expected BUDGET_REMAINING=2, received 1').recoverable).toBe(true)
  })
  it('never takes budget stop authority from text quoted inside another failure', () => {
    const quoted = [
      'CHECK_FAILED: assertion expected TASK_MODEL_CALL_BUDGET_EXHAUSTED in test output',
      'CHECK_FAILED: MODEL_BUDGET_CHECKPOINT: expected test message',
      'assertion expected TASK_MODEL_CALL_BUDGET_EXHAUSTED in test output',
      'CHECK_FAILED: STAGE_BUDGET_EXHAUSTED was printed by the fixture',
    ]
    for (const note of quoted) expect(failureFromNote(note), note).toMatchObject({ category: expect.not.stringMatching(/^budget$/), recoverable: true })
    // An explicit foreign identity keeps its own meaning even when its body equals a controller phrase.
    for (const body of ['Total model budget exhausted.', 'MODEL_BUDGET_CHECKPOINT: Work allocation exhausted (3/5).', 'TASK_MODEL_CALL_BUDGET_EXHAUSTED: x']) {
      expect(failureRecord('CHECK_FAILED', body).recoverable, body).toBe(true)
      expect(failureRecord('STAGE_BLOCKED', body).recoverable, body).toBe(true)
    }
  })
  it('keeps controller-authored budget and cancellation stops', () => {
    for (const note of ['TASK_MODEL_CALL_BUDGET_EXHAUSTED: Model call budget exhausted.', 'MODEL_BUDGET_CHECKPOINT: Work allocation exhausted (3/5).', 'Total model budget exhausted.', 'Total model budget exhausted', 'STAGE_BUDGET_EXHAUSTED: no evidence']) expect(failureFromNote(note), note).toMatchObject({ category: 'budget', recoverable: false })
    expect(failureRecord('USER_REQUESTED', 'cancelled')).toMatchObject({ category: 'cancelled', recoverable: false })
    const state = initialController(96)
    state.tasks = [{ id: 'deliver', kind: 'edit', goal: 'Deliver', criterionIds: ['c'], check: 'Check', dependsOn: [], status: 'passed', attempts: 1, evidenceRefs: ['r1'] }]
    state.finalReviewErrors = ['SOURCE_VERIFICATION_UNAVAILABLE: MODEL_BUDGET_CHECKPOINT. Independent factual acceptance was not completed; completed evidence retained.']
    expect(unmetGoalCanChangeApproach(state, { recoverFinalReview: true })).toBe(false)
    state.finalReviewErrors = ['SOURCE_VERIFICATION_UNAVAILABLE: PROVIDER_NETWORK_ERROR. Retain.']
    expect(unmetGoalCanChangeApproach(state, { recoverFinalReview: true })).toBe(true)
  })
  it('real model-call budget stops', () => {
    expect(failureRecord('TASK_MODEL_CALL_BUDGET_EXHAUSTED', 'Model call budget exhausted.').recoverable).toBe(false)
    expect(failureFromNote('Total model budget exhausted.').recoverable).toBe(false)
    expect(failureFromNote('MODEL_BUDGET_CHECKPOINT: Work allocation exhausted (3/5).').recoverable).toBe(false)
  })
})

describe('F4 run health', () => {
  it('a recoverable first failure does not hide a later unrecoverable one', () => {
    const recoverable = failureRecord('CHECK_FAILED', 'tests failed')
    const fatal = failureRecord('TASK_MODEL_CALL_BUDGET_EXHAUSTED', 'Model call budget exhausted.')
    const health = projectRunHealth({ tasks: [{ status: 'blocked', failure: recoverable }, { status: 'blocked', failure: fatal }], goalRecoveries: 0 })
    expect(health.reason).toBe(fatal.code)
  })
})

describe('F6 progress facts', () => {
  const results = (rows: Record<string, { tool: string; body: JsonValue; args?: JsonValue }>) => ({
    results: {
      meta: (ref: string) => rows[ref] ? { effectKind: 'tool', outcomeStatus: 'succeeded', toolName: rows[ref].tool, toolArguments: rows[ref].args ?? {} } : undefined,
      read: (ref: string) => rows[ref]?.body ?? null,
      summary: () => null,
    },
  }) as never
  it('counts real office write receipts and ignores volatile identifiers', () => {
    const ctx = results({
      a: { tool: 'docx.write', body: { path: 'a.docx', hash: 'a'.repeat(64), bytes: 10 } },
      b: { tool: 'docx.write', body: { path: 'a.docx', hash: 'a'.repeat(64), bytes: 10 } },
      c: { tool: 'fs.list', body: { entries: ['x'], receiptId: '1', at: 1 } },
      d: { tool: 'fs.list', body: { entries: ['x'], receiptId: '2', at: 2 } },
    })
    expect(progressFacts(ctx, ['a'])).toHaveLength(1)
    expect(progressFacts(ctx, ['a'])).toEqual(progressFacts(ctx, ['b']))
    expect(progressFacts(ctx, ['c'])).toEqual(progressFacts(ctx, ['d']))
  })
})

afterEach(() => vi.unstubAllGlobals())
const chat = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
const call = (name: string, input: unknown) => chat({ content: '', tool_calls: [{ id: 'operation', function: { name, arguments: JSON.stringify(input) } }] })

describe('F6 real native directory receipts through the Host controller', () => {
  const inventory = async (distinct: boolean) => {
    const cwd = await mkdtemp(join(tmpdir(), 'pulse-progress-list-'))
    for (let i = 1; i <= 13; i++) { await mkdir(join(cwd, `dir-${i}`)); await writeFile(join(cwd, `dir-${i}`, `file-${i}.txt`), `content ${i}`) }
    let work = 0, sawLastListing = false
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
      const refs = suppliedRequestResults(request.messages).map(r => r.id)
      if (text.includes("You write Pulse's final user-facing reply")) return chat('Inventory finished.')
      if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'inventory', kind: 'verify', goal: 'List every directory', check: 'All directories were listed', criterionIds: ['criterion-1'], dependsOn: [] }] }))
      if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Listed.' }))
      if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Listed.' }] }))
      if (JSON.stringify(request.messages).includes('file-13.txt')) sawLastListing = true
      work++
      return work <= 13 ? call('fs_list', { path: distinct ? `dir-${work}` : 'dir-1' }) : chat('Inventory complete.')
    }))
    const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 1000000, maxOutputTokens: 4096 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 60 })
    try {
      const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: 'List every directory.' })
      await run.outcome()
      const dir = join(cwd, 'data/conversations', conv.id, 'runs', run.id)
      const controller = JSON.parse(await readFile(join(dir, 'task-controller.json'), 'utf8'))
      const runtime = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8')).state.state
      const listings = runtime.effects.map((e: any) => e[1]).filter((e: any) => e.input?.name === 'fs.list' && e.outcome?.status === 'succeeded')
      return { controller, listings: listings.length, sawLastListing, outcome: await run.taskOutcome() }
    } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
  }
  it('13 distinct real directories (native fs.list receipts) never reach no-progress', async () => {
    const result = await inventory(true)
    expect(result.listings).toBe(13)
    expect(result.sawLastListing).toBe(true)
    expect(JSON.stringify(result.controller)).not.toContain('NO_PROGRESS')
    expect(result.outcome).toMatchObject({ status: 'accepted' })
  }, 30000)
  it('repeating the same real directory still reaches the no-progress bound', async () => {
    const result = await inventory(false)
    expect(JSON.stringify(result.controller)).toContain('NO_PROGRESS')
    expect(result.outcome).not.toMatchObject({ status: 'accepted' })
  }, 30000)
})

describe('F7 cold Host continuation of a saved controller 57 run', () => {
  it('rebinds to controller 58, keeps requirement, budget, answered approval and landed write, and never repeats the write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pulse-f7-cold-'))
    const objective = 'Create a.txt containing alpha and b.txt containing beta.'
    let work = 0
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
      const refs = suppliedRequestResults(request.messages).map(r => r.id)
      if (text.includes("You write Pulse's final user-facing reply")) return chat('Saved both files.')
      if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'edit', kind: 'edit', goal: objective, check: 'Both files contain their text', criterionIds: ['criterion-1'], dependsOn: [] }] }))
      const has = (name: string) => readFile(join(cwd, name), 'utf8').then(() => true, () => false)
      if (text.includes('Verify ONLY the active')) return chat(JSON.stringify(await has('b.txt') ? { status: 'passed', evidenceRefs: refs, note: 'Both files saved.' } : { status: 'needs_work', evidenceRefs: refs, correctionKind: 'edit', note: 'b.txt is missing.' }))
      if (text.includes('Independently verify')) return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Both files saved.' }] }))
      requests.push(text)
      work++
      // The model reacts to actual disk state, as a real model reading evidence would.
      if (!await has('a.txt')) return call('fs_write', { path: 'a.txt', content: 'alpha' })
      if (!await has('b.txt')) return call('fs_write', { path: 'b.txt', content: 'beta' })
      return chat('Saved.')
    }))
    const options = { cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible' as const, defaultModel: 'fixture', maxContextTokens: 1000000, maxOutputTokens: 4096 }, taskController: true, jarvis: { enabled: false }, approvalMode: 'ask' as const, maxModelCalls: 40 }
    const first = createLocalHost(options)
    let second: ReturnType<typeof createLocalHost> | undefined
    try {
      const conv = await first.createConversation(), run = await first.sendMessage(conv.id, { text: objective })
      const runDir = join(cwd, 'data/conversations', conv.id, 'runs', run.id)
      await vi.waitFor(async () => expect((await run.pendingInteractions()).length).toBe(1), { timeout: 15000 })
      await run.reply((await run.pendingInteractions())[0]!.items[0]!.effectId, { approved: true })
      await vi.waitFor(async () => { expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('alpha'); expect((await run.pendingInteractions()).length).toBe(1) }, { timeout: 15000 })
      const pending = (await run.pendingInteractions())[0]!
      const budgetBefore = JSON.parse(await readFile(join(runDir, 'model-budget.json'), 'utf8'))
      // Persist the pause as the previous release did: input names controller 57 and the lane is bound to program 57.
      await first.close({ preserveRuns: true })
      const input = JSON.parse(await readFile(join(runDir, 'input.json'), 'utf8'))
      expect(input.controllerVersion).toBe('58')
      await writeFile(join(runDir, 'input.json'), JSON.stringify({ ...input, controllerVersion: '57' }, null, 2))
      const backend = new FileRuntimePersistenceBackend(join(runDir, 'runtime.json'))
      const saved = (await backend.load())!
      const hydrated = saved.snapshotBodies === 'external' && backend.snapshotStore ? await hydrateRuntimeSnapshotBodies(saved, backend.snapshotStore) : saved
      const restoredOld = importRuntimePersistence(hydrated)
      let rewritten = 0
      for (const lane of restoredOld.state.lanes.values()) if (lane.resume.programId === 'pulse.assistant' && lane.resume.programVersion === '58') { lane.resume.programVersion = '57'; rewritten++ }
      expect(rewritten).toBeGreaterThan(0)
      const quarantine = new QuarantineScope(); if (restoredOld.quarantine) quarantine.restore(restoredOld.quarantine)
      const checkpoint = exportRuntimeCheckpoint(restoredOld.state, restoredOld.mutationLog, restoredOld.outbox, quarantine, restoredOld.storagePolicy, {}, restoredOld.factInbox, hydrated.compatibility as any)
      await backend.save(withRuntimePersistenceIntegrity({ ...checkpoint,
        ...(saved.resultBodies === 'external' ? { resultBodies: saved.resultBodies, externalResultRefs: saved.externalResultRefs } : {}),
        ...(saved.eventArchive ? { eventArchive: saved.eventArchive } : {}),
      }), saved.integrity?.digest)

      second = createLocalHost(options)
      await second.init()
      const resumed = await second.resumeRun(conv.id)
      const again = await vi.waitFor(async () => { const items = await resumed.pendingInteractions(); expect(items.length).toBe(1); return items[0]! }, { timeout: 15000 })
      expect(again.items[0]!.effectId).toBe(pending.items[0]!.effectId)
      expect(budgetBefore).toMatchObject({ limit: 40 })
      expect(budgetBefore.used).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(join(runDir, 'model-budget.json'), 'utf8'))).toMatchObject({ limit: 40, used: budgetBefore.used })
      let finished = false
      const settled = resumed.outcome().finally(() => { finished = true })
      while (!finished) {
        for (const group of await resumed.pendingInteractions()) for (const item of group.items) await resumed.reply(item.effectId, { approved: true }).catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const outcome = await settled
      const afterLanes = JSON.parse(await readFile(join(runDir, 'runtime.json'), 'utf8'))
      expect(JSON.stringify(afterLanes)).not.toContain('"programVersion":"57"')
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('alpha')
      expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('beta')
      const runtime = afterLanes.state.state
      expect(runtime.effects.map((e: any) => e[1]).filter((e: any) => e.kind === 'human' && e.outcome?.status === 'succeeded').length).toBeGreaterThanOrEqual(2)
      const writes = runtime.effects.map((e: any) => e[1]).filter((e: any) => e.input?.name === 'fs.write')
      expect(writes.filter((e: any) => e.input.arguments?.path === 'a.txt' && e.outcome?.status === 'succeeded')).toHaveLength(1)
      expect(writes.filter((e: any) => e.input.arguments?.path === 'b.txt' && e.outcome?.status === 'succeeded')).toHaveLength(1)
      const controller = JSON.parse(await readFile(join(runDir, 'task-controller.json'), 'utf8'))
      expect(JSON.stringify(controller)).toContain('Create a.txt containing alpha')
      expect(JSON.stringify(controller.tasks)).toContain('Both files contain their text')
      expect(controller.maxTurns).toBe(40)
      const finalBudget = JSON.parse(await readFile(join(runDir, 'model-budget.json'), 'utf8'))
      expect(finalBudget).toMatchObject({ limit: 40 }); expect(finalBudget.used).toBeGreaterThan(budgetBefore.used); expect(finalBudget.used).toBeLessThanOrEqual(40)
      expect(outcome.text ?? '').not.toBe('')
      expect(await resumed.taskOutcome()).toMatchObject({ status: 'accepted' })
    } finally { await second?.close(); await first.close().catch(() => {}); await rm(cwd, { recursive: true, force: true }) }
  }, 60000)
})
