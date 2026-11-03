import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime, contentHash, defineLaneProgram, type EffectExecutor } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { LocalHost } from '@hunterzhu/pulse-server'

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_MODEL_OR_NETWORK_REQUEST')) })
const directories: string[] = []
const sessions: ReturnType<PulseRuntime['start']>[] = []
const executions = new Set<Promise<unknown>>()
afterEach(async () => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled() }
  finally {
    try {
      await Promise.all(sessions.splice(0).map(async session => { await session.cancel('fixture cleanup'); await session.outcome() }))
      await Promise.allSettled([...executions])
    } finally {
      vi.restoreAllMocks()
      await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
    }
  }
})
async function directory() { const p = await mkdtemp(join(tmpdir(), 'pulse-continuous-')); directories.push(p); return p }
const globalState = (r: PulseRuntime): any => { const agent = [...r.state.agents.values()][0]!; return agent.globalVersions.get(agent.latestGlobalVersion) }

async function scenario(options: { rounds: number; version?: '56' | '57'; contextProtocolVersion?: 2; pause?: boolean; summariesInvalid?: number; category?: string }) {
  const dir = await directory(), ledgerPath = join(dir, 'model-budget.json')
  let ledger = await ModelAttemptBudget.open(ledgerPath, 256)
  let runtime: PulseRuntime, reads = 0, writes = 0, summaries = 0, work = 0, reviews = 0
  const began = Date.now(), nativeTiming = process.platform === 'win32' && options.rounds === 100
  let ledgerMs = 0
  const timing = (phase: string) => { if (nativeTiming) console.info('CONTINUOUS_TIMING ' + JSON.stringify({ phase, elapsedMs: Date.now() - began, reads, writes, summaries, work, used: ledger.used, ledgerMs, effects: runtime?.state.effects.size })) }
  const owners = new Set<string>(), calls: string[] = []
  const stage = { id: 'deliver', kind: 'edit', goal: 'Read the required local fixtures and create result.txt', check: 'result.txt contains the requested result', criterionIds: ['result'], dependsOn: [] }
  const program = buildTaskControllerProgram({ ...(options.contextProtocolVersion ? { contextProtocolVersion: options.contextProtocolVersion } : {}), version: options.version ?? '57', system: 'Offline scripted test', toolNames: ['fs.read', 'fs.write', 'ask.choice'], readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 256, modelBudgetView: () => ledger.schedulingView() })
  const execute: EffectExecutor = async effect => {
    calls.push(effect.key ?? '')
    if (calls.length > 350) throw new Error('SIMULATION_EFFECT_LIMIT')
    if (effect.kind === 'tool') {
      const input = effect.input as any
      if (input.name === 'fs.write') { writes++; return { value: { path: 'result.txt', hash: contentHash('delivered'), changed: true } } }
      reads++
      return { value: { path: input.arguments.path, offset: input.arguments.offset ?? 0, nextOffset: null, hash: contentHash(input.arguments.path), content: `${options.category ?? 'source'} ${input.arguments.path} `.repeat(30) } }
    }
    const reserveBegan = Date.now()
    await ledger.reserve(effect.key === '$compact-summary' ? 'compaction' : effect.key.startsWith('verify') ? 'verification' : 'work')
    ledgerMs += Date.now() - reserveBegan
    if (effect.key === '$compact-summary') { summaries++; if (summaries > 200) throw Object.assign(new Error('SUMMARY_LOOP'), { code: 'SUMMARY_LOOP' }); return { value: { text: summaries <= (options.summariesInvalid ?? 0) ? '' : 'Original contract: inspect fixtures and deliver result.txt. Settled reads retained; continue the next unread fixture. Do not repeat writes.', finishReason: 'stop', toolCalls: [] } } }
    if (effect.key.startsWith('plan')) return { value: { tasks: [stage] } }
    const controller = globalState(runtime).taskController, active = controller.tasks.find((t: any) => t.id === controller.activeId)
    if (effect.key.startsWith('progress-review')) { reviews++; return { value: { status: 'ready', evidenceRefs: active.evidenceRefs, note: 'Review checkpoint' } } }
    if (effect.key.startsWith('verify-stage')) { reviews++; return { value: { status: writes ? 'passed' : 'blocked', evidenceRefs: active.evidenceRefs.slice(-4), note: writes ? 'Delivered' : 'Missing deliverable' } } }
    if (effect.key.startsWith('verify-task')) { reviews++; return { value: { criteria: [{ criterionId: 'result', status: writes ? 'passed' : 'not_met', evidenceRefs: controller.tasks[0].evidenceRefs.slice(-4), rationale: writes ? 'Settled output' : 'No output' }] } } }
    owners.add(effect.ownerLaneId); work++
    if (work === 1 || work % 10 === 0) timing('work')
    const call = (name: string, input: any) => ({ value: { text: '', finishReason: 'tool_calls', toolCalls: [{ name, input }] } })
    if (options.pause && reads === 35 && ![...runtime.state.results.values()].some(r => (r.value as any)?.value === 'continue')) return call('ask.choice', { prompt: 'Continue this local fixture?', options: [{ label: 'Continue', value: 'continue' }, { label: 'Stop', value: 'stop' }] })
    if (reads < options.rounds) return call('fs.read', { path: `fixtures/${reads}.txt` })
    if (!writes) return call('fs.write', { path: 'result.txt', content: 'delivered' })
    return { value: { text: 'Delivered result.txt', finishReason: 'stop', toolCalls: [] } }
  }
  const executor: EffectExecutor = (...args) => {
    const pending = Promise.resolve(execute(...args))
    executions.add(pending)
    void pending.finally(() => executions.delete(pending)).catch(() => undefined)
    return pending
  }
  const config = { builtinHumanEffects: true, effectExecutor: executor, historySoftTokens: 5000, historyHardTokens: 200_000 }
  runtime = new PulseRuntime(config)
  const { agentId } = runtime.createAgent({ goal: 'Read local fixtures and deliver result.txt', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'offline', objective: 'Read local fixtures and deliver result.txt', acceptanceCriteria: [{ id: 'result', description: 'Create result.txt after reading the required fixtures' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } })
  const session = runtime.start(agentId)
  sessions.push(session)
  const original = session.outcome()
  if (options.pause) {
    await expect.poll(() => [...runtime.state.effects.values()].find(e => e.kind === 'human' && !e.outcome), { timeout: 60000 }).toBeTruthy()
    const pending = [...runtime.state.effects.values()].find(e => e.kind === 'human' && !e.outcome)!
    timing('export-start')
    const saved = runtime.exportPersistence(), used = ledger.used
    timing('export-finish')
    ledger = await ModelAttemptBudget.open(ledgerPath, 256)
    expect(ledger.used).toBe(used)
    timing('restore-start')
    runtime = new PulseRuntime({ ...config, persistence: saved, programs: [program] })
    timing('restore-finish')
    const resumed = runtime.start(agentId)
    sessions.push(resumed)
    await resumed.reply(pending.id, { value: 'continue' })
    const outcome = await resumed.outcome()
    await session.cancel('simulated process replacement'); await original
    return { runtime, outcome, reads, writes, summaries, work, reviews, owners, calls, used: ledger.used }
  }
  return { runtime, outcome: await original, reads, writes, summaries, work, reviews, owners, calls, get used() { return ledger.used } }
}

it('runs 100 tool rounds across local checkpoints and multiple compactions on one lane', async () => {
  const result = await scenario({ rounds: 100 })
  expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('succeeded')
  expect(globalState(result.runtime).taskOutcome.status).toBe('accepted')
  expect(result.reads).toBe(100); expect(result.writes).toBe(1); expect(result.owners.size).toBe(1)
  expect(result.summaries).toBeGreaterThan(1)
  expect(globalState(result.runtime).taskController.tasks[0]).toMatchObject({ attempts: 1, executionSlices: 6 })
  expect(result.calls.filter(k => k.startsWith('progress-review'))).toHaveLength(0)
  expect(result.used).toBeLessThan(256)
  expect(globalThis.fetch).not.toHaveBeenCalled()
}, 240000)

it('resumes a 100-round chain with the original durable budget and no repeated writes', async () => {
  const result = await scenario({ rounds: 100, pause: true })
  expect(result.outcome.status).toBe('succeeded')
  expect(globalState(result.runtime).taskOutcome.status).toBe('accepted')
  expect(result.reads).toBe(100); expect(result.writes).toBe(1); expect(result.owners.size).toBe(1)
  expect(result.used).toBe(result.calls.filter(k => !k.includes('-tool-')).length)
}, 240000)

it.each([false, true])('keeps protocol 2 stable for 100 rounds and one write (restore=%s)', async pause => {
  const result = await scenario({ rounds: 100, contextProtocolVersion: 2, pause })
  expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('succeeded')
  expect(globalState(result.runtime).taskOutcome.status).toBe('accepted')
  expect(result.reads).toBe(100); expect(result.writes).toBe(1); expect(result.owners.size).toBe(1)
  expect(result.summaries).toBeGreaterThan(1)
  expect(result.used).toBeLessThan(256)
  expect(globalThis.fetch).not.toHaveBeenCalled()
}, 240000)

it.each(['coding', 'research', 'document', 'file-organization', 'browser-fixture', 'multi-tool'])('continues necessary discovery for %s without a progress-review detour', async category => {
  const result = await scenario({ rounds: 20, category })
  expect(globalState(result.runtime).taskOutcome.status).toBe('accepted')
  expect(result.reads).toBe(20); expect(result.writes).toBe(1)
  expect(result.calls.some(k => k.startsWith('progress-review'))).toBe(false)
}, 20000)

it('keeps legacy behavior selectable and records the deterministic comparison', async () => {
  const legacy = await scenario({ rounds: 20, version: '56' }), continuous = await scenario({ rounds: 20 })
  expect(legacy.reads).toBeLessThan(20)
  expect(continuous.reads).toBe(20)
  expect(legacy.calls.some(k => k.startsWith('progress-review')) || legacy.outcome.status !== 'succeeded' || globalState(legacy.runtime).taskOutcome.status !== 'accepted').toBe(true)
  expect(globalState(continuous.runtime).taskOutcome.status).toBe('accepted')
  expect(continuous.calls.filter(k => k.startsWith('progress-review')).length).toBe(0)
  console.info('MOCK_COMPARISON ' + JSON.stringify({ workload: '20 distinct fixture reads then one write', legacy: { reads: legacy.reads, writes: legacy.writes, reviews: legacy.reviews, modelCalls: legacy.used, acceptance: globalState(legacy.runtime).taskOutcome.status }, continuous: { reads: continuous.reads, writes: continuous.writes, reviews: continuous.reviews, modelCalls: continuous.used, acceptance: globalState(continuous.runtime).taskOutcome.status }, realApiCalls: 0 }))
}, 20000)

it('repairs an invalid summary twice without accepting or executing its proposals', async () => {
  const result = await scenario({ rounds: 30, summariesInvalid: 2 })
  expect(globalState(result.runtime).taskOutcome.status).toBe('accepted')
  expect(result.runtime.state.events.filter(e => e.type === 'lane.trace' && JSON.stringify(e.data).includes('context.compaction_retry')).length).toBeLessThanOrEqual(2)
  expect(result.writes).toBe(1)
}, 20000)

it('gives repeated unchanged tools one 4-round recovery window and stops by eight repeats', async () => {
  let calls = 0
  const program = defineLaneProgram({ id: 'stall', version: '1' }, b => b.addReActLoopStep('work', {
    instruction: 'Use settled evidence', maxTurns: 40, continuousExecution: true, onFinish: () => ({ complete: {} }),
  }))
  const runtime = new PulseRuntime({ effectExecutor: async e => e.kind === 'tool' ? { value: { path: 'same', offset: 0, hash: 'unchanged', content: 'same' } } : (calls++, { value: { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'same' } }] } }) })
  expect(await runtime.start(runtime.createAgent('inspect', program).agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
  expect(calls).toBe(9)
})

it('persists the explicit Host policy with mock configuration and keeps legacy as default', async () => {
  const dir = await directory()
  const host = new LocalHost({ cwd: dir, dataDir: join(dir, 'data'), taskController: true, taskControllerPolicy: 'continuous', approvalMode: 'auto', provider: { provider: 'mock' }, jarvis: { enabled: false } })
  await host.init()
  const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Say hello' })
  await run.outcome()
  const input = JSON.parse(await readFile(join(dir, 'data', 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
  expect(input).toMatchObject({ controllerVersion: '57', taskControllerPolicy: 'continuous', provider: 'mock' })
  await host.close()
  expect(buildTaskControllerProgram({ system: '', toolNames: [], approvalMode: 'auto', maxTurns: 10 }).version).toBe('56')
  expect(() => new LocalHost({ taskControllerPolicy: 'invalid' as any })).toThrow('INVALID_TASK_CONTROLLER_POLICY')
})
