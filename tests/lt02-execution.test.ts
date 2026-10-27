import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { interruptedController, interruptedSummary } from '../packages/server/src/task-controller/terminal.js'
import { validateShellInvocation } from '../packages/adapters/src/tools/shell.js'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'

const chat = (value: any) => new Response(JSON.stringify({ choices: [{ message: value.tool_calls ? value : { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
const tool = (name: string, args: any) => chat({ content: '', tool_calls: [{ id: 'call', function: { name, arguments: JSON.stringify(args) } }] })
afterEach(() => vi.unstubAllGlobals())

it('consults the same durable admission policy without consuming a request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-ledger-view-'))
  try {
    const budget = await ModelAttemptBudget.open(join(dir, 'budget.json'), 32, 30, { verificationReserve: 2 })
    expect(budget.schedulingView()).toMatchObject({ used: 30, workAllowed: false, verificationAllowed: true, finalAllowed: true })
    await expect(budget.reserve('work')).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
    expect(budget.used).toBe(30)
    await budget.reserve('verification')
    expect(budget.schedulingView()).toMatchObject({ verificationAllowed: false, finalAllowed: true })
    await budget.reserve('final-verification')
    expect(budget.schedulingView()).toMatchObject({ used: 32, finalAllowed: false })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('rejects compound shell syntax deterministically before any reviewer', () => {
  expect(() => validateShellInvocation('sh', ['-c', 'grep x file; echo done'])).toThrow('shell.exec does not start a shell')
  expect(() => validateShellInvocation('node && echo secret', [])).toThrow()
  expect(() => validateShellInvocation('node', ['--check', 'file.mjs'])).not.toThrow()
})

it('formats an interrupted controller from current state without stale candidate bodies', () => {
  const state: any = { tasks: [{ id: 's1', goal: 'Create README', status: 'passed', attempts: 1, evidenceRefs: [], candidateRef: 'STALE_README_BODY' }, { id: 's2', goal: 'Run failing check', status: 'running', attempts: 1, evidenceRefs: [] }, { id: 's3', goal: 'Not started', status: 'pending', attempts: 0, evidenceRefs: [] }], activeId: 's2' }
  const terminal = interruptedController(state, 'BUDGET_STOP')
  expect(terminal.tasks[1]!.status).toBe('blocked')
  expect(state.tasks[1].status).toBe('running')
  const text = interruptedSummary('修复项目', terminal, 'BUDGET_STOP')
  expect(text).toContain('首个阻塞: s2')
  expect(text).toContain('s3 Not started')
  expect(text).not.toContain('STALE_README_BODY')
})

it('accounts local approvals and spends reserved calls on verification, with independent checks after failed work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-lt02-budget-'))
  await writeFile(join(dir, 'probe.mjs'), 'process.exitCode = 1')
  await writeFile(join(dir, 'info.txt'), 'x'.repeat(48000))
  const goal = '检查项目并验证脚本，最后更新说明', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let work = 0, primary = 0, reviews = 0, independent = 0
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(String(init?.body)), text = currentRequestText(body.messages)
    if (String(url).includes('127.0.0.1')) { reviews++; return chat('APPROVE') }
    expect(text).not.toContain('You are the Pulse safety reviewer'); primary++
    const refs = suppliedRequestResults(body.messages).map(r => r.id)
    if (text.includes('Create an executable plan')) return chat({ tasks: [{ id: 's1', kind: 'verify', goal: '检查现有脚本', check: '运行脚本检查通过', criterionIds: ids, dependsOn: [] }, { id: 's2', kind: 'analyze', goal: '总结检查', check: '说明完整', criterionIds: ids, dependsOn: ['s1'] }] })
    if (text.includes('Verify ONLY the active')) return chat({ status: 'needs_work', correctionKind: 'verify', evidenceRefs: refs, note: 'Probe exited 1; failure remains failed' })
    if (text.includes('Independently verify every ORIGINAL')) return chat({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'optimistic model' })) })
    return ++work === 1 ? tool('shell_exec', { command: 'node', args: ['probe.mjs'] }) : tool('fs_read', { path: 'info.txt', offset: (work - 2) * 3000 })
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', baseURL: 'https://fixture.invalid', defaultModel: 'fixture', maxContextTokens: 256000 }, approvalReview: { provider: 'ollama', model: 'local-review', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30000 }, approvalMode: 'auto', taskController: true, maxModelCalls: 16, jarvis: { enabled: false }, acceptanceChecks: [{ id: 'independent', description: 'Actual independent assertion', toolName: 'trusted.check', input: {}, criterionIds: ids, expectedChecks: ['real-check'] }], capabilityPacks: [{ manifest: { id: 'trusted', version: '1', kind: 'integration', title: 'trusted', description: 'local assertion' }, activate: async () => ({ tools: [defineTool({ name: 'trusted.check', description: 'independent', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { independent++; return { checks: [{ id: 'real-check', passed: false, detail: 'actual failure' }] } } })] }) }], enabledCapabilityPacks: ['trusted'] })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: goal }), outcome = await run.outcome()
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded')
    expect((await run.taskOutcome())?.status).toBe('incomplete')
    expect(independent).toBe(1); expect(reviews).toBe(1)
    expect(primary + reviews).toBe(16)
    const base = join(dir, 'data/conversations', c.id, 'runs', run.id)
    const state = JSON.parse(await readFile(join(base, 'task-controller.json'), 'utf8'))
    expect(state.budgetStopped).toContain('MODEL_BUDGET_CHECKPOINT')
    expect(state.tasks.map((s: any) => s.status)).toEqual(['blocked', 'blocked'])
    expect(state.tasks[0].attempts).toBe(1)
    expect(state.acceptanceResults[0].status).toBe('failed')
    expect((await run.usage()).budget).toMatchObject({ used: 16, purposes: { approval: 1, verification: 1, 'final-verification': 1 } })
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 180_000 : 60_000)

it('runs frozen independent checks after abnormal termination without retrying execution or fabricating refs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-terminal-assertion-'))
  const goal = '验证当前项目', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let calls = 0, independent = 0, requestsAtCheck = 0, summaries = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (String(init?.body).includes("You write Pulse's final user-facing reply")) { summaries++; return chat('任务未完成，独立检查发现实际缺陷。') }
    if (++calls === 1) return chat({ tasks: [{ id: 's', kind: 'verify', goal, check: '行为正确', criterionIds: ids, dependsOn: [] }] })
    return tool('trusted_crash', {})
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, maxModelCalls: 8, jarvis: { enabled: false }, acceptanceChecks: [{ id: 'offline', description: 'Frozen offline assertion', toolName: 'trusted.offline', input: {}, criterionIds: ids, expectedChecks: ['required'] }], capabilityPacks: [{ manifest: { id: 'trusted', version: '1', kind: 'integration', title: 'trusted', description: 'local assertion' }, activate: async () => ({ tools: [defineTool({ name: 'trusted.crash', description: 'Controlled runtime interruption', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { throw Object.assign(new Error('Simulated cleanup interruption'), { code: 'SANDBOX_CLEANUP_FAILED' }) } }), defineTool({ name: 'trusted.offline', description: 'Actual assertion', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { independent++; requestsAtCheck = calls; return { checks: [{ id: 'required', passed: false, detail: 'actual defect' }] } } })] }) }], enabledCapabilityPacks: ['trusted'] })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: goal }), outcome = await run.outcome()
    expect(outcome.status).toBe('failed')
    expect(independent).toBe(1); expect(calls).toBe(requestsAtCheck)
    expect(summaries).toBe(1)
    expect(outcome.text).toContain('actual defect')
    expect(outcome.text).not.toContain('首个阻塞: s')
    expect((await run.taskOutcome())?.criteria.every(c => c.status === 'not_met')).toBe(true)
    const base = join(dir, 'data/conversations', c.id, 'runs', run.id)
    expect(JSON.parse(await readFile(join(base, 'completion-report.json'), 'utf8')).text).toContain('独立检查 offline: failed')
    expect((await run.usage()).modelCalls).toBe(calls + summaries)
    const terminal = JSON.parse(await readFile(join(base, 'terminal-acceptance.json'), 'utf8'))
    expect(terminal).toMatchObject({ source: 'host-terminal-execution', results: [{ id: 'offline', status: 'failed' }] })
    expect(terminal.results[0].ref).toBeUndefined()
    expect(JSON.parse(await readFile(join(base, 'task-controller.json'), 'utf8')).tasks[0].status).toBe('blocked')
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 180_000 : 20_000)

it.each([false, true])('keeps manual approval across cold restore and executes only an explicit yes (%s)', async approved => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-manual-review-'))
  await writeFile(join(dir, 'probe.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('executed.txt','once')")
  const goal = '验证 probe.mjs 的执行结果', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let primary = 0, work = 0, summaries = 0
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(String(url)).toContain('fixture.invalid') // no cloud safety reviewer or unconfigured Ollama
    if (String(init?.body).includes("You write Pulse's final user-facing reply")) { summaries++; return chat(approved ? '脚本已执行，检查通过。' : '任务未完成，脚本执行未获批准。') }
    primary++
    const { messages } = JSON.parse(String(init?.body)), text = currentRequestText(messages), refs = suppliedRequestResults(messages).map(r => r.id)
    if (text.includes('Create an executable plan')) return chat({ tasks: [{ id: 's', kind: 'verify', goal, check: '脚本完成', criterionIds: ids, dependsOn: [] }] })
    if (text.includes('Verify ONLY the active')) return chat({ status: 'passed', evidenceRefs: refs, note: 'actual script settled' })
    if (text.includes('Independently verify every ORIGINAL')) return chat({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'actual tool receipt' })) })
    return ++work === 1 ? tool('shell_exec', { command: 'node', args: ['probe.mjs'] }) : chat('Delivered')
  }))
  const options = { cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible' as const, baseURL: 'https://fixture.invalid', defaultModel: 'fixture', maxContextTokens: 256000 }, approvalMode: 'auto' as const, taskController: true, maxModelCalls: 8, jarvis: { enabled: false } }
  let host = createLocalHost(options)
  try {
    const c = await host.createConversation(); let run = await host.sendMessage(c.id, { text: goal })
    for await (const event of run.events) if (event.type === 'waiting') break
    const pending = await run.pendingInteractions()
    expect(pending[0]!.kind).toBe('approval')
    expect(primary).toBe(2)
    await expect(readFile(join(dir, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const runId = run.id
    ;(host as any).active.get(runId).runtime.cancelAgent = () => {}
    await host.close()
    host = createLocalHost(options)
    run = await host.resumeRun(c.id)
    expect(run.id).toBe(runId)
    expect(await run.pendingInteractions()).toEqual(pending)
    expect(primary).toBe(2)
    await run.reply(pending[0]!.items[0]!.effectId, { approved, reason: approved ? 'Explicitly authorized exact operation' : 'Do not execute' })
    await run.outcome()
    expect(summaries).toBe(1)
    if (approved) {
      expect(await readFile(join(dir, 'executed.txt'), 'utf8')).toBe('once')
      expect((await run.taskOutcome())?.status).toBe('accepted')
      expect(primary).toBe(5)
    } else {
      await expect(readFile(join(dir, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await run.taskOutcome())?.status).not.toBe('accepted')
      expect(primary).toBe(2)
    }
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 180_000 : 20_000)

it.each(['default-deny', 'manual-deny', 'manual-approve'] as const)('preserves local reviewer DENY unless an explicit operator-enabled human decision overrides it (%s)', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-review-rejection-'))
  await writeFile(join(dir, 'probe.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('executed.txt','once')")
  const goal = '验证 probe.mjs 的执行结果', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let work = 0, reviews = 0, waiting = 0
  const waitingIds: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)), text = currentRequestText(messages), refs = suppliedRequestResults(messages).map(r => r.id)
    if (text.includes('You are the Pulse safety reviewer')) { reviews++; return chat('DENY') }
    if (text.includes('Create an executable plan')) return chat({ tasks: [{ id: 's', kind: 'verify', goal, check: '脚本完成', criterionIds: ids, dependsOn: [] }] })
    if (text.includes('Verify ONLY the active')) return chat({ status: 'passed', evidenceRefs: refs, note: 'Actual script settled' })
    if (text.includes('Independently verify every ORIGINAL')) return chat({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Actual tool receipt' })) })
    return ++work === 1 ? tool('shell_exec', { command: 'node', args: ['probe.mjs'] }) : chat('Delivered')
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, maxModelCalls: 10, jarvis: { enabled: false }, approvalReview: { provider: 'ollama', model: 'fixture-review', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30000, manualOnRejection: mode !== 'default-deny' } })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: goal })
    for await (const event of run.events) if (event.type === 'waiting') {
      waiting++
      waitingIds.push(String(event.data?.effectId))
      await expect(readFile(join(dir, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(event.data).toMatchObject({ input: { tools: [{ toolName: 'shell.exec', input: { command: 'node', args: ['probe.mjs'] }, reviewCode: 'AI_APPROVAL_DENIED' }] } })
      await run.reply(String(event.data?.effectId), { approved: mode === 'manual-approve', reason: 'Explicit decision for the inspected operation' })
    }
    const outcome = await run.outcome()
    expect(waiting, JSON.stringify({ waitingIds, reviews, work, outcome })).toBe(mode === 'default-deny' ? 0 : 1)
    expect(reviews).toBe(1)
    if (mode === 'manual-approve') {
      expect(await readFile(join(dir, 'executed.txt'), 'utf8')).toBe('once')
      expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: 'accepted' })
    } else {
      await expect(readFile(join(dir, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await run.taskOutcome())?.status).not.toBe('accepted')
    }
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 180_000 : 20_000)

it('scopes terminal independent failure without failing unrelated criteria', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-terminal-assertion-'))
  const goal = '验证当前项目。保留用户文档', ids = acceptanceCriteriaFromObjective(goal).map(c => c.id)
  let calls = 0, independent = 0, requestsAtCheck = 0, summaries = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (String(init?.body).includes("You write Pulse's final user-facing reply")) { summaries++; return chat('任务未完成，独立检查发现实际缺陷。') }
    if (++calls === 1) return chat({ tasks: [{ id: 's', kind: 'verify', goal, check: '行为正确', criterionIds: ids, dependsOn: [] }] })
    return tool('trusted_crash', {})
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: true, maxModelCalls: 8, jarvis: { enabled: false }, acceptanceChecks: [{ id: 'offline', description: 'Frozen offline assertion', toolName: 'trusted.offline', input: {}, criterionIds: ids, expectedChecks: ['required', 'unrelated'], assertionCriterionIds: { required: [ids[0]!], unrelated: [ids[1]!] } }], capabilityPacks: [{ manifest: { id: 'trusted', version: '1', kind: 'integration', title: 'trusted', description: 'local assertion' }, activate: async () => ({ tools: [defineTool({ name: 'trusted.crash', description: 'Controlled runtime interruption', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { throw Object.assign(new Error('Simulated cleanup interruption'), { code: 'SANDBOX_CLEANUP_FAILED' }) } }), defineTool({ name: 'trusted.offline', description: 'Actual assertion', input: z.object({}), output: z.any(), sideEffectPolicy: 'read', execute: () => { independent++; requestsAtCheck = calls; return { checks: [{ id: 'required', passed: false, detail: 'actual defect' }, { id: 'unrelated', passed: true }] } } })] }) }], enabledCapabilityPacks: ['trusted'] })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: goal }), outcome = await run.outcome()
    expect(outcome.status).toBe('failed')
    expect(independent).toBe(1); expect(calls).toBe(requestsAtCheck)
    expect(summaries).toBe(1)
    expect(outcome.text).toContain('actual defect')
    expect(outcome.text).not.toContain('首个阻塞: s')
    expect((await run.taskOutcome())?.criteria.map(c => c.status)).toEqual(['not_met', 'unverifiable'])
    const base = join(dir, 'data/conversations', c.id, 'runs', run.id)
    expect(JSON.parse(await readFile(join(base, 'completion-report.json'), 'utf8')).text).toContain('独立检查 offline: failed')
    expect((await run.usage()).modelCalls).toBe(calls + summaries)
    const terminal = JSON.parse(await readFile(join(base, 'terminal-acceptance.json'), 'utf8'))
    expect(terminal).toMatchObject({ source: 'host-terminal-execution', results: [{ id: 'offline', status: 'failed' }] })
    expect(terminal.results[0].ref).toBeUndefined()
    expect(JSON.parse(await readFile(join(base, 'task-controller.json'), 'utf8')).tasks[0].status).toBe('blocked')
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 180_000 : 20_000)
