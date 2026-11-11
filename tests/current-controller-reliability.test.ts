import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime, defineLaneProgram, FileRuntimePersistenceBackend, importRuntimePersistence, type JsonValue } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { initialController, unmetGoalCanChangeApproach, recoverUnmetGoal, controllerFromGlobal } from '../packages/server/src/task-controller/state.js'
import { failureRecord } from '../packages/server/src/task-controller/recovery.js'
import { takeOverCurrentController } from '../packages/server/src/task-controller/takeover.js'
import { projectRunHealth } from '../packages/server/src/run-presentation.js'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const task = () => ({ id: 'deliver', kind: 'edit' as const, goal: 'Deliver the requested module', criterionIds: ['c'], check: 'Original caller checks pass', dependsOn: [], status: 'blocked' as const, attempts: 1, evidenceRefs: ['r1'], note: 'PROVIDER_NETWORK_ERROR: unavailable' })
it.each(['PROVIDER_NETWORK_ERROR', 'EVIDENCE_CHANGED', 'CHECK_FAILED', 'CHECK_ENVIRONMENT_BLOCKED', 'INVALID_TOOL_INPUT', 'OUTPUT_TRUNCATED', 'NATIVE_BROWSER_DISCONNECTED', 'APPROVAL_DENIED', 'REMOTE_UNKNOWN'])('keeps %s available for diagnosis or an authorized alternative', code => {
  const state = initialController(96); state.tasks = [{ ...task(), failure: failureRecord(code, 'Actual failure', ['r1']) }]
  expect(unmetGoalCanChangeApproach(state)).toBe(true)
  recoverUnmetGoal(state)
  expect(state.recoveryAttempts?.[0]?.failures[0]?.code).toBe(code)
  expect(state.updates.at(-1)).toContain('ORIGINAL objective')
  expect(state.priorTasks[0]?.evidenceRefs).toEqual(['r1'])
})
it('continues beyond three recoveries when actual evidence advances, then bounds unchanged attempts', () => {
  const state = initialController(256)
  for (let i = 0; i < 5; i++) {
    state.tasks = [task()]; state.evidenceKeys = [`confirmed-fact-${i}`]
    expect(unmetGoalCanChangeApproach(state)).toBe(true); recoverUnmetGoal(state)
  }
  expect(state.goalRecoveries).toBe(5)
  for (let i = 0; i < 7; i++) { state.tasks = [task()]; expect(unmetGoalCanChangeApproach(state)).toBe(true); recoverUnmetGoal(state) }
  state.tasks = [task()]
  expect(unmetGoalCanChangeApproach(state)).toBe(false)
  expect(state.recoveryAttempts).toHaveLength(12)
})
it('recovers unavailable verification without discarding a passed delivery or failed checks', () => {
  const state = initialController(96)
  state.tasks = [{ ...task(), status: 'passed' }]
  state.finalReviewErrors = ['FINAL_VERIFICATION_UNAVAILABLE: PROVIDER_NETWORK_ERROR']
  state.finalReview = [{ criterionId: 'c', status: 'unverifiable', rationale: 'EVIDENCE_CHANGED', evidenceRefs: ['r1'] }]
  expect(unmetGoalCanChangeApproach(state, { recoverFinalReview: true })).toBe(true)
  recoverUnmetGoal(state, { recoverFinalReview: true })
  expect(state.tasks[0]?.status).toBe('passed')
  expect(state.recoveryCriterionIds).toEqual(['c'])
  expect(state.recoveryAttempts?.[0]?.failures).toHaveLength(2)
  expect(projectRunHealth(state)).toMatchObject({ execution: 'recovering', recoveryAttempts: 1 })
})
it('preserves explicit cancellation and the original cumulative budget as hard boundaries', () => {
  for (const code of ['USER_REQUESTED', 'TASK_MODEL_CALL_BUDGET_EXHAUSTED']) {
    const state = initialController(96); state.tasks = [{ ...task(), failure: failureRecord(code, code) }]
    expect(unmetGoalCanChangeApproach(state)).toBe(false)
  }
  const state = initialController(96); state.tasks = [task()]; state.actualBudget = { limit: 96, used: 96, workAllowed: false, verificationAllowed: false, finalAllowed: false }
  expect(unmetGoalCanChangeApproach(state)).toBe(false)
})
it('keeps verification recovery separate from implementation repair', () => {
  const state = initialController(96)
  const failure = { ...failureRecord('PROVIDER_NETWORK_ERROR', 'Verifier disconnected', ['r1']), phase: 'verification' as const }
  state.tasks = [{ ...task(), failure }]
  recoverUnmetGoal(state)
  expect(state.recoveryMode).toBe('verify')
  expect(state.priorTasks[0]?.evidenceRefs).toEqual(['r1'])
  state.tasks = [{ ...task(), evidenceRefs: ['r2'], failure: failureRecord('CHECK_FAILED', 'Required assertion failed', ['r2']) }]
  recoverUnmetGoal(state)
  expect(state.recoveryMode).toBe('work')
  expect(state.priorTasks.flatMap(task => task.evidenceRefs)).toEqual(['r1', 'r2'])
})
it('clears obsolete failure presentation after successful acceptance', () => {
  const state = initialController(96)
  state.tasks = [{ ...task(), failure: failureRecord('NATIVE_BROWSER_DISCONNECTED', 'Disconnected') }]
  recoverUnmetGoal(state)
  expect(projectRunHealth(state)).toMatchObject({ execution: 'recovering', environment: 'recovering' })
  expect(projectRunHealth(state, 'accepted')).toEqual({ execution: 'finished', acceptance: 'accepted', environment: 'unknown', recoveryAttempts: 1 })
})
it('takes a pending old-controller question into the current engine without replaying its write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-current-takeover-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
  let oldWrites = 0
  const old = defineLaneProgram({ id: 'pulse.assistant', version: '18' }, builder => {
    builder.addStep('start', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'question', kind: 'human', concurrencyClass: 'none', input: { kind: 'ask', prompt: 'Which format?', options: [{ label: 'Text', value: 'text' }] } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'old-answer' }))
    builder.addStep('old-answer', () => { oldWrites++; return { complete: { value: 'old implementation must never run' } } })
  })
  const previous = new PulseRuntime({ builtinHumanEffects: true, recoveryFingerprints: { build: 'old', policy: 'old', tools: {} } })
  cleanups.push(() => previous.shutdown())
  const controller = initialController(64); controller.usedTurns = 7; controller.tasks = [{ ...task(), status: 'running', evidenceRefs: [] }]
  const record: JsonValue = { schemaVersion: 1, runId: 'takeover', objective: 'Deliver the requested module', acceptanceCriteria: [{ id: 'c', description: 'Deliver text' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] }
  const agentId = previous.createAgent({ goal: 'Deliver the requested module', program: old, initialGlobal: { taskRecord: record, taskController: JSON.parse(JSON.stringify(controller)) } }).agentId
  previous.start(agentId)
  await expect.poll(() => [...previous.state.effects.values()].find(effect => effect.kind === 'human')).toBeTruthy()
  await previous.persist(backend)
  const current = buildTaskControllerProgram({ system: 'fixture', toolNames: [], approvalMode: 'auto', maxTurns: 64 })
  const fingerprints = { build: 'new', policy: 'new', tools: {} }
  expect(await takeOverCurrentController(backend, [current], fingerprints, {})).toBe(true)
  const restored = await PulseRuntime.restore(backend, { builtinHumanEffects: true, programs: [current], recoveryFingerprints: fingerprints, effectExecutor: async () => ({ value: null, status: 'failed', error: { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED', message: 'Fixture ends at diagnosis' } }) })
  cleanups.push(() => restored.shutdown())
  const lane = restored.state.lanes.get(restored.state.agents.get(agentId)!.rootLaneId)!
  expect(lane.resume.programVersion).toBe('58')
  expect(lane.context.state).toMatchObject({ taskTakeoverRequired: true })
  const pending = [...restored.state.effects.values()].find(effect => effect.kind === 'human' && !effect.outcome)!
  expect(pending).toBeDefined()
  expect(controllerFromGlobal(restored.state.agents.get(agentId)!.globalVersions.get(0) ?? {})).toMatchObject({ usedTurns: 7 })
  const session = restored.start(agentId)
  await session.reply(pending.id, { value: 'text' })
  await session.outcome()
  expect(oldWrites).toBe(0)
  expect(restored.state.effects.get(pending.id)?.outcome?.status).toBe('succeeded')
})
it('cancels an undispatched obsolete write while preserving its pending human question', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-current-queued-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const backend = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
  const old = defineLaneProgram({ id: 'pulse.assistant', version: '18' }, builder => {
    builder.addStep('start', () => ({ actions: [{ type: 'submit_effects', effects: [
      { key: 'obsolete-write', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.write', arguments: { path: 'output.txt', content: 'old proposal' } } },
      { key: 'pending-question', kind: 'human', concurrencyClass: 'none', input: { kind: 'ask', prompt: 'Which format?' } },
    ], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'old-continuation' }))
  })
  let executions = 0
  const previous = new PulseRuntime({ builtinHumanEffects: true, maxRunning: { tool: 0 }, effectExecutor: async () => { executions++; return { value: {} } } })
  cleanups.push(() => previous.shutdown())
  const { agentId } = previous.createAgent({ goal: 'Retain current work', program: old })
  previous.start(agentId)
  await expect.poll(() => [...previous.state.effects.values()].filter(effect => effect.key === 'obsolete-write').length).toBe(1)
  const queued = [...previous.state.effects.values()].find(effect => effect.key === 'obsolete-write')!
  expect(queued.state).toBe('queued')
  await previous.persist(backend)
  const current = buildTaskControllerProgram({ system: 'fixture', toolNames: [], approvalMode: 'auto', maxTurns: 64 })
  await takeOverCurrentController(backend, [current], { build: 'current', policy: 'current', tools: {} }, {})
  const restored = importRuntimePersistence((await backend.load())!)
  expect(restored.state.effects.get(queued.id)?.outcome).toEqual({ status: 'cancelled', reason: 'CONTROLLER_TAKEOVER_PENDING_OPERATION' })
  expect([...restored.state.effects.values()].find(effect => effect.key === 'pending-question')?.outcome).toBeUndefined()
  const live = await PulseRuntime.restore(backend, { builtinHumanEffects: true, programs: [current], recoveryFingerprints: { build: 'current', policy: 'current', tools: {} } })
  cleanups.push(() => live.shutdown())
  live.tick()
  expect([...live.state.effects.values()].find(effect => effect.key === 'pending-question')?.outcome).toBeUndefined()
  expect(live.state.lanes.get(live.state.agents.get(agentId)!.rootLaneId)?.status).not.toBe('failed')
  expect([...live.state.waits.values()].some(wait => wait.state === 'pending' && wait.spec.mode === 'all')).toBe(true)
  expect(executions).toBe(0)
})
it('uses the original scoped delivery when the planner repeatedly proposes a cyclic dependency graph', async () => {
  let plans = 0, work = 0, writes = 0
  const program = buildTaskControllerProgram({ system: 'fixture', approvalMode: 'auto', toolNames: ['fs.write'], maxTurns: 32 })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') { writes++; return { value: { path: 'output.txt', hash: 'saved-output' } } }
    if (effect.key.startsWith('plan')) { plans++; return { value: { tasks: [{ id: 'invalid', goal: 'Create output.txt', check: 'Requested output saved', criterionIds: ['c'], dependsOn: ['invalid'] }] } } }
    const refs = (effect.input as any).inputs?.results ?? []
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Requested output saved' } }
    if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: refs, rationale: 'Actual requested output' }] } }
    return { value: ++work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'output.txt', content: 'requested' } }] } : { text: 'Saved output.txt.', finishReason: 'stop' } }
  } })
  cleanups.push(() => runtime.shutdown())
  const { agentId } = runtime.createAgent({ goal: 'Create output.txt', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'bad-plan', objective: 'Create output.txt', acceptanceCriteria: [{ id: 'c', description: 'Create output.txt' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } })
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
  const agent = runtime.state.agents.get(agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(global.taskOutcome.status).toBe('accepted')
  expect(plans).toBeGreaterThanOrEqual(1); expect(plans).toBeLessThanOrEqual(3); expect(writes).toBe(1)
  expect(global.taskController.tasks[0].criterionIds).toEqual(['c'])
  expect(global.taskController.tasks[0].id).not.toBe('invalid')
})
it('continues from recorded facts after invalid model summaries without executing their proposed tools', async () => {
  let rounds = 0, summaries = 0, writes = 0
  const program = buildTaskControllerProgram({ system: 'fixture', approvalMode: 'auto', toolNames: ['fs.read', 'fs.write'], maxTurns: 96 })
  const runtime = new PulseRuntime({ historySoftTokens: 1500, historyHardTokens: 20000, effectExecutor: async effect => {
    if (effect.kind === 'tool') { if ((effect.input as any).name === 'fs.write') writes++; return { value: { path: `part-${rounds}.txt`, hash: `part-${rounds}`, content: 'Observed source '.repeat(30) } } }
    if (effect.key.startsWith('$compact')) { summaries++; return { value: { text: 'Unexecuted proposal', finishReason: 'tool_calls', toolCalls: [{ name: 'fs.write', input: { path: 'protected.txt', content: 'must never execute' } }] } } }
    if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: 'inspect', kind: 'analyze', goal: 'Read source pages and report', check: 'Actual source pages read', criterionIds: ['c'], dependsOn: [] }] } }
    const refs = (effect.input as any).inputs?.results ?? []
    if (effect.key.startsWith('verify-stage')) return { value: { status: 'passed', evidenceRefs: refs, note: 'Actual pages inspected' } }
    if (effect.key.startsWith('verify-task')) return { value: { criteria: [{ criterionId: 'c', status: 'passed', evidenceRefs: refs, rationale: 'Source inspection completed' }] } }
    return { value: ++rounds <= 20 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: `part-${rounds}.txt` } }] } : { text: 'Inspected the source pages; protected.txt was preserved.', finishReason: 'stop' } }
  } })
  cleanups.push(() => runtime.shutdown())
  const { agentId } = runtime.createAgent({ goal: 'Read the source pages. Never modify protected.txt.', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'summary-fallback', objective: 'Read the source pages. Never modify protected.txt.', acceptanceCriteria: [{ id: 'c', description: 'Read source pages and report; preserve protected.txt' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } })
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'succeeded' })
  const agent = runtime.state.agents.get(agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(global.taskOutcome.status).toBe('accepted')
  expect(summaries).toBeGreaterThan(0); expect(writes).toBe(0); expect(rounds).toBe(21)
  expect([...runtime.state.lanes.values()].some(lane => lane.context.history.some(record => record.instruction === '[history compacted]' && (record.output as any)?.modelSummaryAvailable === false))).toBe(true)
})
