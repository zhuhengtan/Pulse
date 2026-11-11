import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { verificationDemand } from '../packages/server/src/task-controller/efficiency.js'
import { initialController } from '../packages/server/src/task-controller/state.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { summarizeShellProcess } from '../packages/server/src/shell-processes.js'
import { verificationFingerprint, reusableVerification } from '../packages/server/src/task-controller/verification-reuse.js'

const roots: string[] = []
async function temp() { const root = await mkdtemp(join(tmpdir(), 'pulse-efficiency-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(['56', '57'] as const)('v%s waits beyond two output wakeups, keeps its cursor and absolute deadline', version => {
  const program = buildTaskControllerProgram({ version, executionEfficiencyVersion: 1, system: 'test', toolNames: ['shell.start', 'shell.poll'], approvalMode: 'auto', maxTurns: 32 })
  const state = initialController(32)
  state.activeId = 'check'; state.tasks = [{ id: 'check', kind: 'verify', goal: 'Check existing output', check: 'Check succeeds', criterionIds: ['c'], dependsOn: [], status: 'verifying', attempts: 1, evidenceRefs: ['result-1'] }]
  const runtime = new PulseRuntime(), { laneId, agentId } = runtime.createAgent({ goal: 'Check output', program, initialGlobal: { taskController: state } as any })
  const lane = runtime.state.lanes.get(laneId)!, processId = 'a'.repeat(64)
  lane.resume.step = 'verify-stage'; lane.resume.locals = { shellSettleRound: 9 }
  lane.visibleResultRefs!.add('result-1')
  runtime.state.effects.set('e', { id: 'e', agentId, ownerLaneId: laneId, kind: 'tool', input: { name: 'shell.start' }, outcome: { status: 'succeeded', resultRef: 'result-1' } } as any)
  const body = { processId, agentId, laneId, status: 'running', startedAt: 1000, command: { timeoutMs: 300_000 }, offset: 90, nextOffset: 100, output: 'still alive' }
  runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', producer: { kind: 'effect', id: 'e' }, derivedFrom: [], summary: summarizeShellProcess(body) } as any)
  const first = program.step({ lane, state: runtime.state, now: 90_000 })
  expect(first.next.step).toBe('shell-settle:collect')
  expect(first.actions[0]).toMatchObject({ type: 'submit_effects', effects: [{ input: { name: 'shell.poll', arguments: { processId, offset: 101 } } }] })
  expect((first.next.locals as any).shellWaitDeadlines[processId]).toBe(301_000)
  lane.resume.locals = first.next.locals
  const restored = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program] })
  const savedLane = restored.state.lanes.get(laneId)!
  const expired = program.step({ lane: savedLane, state: restored.state, now: 301_000 })
  expect(expired.next.step).toBe('dispatch')
  expect(expired.actions).toEqual([])
  expect(JSON.stringify(expired.contextDelta)).toContain('SHELL_STILL_RUNNING')
})

it('reserves all remaining research batches, preserves consumption on restore, and releases disabled review', async () => {
  const state = initialController(32)
  state.tasks = [{ id: 'a', goal: 'research', check: 'sources', criterionIds: ['c'], dependsOn: [], status: 'passed', attempts: 1, evidenceRefs: [] }]
  state.sourceClaimAudit = { schemaVersion: 1, targets: Array.from({ length: 17 }, (_, i) => ({ id: String(i), text: 'claim', deliveryRef: 'r' })), offset: 0, assessments: [], correctionRounds: 0 }
  const demand = verificationDemand(state, 'verify-claims', true, false, true)
  expect(demand.calls).toBe(4)
  const path = join(await temp(), 'budget.json'), budget = await ModelAttemptBudget.open(path, 6)
  await budget.setVerificationDemand(demand)
  await budget.reserve('work'); await budget.reserve('work')
  expect(budget.schedulingView().workAllowed).toBe(false)
  await expect(budget.reserve('work')).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  const restored = await ModelAttemptBudget.open(path, 99)
  expect(restored.limit).toBe(6); expect(restored.used).toBe(2)
  await restored.reserve('claim-verification')
  await restored.setVerificationDemand(verificationDemand(state, 'work', true, false, false))
  expect(restored.schedulingView().workAllowed).toBe(true)
})

it('does not recreate the shared correction reserve when a later controller drops its error', async () => {
  const path = join(await temp(), 'budget.json'), budget = await ModelAttemptBudget.open(path, 8)
  await budget.setVerificationDemand({ calls: 3, reason: 'correction', repairUsed: true })
  await budget.setVerificationDemand({ calls: 4, reason: 'next-stage', repairUsed: false })
  expect(JSON.parse(await readFile(path, 'utf8')).verificationDemand).toMatchObject({ calls: 3, repairUsed: true })
})

it('counts purpose usage once per receipt across restoration', async () => {
  const path = join(await temp(), 'budget.json'), budget = await ModelAttemptBudget.open(path, 8)
  await budget.reserve('claim-verification')
  await budget.recordUsage({ inputTokens: 12, outputTokens: 3 }, 'receipt', 'claim-verification')
  const restored = await ModelAttemptBudget.read(path)
  await restored.recordUsage({ inputTokens: 12, outputTokens: 3 }, 'receipt', 'claim-verification')
  expect(JSON.parse(await readFile(path, 'utf8')).purposeUsage).toEqual({ 'claim-verification': { inputTokens: 12, outputTokens: 3, reports: 1 } })
  await restored.recordVerificationReuse()
  expect((await ModelAttemptBudget.read(path)).accounting.verificationReuses).toBe(1)
})

it('changing candidate IDs and token accounting cannot replenish an identical stage review', () => {
  const program = buildTaskControllerProgram({ version: '56', executionEfficiencyVersion: 1, reviewExecution: true, system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 32 })
  const state = initialController(32)
  state.activeId = 'a'; state.tasks = [{ id: 'a', goal: 'Explain the result', check: 'Clear explanation', criterionIds: ['c'], dependsOn: [], status: 'verifying', attempts: 1, evidenceRefs: [], candidateRef: 'r1' }]
  const runtime = new PulseRuntime(), { laneId, agentId } = runtime.createAgent({ goal: 'Explain the result', program, initialGlobal: { taskController: state } as any })
  const lane = runtime.state.lanes.get(laneId)!, agent = runtime.state.agents.get(agentId)!
  lane.resume.step = 'verify-stage'
  for (const ref of ['r1', 'r2']) {
    lane.visibleResultRefs!.add(ref)
    runtime.state.effects.set(ref, { id: ref, agentId, ownerLaneId: laneId, kind: 'llm', outcome: { status: 'succeeded', resultRef: ref } } as any)
    runtime.state.results.set(ref, { id: ref, privacy: 'public', producer: { kind: 'effect', id: ref }, derivedFrom: [], value: { text: 'The same explanation', finishReason: 'stop', usage: { inputTokens: ref === 'r1' ? 10 : 20 } } } as any)
  }
  const key = () => (program.step({ lane, state: runtime.state, now: 0 }).actions[0] as any).effects[0].input.requirements.reviewKey
  const first = key()
  state.tasks[0]!.candidateRef = 'r2'
  agent.globalVersions.set(agent.latestGlobalVersion, { taskController: state } as any)
  expect(key()).toBe(first)
  ;(runtime.state.results.get('r2')!.value as any).text = 'A corrected explanation'
  expect(key()).not.toBe(first)
})

it('extends verification reuse to source reviews only when opted in and rejects contradictory findings', () => {
  const runtime = new PulseRuntime()
  const program = buildTaskControllerProgram({ version: '56', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 32 })
  const { laneId } = runtime.createAgent('test', program)
  runtime.state.results.set('r', { id: 'r', value: { text: 'source' }, privacy: 'public' } as any)
  const effect: any = { ownerLaneId: laneId, key: 'verify-sources-llm', input: { inputs: { results: ['r'] }, instruction: 'check' } }
  expect(verificationFingerprint(effect, runtime)).toBeUndefined()
  const original = verificationFingerprint(effect, runtime, true)
  expect(original).toBeTruthy()
  effect.input.inputs.originalObjective = 'changed'
  expect(verificationFingerprint(effect, runtime, true)).not.toBe(original)
  runtime.state.events.push({ type: 'effect.execution_metadata', effectId: 'e', data: { verificationFingerprint: original } } as any)
  runtime.state.effects.set('e', { outcome: { status: 'succeeded', resultRef: 'verdict' } } as any)
  runtime.state.results.set('verdict', { id: 'verdict', privacy: 'public', value: { finishReason: 'stop', structured: { criteria: [{ status: 'passed' }], findings: [{ status: 'contradicted' }] } } } as any)
  expect(reusableVerification(runtime, original!)).toBeUndefined()
})

it.each([true, false])('new Host tasks snapshot efficiency without changing review=%s or controller policy', async review => {
  const root = await temp(), host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), qualityReviewEnabled: review, taskController: false, mockResponse: 'Hello', jarvis: { enabled: false } })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Say hello' })
    for await (const _ of run.events) { /* drain */ }
    await run.outcome()
    const input = JSON.parse(await readFile(join(root, 'data/conversations', c.id, 'runs', run.id, 'input.json'), 'utf8'))
    expect(input).toMatchObject({ executionEfficiencyVersion: 1, qualityReviewEnabled: review })
    expect(input.taskController).toBe(false)
    expect(input.taskControllerPolicy).toBeUndefined()
  } finally { await host.close() }
})

it('keeps the last delivery call available while reserving mandatory acceptance', () => {
  const state = initialController(4)
  state.usedTurns = 1
  state.tasks = [{ id: 'deliver', kind: 'edit', goal: 'Save requested output', check: 'Actual file saved', criterionIds: ['c'], dependsOn: [], status: 'running', attempts: 1, evidenceRefs: [] }]
  expect(verificationDemand(state, 'work', false, false, true).calls).toBe(2)
  state.maxTurns = 5
  expect(verificationDemand(state, 'work', false, false, true).calls).toBe(3)
})
