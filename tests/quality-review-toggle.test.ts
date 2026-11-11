import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { planReviewRequest } from './helpers/plan-review-provider.js'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'

afterEach(() => vi.unstubAllGlobals())
it('still asks for tool authorization and respects a denial when quality review is off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-no-review-approval-'))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), qualityReviewEnabled: false, taskController: false, approvalMode: 'ask', mockToolCalls: [{ name: 'fs.write', input: { path: 'denied.txt', content: 'no' } }], mockAfterToolResponse: 'Stopped.' })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Create denied.txt' })
    for await (const event of run.events) if (event.type === 'waiting') break
    const pending = await run.pendingInteractions()
    expect(pending[0]?.kind).toBe('approval')
    await expect(readFile(join(root, 'denied.txt'))).rejects.toThrow()
    await run.reply(pending[0]!.items[0]!.effectId, { approved: false })
    for await (const _event of run.events) { /* drain */ }
    await run.outcome()
    await expect(readFile(join(root, 'denied.txt'))).rejects.toThrow()
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
it.each([[true, false], [false, true], [false, undefined], [true, undefined]] as const)('snapshots global=%s and task=%s without claiming skipped review passed', async (global, override) => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-review-toggle-'))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), qualityReviewEnabled: global, taskController: false, mockResponse: 'Hello.', mockTaskAssessments: [{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'Requested greeting exists.' }] }] })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Say hello.', ...(override === undefined ? {} : { qualityReviewEnabled: override }) })
    for await (const _event of run.events) { /* drain */ }
    await run.outcome()
    const dir = join(root, 'data/conversations', conversation.id, 'runs', run.id)
    const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')), saved = JSON.parse(await readFile(join(dir, 'outcome.json'), 'utf8'))
    const enabled = override ?? global
    expect(input.qualityReviewEnabled).toBe(enabled)
    expect(saved.taskOutcome.reviewStatus).toBe(enabled ? 'passed' : 'skipped')
    expect(saved.taskOutcome.status).toBe(enabled ? 'accepted' : 'unverifiable')
    const runtime = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'))
    expect(runtime.state.state.effects.filter(([, e]: any) => e.kind === 'llm')).toHaveLength(enabled ? 2 : 1)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('skips quality models across a cold restore while still requiring explicit plan execution confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-review-toggle-restore-'))
  let turns = 0, qualityCalls = 0
  const reply = (message: object) => Response.json({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body)
    if (planReviewRequest(body) || body.includes('Assess whether the candidate')) { qualityCalls++; throw new Error('Disabled quality model was called') }
    turns++
    const call = turns === 1 ? ['plan_write', { path: 'docs/plans/feature.md', content: '# Plan\nCreate greeting.txt only after user execution confirmation.\n' }]
      : turns === 2 ? ['ask_choice', { prompt: '是否执行已保存方案？', options: [{ label: '暂不执行', value: 'defer' }, { label: '执行', value: 'execute' }] }]
        : turns === 3 ? ['fs_write', { path: 'greeting.txt', content: 'hello' }] : undefined
    return reply(call ? { tool_calls: [{ id: `call-${turns}`, function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { content: 'greeting.txt saved.' })
  }))
  const options = { cwd: root, dataDir: join(root, 'data'), taskController: false, approvalMode: 'auto' as const, provider: { provider: 'openai-compatible' as const, defaultModel: 'fixture', maxContextTokens: 128000 } }
  const first = createLocalHost({ ...options, qualityReviewEnabled: false })
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation(), run = await first.sendMessage(conversation.id, { text: '先把方案写到 docs/plans/feature.md，等我确认后再创建 greeting.txt。' })
    let question: Awaited<ReturnType<typeof run.pendingInteractions>> = []
    for await (const event of run.events) if (event.type === 'waiting') { question = await run.pendingInteractions(); break }
    expect(question).toHaveLength(1)
    expect(qualityCalls).toBe(0)
    await expect(readFile(join(root, 'greeting.txt'))).rejects.toThrow()
    await first.close({ preserveRuns: true })
    second = createLocalHost({ ...options, qualityReviewEnabled: true })
    const resumed = await second.resumeRun(conversation.id)
    expect(await resumed.pendingInteractions()).toEqual(question)
    await resumed.reply(question[0]!.items[0]!.effectId, { value: 'execute' })
    for await (const _event of resumed.events) { /* drain */ }
    await resumed.outcome()
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello')
    expect(qualityCalls).toBe(0)
    const saved = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'outcome.json'), 'utf8'))
    expect(saved.taskOutcome.reviewStatus).toBe('skipped')
    expect(saved.taskOutcome.status).not.toBe('accepted')
  } finally { await first.close(); await second?.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('skips controlled quality effects while retaining actual tool failures (%s)', async failedRead => {
  const program = buildTaskControllerProgram({ reviewExecution: true, qualityReviewEnabled: false, version: '56', system: 'test', toolNames: ['fs.read'], readOnlyToolNames: ['fs.read'], approvalMode: 'auto', maxTurns: 32 })
  let work = 0, reads = 0, quality = 0
  const runtime = new PulseRuntime({ effectExecutor: async effect => {
    if (effect.kind === 'tool') { reads++; if (failedRead) throw Object.assign(new Error('READ_FAILED'), { code: 'READ_FAILED', retryable: false }); return { value: { path: 'source.ts', content: 'actual source' } } }
    if (effect.key.startsWith('plan')) return { value: { tasks: [{ id: 'inspect', kind: 'analyze', goal: 'Read source.ts', check: 'Actual source receipt', criterionIds: ['criterion-1'], dependsOn: [] }] } }
    if (effect.key.startsWith('verify')) { quality++; throw new Error('Disabled verification dispatched') }
    work++
    return { value: work === 1 ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'source.ts' } }] } : { text: 'Source inspected.', finishReason: 'stop' } }
  } })
  const { agentId } = runtime.createAgent({ goal: 'Read source.ts and summarize.', program, initialGlobal: { taskRecord: { schemaVersion: 1, runId: 'test', objective: 'Read source.ts and summarize.', acceptanceCriteria: [{ id: 'criterion-1', description: 'Source inspected' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } } })
  expect((await runtime.start(agentId).outcome()).status).toBe('succeeded')
  const agent = runtime.state.agents.get(agentId)!, global: any = agent.globalVersions.get(agent.latestGlobalVersion)
  expect(reads).toBe(1); expect(quality).toBe(0)
  expect(global.taskController.tasks[0].reviewStatus).toBe('skipped')
  expect(global.taskOutcome.reviewStatus).toBe('skipped')
  expect(global.taskOutcome.status).toBe(failedRead ? 'incomplete' : 'unverifiable')
})
