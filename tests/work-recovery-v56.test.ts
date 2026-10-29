import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { initialController } from '../packages/server/src/task-controller/state.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
const chat = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
const call = (name: string, input: unknown) => chat({ content: '', tool_calls: [{ id: 'operation', function: { name, arguments: JSON.stringify(input) } }] })

it('repairs a needs_work citation from a historical run, then executes only the required correction', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-v56-citation-'))
  let work = 0, reviews = 0, repairs = 0
  const objective = 'Create greeting.txt with hello world.'
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (text.includes("You write Pulse's final user-facing reply")) return chat('Saved greeting.txt.')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'edit', kind: 'edit', goal: objective, check: 'File contains hello world', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      reviews++
      if (reviews <= 2) {
        if (text.includes('CITATION_REPAIR:')) repairs++
        return chat(JSON.stringify({ status: 'needs_work', evidenceRefs: reviews === 1 ? ['result-134'] : refs, correctionKind: 'edit', note: 'Append world to the current greeting.' }))
      }
      return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Saved corrected greeting.' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'Current file saved.' }] }))
    work++
    if (work === 1) return call('fs_write', { path: 'greeting.txt', content: 'hello' })
    if (work === 3) return call('fs_apply_patch', { path: 'greeting.txt', find: 'hello', replace: 'hello world' })
    return chat('Saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 24 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: objective })
    await run.outcome()
    expect(await run.taskOutcome()).toMatchObject({ status: 'accepted' })
    expect(repairs).toBe(1); expect(reviews).toBe(3); expect(work).toBe(4)
    expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe('hello world')
    const runtime = JSON.parse(await readFile(join(cwd, 'data/conversations', conv.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state
    const edits = runtime.effects.map((e: any) => e[1]).filter((e: any) => ['fs.write', 'fs.apply_patch'].includes(e.input?.name))
    expect(edits).toHaveLength(2)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

it('retains a concrete failed-check diagnosis and never accepts the failed run', async () => {
  const status = 'unverifiable'
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-v56-failure-'))
  await writeFile(join(cwd, 'broken.test.cjs'), 'require("node:assert/strict").equal(1, 2)\n')
  let work = 0, finalReviews = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    const refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (text.includes("You write Pulse's final user-facing reply")) return chat('The routing check failed with unequal values.')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'check', kind: 'verify', goal: 'Run the existing routing test', check: 'node --test broken.test.cjs', criterionIds: ['criterion-1'], dependsOn: [] }] }))
    if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'blocked', evidenceRefs: refs, note: 'The routing check failed with unequal values.' }))
    if (text.includes('Independently verify every ORIGINAL')) {
      finalReviews++
      return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status, evidenceRefs: refs, rationale: 'The check failed with unequal values.' }] }))
    }
    return ++work === 1 ? call('shell_exec', { command: 'node', args: ['--test', 'broken.test.cjs'] }) : chat('The check failed.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conv = await host.createConversation(), run = await host.sendMessage(conv.id, { text: 'Run the existing routing test and report its result.' })
    const outcome = await run.outcome()
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: 'incomplete' })
    const state = JSON.parse(await readFile(join(cwd, 'data/conversations', conv.id, 'runs', run.id, 'task-controller.json'), 'utf8'))
    expect(finalReviews).toBe(0)
    expect(state.finalReviewErrors?.length ?? 0).toBe(0)
    expect(state.tasks[0].note).toBe('The routing check failed with unequal values.')
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

// Start from the durable checkpoint just before final review. The failed-stage
// receipt is supplied to explain a blocker, but may never establish a pass.
it.each(['unverifiable', 'passed', 'repair'])('uses failed-stage evidence only for a %s final assessment', async status => {
  const controller = initialController(20)
  controller.tasks = [{ id: 'check', kind: 'verify', goal: 'Verify routing', check: 'Run routing test', criterionIds: ['criterion-1'], dependsOn: [], settledDependencies: [], status: 'blocked', attempts: 1, evidenceRefs: ['result-native'], note: 'Routing test failed.' }]
  let reviews = 0
  const program = buildTaskControllerProgram({ version: '56', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 20, modelBudgetView: () => ({ limit: 20, used: 18, workAllowed: false, verificationAllowed: true, finalAllowed: true }) })
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.key?.startsWith('verify-task')) {
      reviews++
      if (status === 'repair' && reviews === 2) {
        const correction = (effect.input as any).inputs.conversation.map((m: any) => { try { return JSON.parse(m.content) } catch { return {} } }).find((m: any) => m.verificationCorrection)
        expect(correction.allowedEvidenceRefs).toContain('result-native')
      }
      return { value: { criteria: [{ criterionId: 'criterion-1', status: status === 'repair' ? 'unverifiable' : status, evidenceRefs: status === 'repair' && reviews === 1 ? ['result-134'] : ['result-native'], rationale: 'Routing test failed.' }] } }
    }
    throw new Error('Unexpected effect ' + effect.key)
  } })
  const { agentId, laneId } = runtime.createAgent({ goal: 'Verify routing', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'fixture', objective: 'Verify routing', acceptanceCriteria: [{ id: 'criterion-1', description: 'Verify routing' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] }, taskController: controller } as any })
  runtime.state.effects.set('effect-native', { id: 'effect-native', agentId, ownerLaneId: laneId, kind: 'tool', input: { name: 'shell.exec', arguments: { command: 'node', args: ['--test', 'routing.test.cjs'] } }, state: 'succeeded', outcome: { status: 'succeeded', resultRef: 'result-native' } } as any)
  runtime.state.results.set('result-native', { id: 'result-native', effectId: 'effect-native', producer: { kind: 'effect', id: 'effect-native' }, privacy: 'public', derivedFrom: [], value: { code: 1, stderr: 'Assertion failed' }, contentHash: 'fixture', storageState: 'memory', sizeBytes: 30, pinCount: 0 } as any)
  const lane = runtime.state.lanes.get(laneId)!
  lane.visibleResultRefs = new Set(['result-native']); lane.resume.step = 'verify-task'
  await runtime.start(agentId).outcome()
  const agent = runtime.state.agents.get(agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
  expect(reviews).toBe(status === 'unverifiable' ? 1 : 2)
  expect(global.taskController.finalReviewErrors?.length ?? 0).toBe(status === 'passed' ? 1 : 0)
  expect(global.taskOutcome.status).not.toBe('accepted')
})
