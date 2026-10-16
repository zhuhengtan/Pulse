import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { createAgent, createRuntimeState, defineLaneProgram, PulseRuntime, validateStep, type JsonValue } from '@hunterzhu/pulse-runtime'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import real from './fixtures/lt02-v17-real-regression.json'

afterEach(() => vi.unstubAllGlobals())
const chat = (value: any) => new Response(JSON.stringify({ choices: [{ message: value.tool_calls ? value : { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
const tool = (name: string, args: any) => chat({ content: '', tool_calls: [{ id: 'test-call', function: { name, arguments: JSON.stringify(args) } }] })

const invalidSummaries = [
  ...real.compactions.map(c => ({ label: `actual request ${c.sample}`, value: c })),
  { label: 'blank', value: { text: ' \n ', toolCalls: [], finishReason: 'stop' } },
  { label: 'truncated', value: { text: 'partial summary', toolCalls: [], finishReason: 'length' } },
  { label: 'refusal', value: { text: 'refused', toolCalls: [], finishReason: 'refusal' } },
  { label: 'unparsed DSML', value: { text: '<｜｜DSML｜｜ calls>create file</｜｜DSML｜｜ calls>', toolCalls: [], finishReason: 'stop' } },
]
it.each(invalidSummaries)('rejects $label without compacting history or executing a proposal', async ({ value }) => {
  const calls: string[] = []
  const program = defineLaneProgram({ id: 'compact-guard', version: '1', explicitContext: true, includeLaneHistory: true, toolSet: 'workspace', historyCompaction: { summarizeTask: 'summary', keepRecentRounds: 1 } }, builder => {
    builder.addStep('work', () => ({ actions: [{ type: 'complete', result: { done: true } }], next: 'work' }))
  })
  const runtime = new PulseRuntime({ historySoftTokens: 1, historyHardTokens: 32000, effectExecutor: async effect => {
    calls.push(effect.kind)
    expect(effect.input).toMatchObject({ explicitContext: true, includeLaneHistory: true, tools: { tools: [] } })
    return { value: value as JsonValue }
  } })
  const { agentId, laneId } = runtime.createAgent('Keep original receipts', program)
  const lane = runtime.state.lanes.get(laneId)!
  const history = [{ seq: 1, instruction: 'Saved file receipt', resultRefs: [], output: { path: 'existing.txt' }, privacy: 'public' as const }, { seq: 2, instruction: 'Newer record', resultRefs: [], output: { pending: true }, privacy: 'public' as const }]
  lane.context.history = structuredClone(history)
  lane.historyPressure = { historyTokens: 100, softTokens: 1, hardTokens: 200 }
  expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'HISTORY_COMPACTION_INVALID' } })
  expect(calls).toEqual(['llm'])
  expect(runtime.state.lanes.get(laneId)!.context.history.slice(0, 2)).toEqual(history)
  expect(runtime.state.lanes.get(laneId)!.context.history.some(r => r.instruction === '[history compacted]')).toBe(false)
  const restored = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program] })
  expect(restored.state.lanes.get(laneId)!.context.history.slice(0, 2)).toEqual(history)
  expect(restored.state.lanes.get(laneId)!.failure?.error.code).toBe('HISTORY_COMPACTION_INVALID')
})

it('still accepts a nonempty summary and compacts only its selected prefix', () => {
  const program = defineLaneProgram({ id: 'valid-summary', version: '1', historyCompaction: { summarizeTask: 'summary', keepRecentRounds: 1 } }, builder => { builder.addStep('work', () => ({ actions: [], next: 'work' })) })
  const state = createRuntimeState()
  const { root } = createAgent(state, 'Summarize', { programId: program.id, programVersion: '1', step: '$compact:apply', locals: { $sdk: { compactReturnStep: 'work', compactUpToSeq: 1 } } })
  root.context.history = [{ seq: 1, instruction: 'Old', resultRefs: [], output: {}, privacy: 'public' }, { seq: 2, instruction: 'Keep recent', resultRefs: [], output: {}, privacy: 'public' }]
  state.results.set('summary', { id: 'summary', value: { text: 'Saved receipts retained; implementation pending.', toolCalls: [], finishReason: 'stop' }, privacy: 'public', derivedFrom: [] })
  root.visibleResultRefs!.add('summary')
  const output = program.step({ lane: root, state, now: 0, resumeInput: { type: 'wait', resolution: { waitId: 'w', status: 'satisfied', dependencies: { summary: { state: 'settled', target: { kind: 'effect', id: 'e' }, outcome: { status: 'succeeded', resultRef: 'summary' } } } } } })
  expect(output.contextDelta?.ops).toEqual([{ op: 'compact_history', upToSeq: 1, summaryRef: 'summary' }])
  expect('rejection' in validateStep(state, root.id, output)).toBe(false)
})

it.each([false, true])('reports a denied operation and actual failed assertions with no additional model call (cold=%s)', async cold => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-denied-terminal-'))
  await writeFile(join(dir, 'probe.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('executed.txt','unsafe')")
  const goal = '验证恢复脚本并汇总结果', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let calls = 0, checks = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body)), text = currentRequestText(body.messages)
    if (text.includes('Create an executable plan')) return chat({ tasks: [{ id: 'done', kind: 'analyze', goal: '解释当前恢复设计', check: '给出说明', criterionIds: ids, dependsOn: [] }, { id: 's', kind: 'verify', goal, check: '脚本检查通过', criterionIds: ids, dependsOn: ['done'] }] })
    expect(JSON.stringify(body.tools ?? [])).not.toContain('trusted_check')
    if (text.includes('Verify ONLY the active')) return chat({ status: 'passed', evidenceRefs: suppliedRequestResults(body.messages).map(r => r.id), note: 'STALE_REPORT_NOTE: 后续检查尚未开始' })
    if (text.includes('"activeStage":{"id":"done"')) return chat('EARLY_CANDIDATE_BODY: 后续工作尚未完成')
    return tool('shell_exec', { command: 'node', args: ['probe.mjs'] })
  }))
  const options = { cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible' as const, defaultModel: 'fixture' }, approvalMode: 'auto' as const, taskController: true, jarvis: { enabled: false }, maxModelCalls: 16,
    acceptanceChecks: [{ id: 'resume', description: 'Frozen resume assertions', toolName: 'trusted.check', input: {}, criterionIds: ids, expectedChecks: ['duplicate-summary', 'unknown-price'] }],
    capabilityPacks: [{ manifest: { id: 'trusted', version: '1', kind: 'integration' as const, title: 'trusted', description: 'Independent fixture' }, activate: async () => ({ tools: [defineTool({ name: 'trusted.check', description: 'Host only', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { checks++; return { checks: [{ id: 'duplicate-summary', passed: false }, { id: 'unknown-price', passed: false }] } } })] }) }], enabledCapabilityPacks: ['trusted'] }
  let host = createLocalHost(options)
  try {
    const c = await host.createConversation(); let run = await host.sendMessage(c.id, { text: goal })
    for await (const event of run.events) if (event.type === 'waiting') break
    const pending = await run.pendingInteractions(), originalId = run.id
    if (cold) {
      ;(host as any).active.get(run.id).runtime.cancelAgent = () => {}
      await host.close(); host = createLocalHost(options); run = await host.resumeRun(c.id)
      expect(run.id).toBe(originalId); expect(await run.pendingInteractions()).toEqual(pending)
    }
    expect(calls).toBe(4)
    if (cold) {
      // Reproduce the real budget checkpoint's verify-task continuation after
      // refusal, without spending synthetic provider calls to reach 30/32.
      const runtime: PulseRuntime = (host as any).active.get(run.id).runtime
      const program = runtime.programs.get('pulse.assistant', [...runtime.state.lanes.values()][0]!.resume.programVersion)!, original = program.step
      program.step = ctx => {
        const result = original(ctx)
        if (ctx.lane.resume.step === 'manual-approval:collect' && result.next.step === 'report') result.next.step = 'verify-task'
        return result
      }
    }
    await run.reply(pending[0]!.items[0]!.effectId, { approved: false, reason: 'Owner denied exact operation' })
    const outcome = await run.outcome()
    expect(outcome).toMatchObject({ status: 'succeeded', text: expect.stringContaining('APPROVAL_DENIED') })
    expect(outcome.text).toContain('duplicate-summary'); expect(outcome.text).toContain('unknown-price')
    expect(outcome.text).not.toContain('EARLY_CANDIDATE_BODY'); expect(outcome.text).not.toContain('STALE_REPORT_NOTE')
    const task = await run.taskOutcome()
    expect(task?.status).toBe('incomplete'); expect(task?.criteria.every(c => c.status === 'not_met')).toBe(true)
    expect(calls).toBe(4); expect(checks).toBe(1)
    await expect(readFile(join(dir, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await run.usage()).modelCalls).toBe(4)
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, 20000)

it('keeps settled failed verdicts when a later kernel failure bypasses the report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-saved-verdict-')), goal = '解释恢复方案', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let calls = 0, work = 0, checks = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body)), text = currentRequestText(body.messages), refs = suppliedRequestResults(body.messages).map(r => r.id)
    if (text.includes('Create an executable plan')) return chat({ tasks: [{ id: 's', kind: 'analyze', goal, check: '给出说明', criterionIds: ids, dependsOn: [] }] })
    if (text.includes('Verify ONLY the active')) return chat({ status: 'passed', evidenceRefs: refs, note: 'Description exists' })
    return ++work === 1 ? tool('ask_input', { prompt: 'Hold checkpoint?' }) : chat('Description delivered')
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, jarvis: { enabled: false }, maxModelCalls: 8,
    acceptanceChecks: [{ id: 'frozen', description: 'Actual assertion', toolName: 'trusted.check', input: {}, criterionIds: ids, expectedChecks: ['still-failed'] }], capabilityPacks: [{ manifest: { id: 'trusted', version: '1', kind: 'integration', title: 'trusted', description: 'fixture' }, activate: async () => ({ tools: [defineTool({ name: 'trusted.check', description: 'Host only', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { checks++; return { checks: [{ id: 'still-failed', passed: false, detail: 'Actual failure persists' }] } } })] }) }], enabledCapabilityPacks: ['trusted'] })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: goal })
    for await (const event of run.events) if (event.type === 'waiting') break
    const runtime: PulseRuntime = (host as any).active.get(run.id).runtime
    const program = runtime.programs.get('pulse.assistant', [...runtime.state.lanes.values()][0]!.resume.programVersion)!, original = program.step
    program.step = ctx => {
      const agent = ctx.state.agents.get(ctx.lane.agentId)!, global = agent.globalVersions.get(agent.latestGlobalVersion) as any
      return ctx.lane.resume.step === 'verify-task' && global.taskController?.acceptanceResults?.length
        ? { actions: [{ type: 'fail', error: { code: 'TEST_KERNEL_STOP', message: 'Stop after checks, before report' } }], next: ctx.lane.resume }
        : original(ctx)
    }
    const pending = await run.pendingInteractions(); await run.reply(pending[0]!.items[0]!.effectId, { text: 'Continue' })
    const outcome = await run.outcome()
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'TEST_KERNEL_STOP' } })
    expect(outcome.text).toContain('still-failed'); expect(outcome.text).toContain('独立检查 frozen: failed')
    expect((await run.taskOutcome())?.criteria.every(c => c.status === 'not_met')).toBe(true)
    expect(checks).toBe(1); expect(calls).toBe(4)
    const base = join(dir, 'data/conversations', c.id, 'runs', run.id)
    await expect(readFile(join(base, 'terminal-acceptance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(base, 'task-outcome.json'), 'utf8')).criteria[0]).toMatchObject({ status: 'not_met', evidenceRefs: [expect.any(String)] })
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, 20000)
