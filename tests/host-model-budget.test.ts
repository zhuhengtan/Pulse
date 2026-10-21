import { readConversationFixture, writeConversationFixture } from './conversation-fixtures.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { FileRuntimeContentStore, hydrateRuntimeResultBodies } from '@hunterzhu/pulse-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'

const response = (content: string, tool?: { name: string; arguments: Record<string, unknown> }) => new Response(JSON.stringify({ choices: [{ message: tool ? { content: '', tool_calls: [{ id: 'call', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

describe('whole-run provider attempt budget', () => {
  it('stops auto-compaction at the run budget and durably records pre-runtime failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-compact-budget-'))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return response('summary') }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 4096, maxOutputTokens: 128 }, taskController: false, approvalMode: 'auto', maxModelCalls: 4, autoCompactPercent: 1 })
    try {
      const conversation = await host.createConversation()
      const path = join(root, 'data/conversations', conversation.id, 'messages.jsonl')
      const history = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', text: 'Historical fact '.repeat(1000), createdAt: '2026-01-01T00:00:00.000Z' }) + '\n').join('')
      await writeConversationFixture(path, history)
      await expect(host.sendMessage(conversation.id, { text: 'Check the project' })).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
      expect(calls).toBe(4)
      expect(await readConversationFixture(path, 'utf8')).toBe(history)
      const saved = await host.getConversation(conversation.id)
      expect(saved.summary.activeRunId).toBeUndefined()
      const manifest = JSON.parse(await readConversationFixture(join(root, 'data/conversations', conversation.id, 'manifest.json'), 'utf8'))
      expect(manifest.runs).toHaveLength(1)
      const runDir = join(root, 'data/conversations', conversation.id, 'runs', manifest.runs[0])
      expect(JSON.parse(await readFile(join(runDir, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'failed', error: { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' }, usage: { modelCalls: 4 } })
      await expect(host.resumeRun(conversation.id)).rejects.toThrow('NO_ACTIVE_RUN')
      expect(calls).toBe(4)
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })
  it('bounds actual requests and does not count rejected admission metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-host-budget-'))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return response('', { name: 'fs_list', arguments: { path: '.' } }) }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: false, approvalMode: 'auto', maxModelCalls: 4, maxTurns: 30 })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Inspect the project' })
      expect((await run.outcome()).error?.code).toBe('TASK_MODEL_CALL_BUDGET_EXHAUSTED')
      expect(calls).toBe(4)
      expect((await run.usage()).modelCalls).toBe(4)
      const directory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
      const ledger = JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'))
      expect(ledger).toMatchObject({ schemaVersion: 1, limit: 4, used: 4, policy: { verificationReserve: 0 }, purposes: { work: 4 }, reportedUsage: 4, inputTokens: 40, outputTokens: 8, tokens: 48, costs: {}, unknown: 0 })
      expect(ledger.metrics.inputTokens).toEqual({ total: 40, known: 4 })
      expect(ledger.usageReceipts).toHaveLength(4)
      expect(new Set(ledger.usageReceipts).size).toBe(4)
      expect((await host.getConversation(conversation.id)).summary.activeRunId).toBeUndefined()
      const events = []
      for await (const event of run.events) events.push(event)
      expect(events.findLast(event => event.type === 'complete')?.data).toMatchObject({ usage: { modelCalls: 4 } })
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['DENY', 'unavailable'])('shares the main budget with safety review and stops equivalent retries on %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-host-denial-'))
    let primary = 0, reviews = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body))
      if (JSON.stringify(body.messages).includes('You are the Pulse safety reviewer')) { reviews++; if (mode === 'unavailable') throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', message: 'https://private.example/secret' } }); return response('DENY') }
      primary++
      return response('', { name: 'shell_exec', arguments: { command: primary === 1 ? 'node' : process.execPath, args: ['-e', 'console.log(process.version)'] } })
    }))
    const host = createLocalHost({ approvalReview: { provider: 'ollama', model: 'fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30000 }, cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: false, approvalMode: 'auto', maxModelCalls: 4 })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Check the runtime version' })
      const outcome = await run.outcome()
      expect(outcome.error?.code).toBe(mode === 'DENY' ? 'AI_APPROVAL_DENIED' : 'AI_APPROVAL_UNAVAILABLE')
      if (mode === 'unavailable') { expect(outcome.error?.message).toContain('ENOTFOUND'); expect(outcome.error?.message).not.toContain('private.example') }
      expect(primary).toBe(1); expect(reviews).toBe(1)
      expect(await run.usage()).toMatchObject({ modelCalls: 2, inputTokens: mode === 'DENY' ? 20 : 10, completeness: mode === 'DENY' ? 'complete' : 'partial' })
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('counts front-model clarification even when it short-circuits the work runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-front-budget-'))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return new Response(JSON.stringify({ response: JSON.stringify({ instantResponse: '收到', brief: { intent: 'clarify', requirements: [], profileHints: [], needsClarification: true, clarificationQuestion: '哪个文件？' } }) }), { headers: { 'content-type': 'application/json' } }) }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), maxModelCalls: 4, frontModel: { enabled: true, model: 'fixture' } })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '修复问题' })
      expect((await run.outcome()).text).toBe('哪个文件？')
      expect(calls).toBe(1); expect((await run.usage()).modelCalls).toBe(1)
      const saved = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'usage.json'), 'utf8'))
      expect(saved.modelCalls).toBe(1); expect(saved.completeness).toBe('unavailable')
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('restores the same waiting run, options and original cumulative limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-budget-resume-'))
    const first = createLocalHost({ cwd: root, dataDir: join(root, 'data'), maxModelCalls: 4, mockToolCalls: [{ name: 'ask.choice', input: { prompt: '是否执行？', options: ['暂不执行', '执行'] } }] })
    let second: ReturnType<typeof createLocalHost> | undefined
    try {
      const conversation = await first.createConversation()
      const run = await first.sendMessage(conversation.id, { text: '询问是否执行' })
      for await (const event of run.events) if (event.type === 'waiting') break
      const pending = await run.pendingInteractions()
      const effect = pending[0]!.items[0]!
      const directory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
      const saved = JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'))
      const runtime = (first as any).active.get(run.id).runtime
      runtime.cancelAgent = () => {}
      await first.close()
      second = createLocalHost({ cwd: root, dataDir: join(root, 'data'), maxModelCalls: 256, mockResponse: '已停止实施' })
      const resumed = await second.resumeRun(conversation.id)
      expect(resumed?.id).toBe(run.id)
      expect((await resumed!.pendingInteractions())[0]?.items[0]).toEqual(effect)
      expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'))).toEqual(saved)
      await resumed!.reply(effect.effectId, { value: '暂不执行' })
      expect((await resumed!.outcome()).status).toBe('succeeded')
      const final = JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'))
      expect(final.limit).toBe(4); expect(final.used).toBeGreaterThan(saved.used)
      expect((await resumed!.usage()).modelCalls).toBe(final.used)
    } finally { await first.close(); await second?.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('shares one limit between front-model and main model requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-front-main-budget-'))
    let front = 0, main = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/generate')) { front++; return new Response(JSON.stringify({ response: '{"instantResponse":"收到"}' }), { headers: { 'content-type': 'application/json' } }) }
      main++; return response('', { name: 'fs_list', arguments: { path: '.' } })
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, frontModel: { enabled: true, model: 'front-fixture' }, taskController: false, approvalMode: 'auto', maxModelCalls: 4, maxTurns: 30 })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Inspect the project' })
      expect((await run.outcome()).error?.code).toBe('TASK_MODEL_CALL_BUDGET_EXHAUSTED')
      expect(front).toBe(1); expect(main).toBe(3)
      expect(await run.usage()).toMatchObject({ modelCalls: 4, completeness: 'partial', inputTokens: 30 })
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps local approval review within the same budget and preserves human fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-local-review-budget-'))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return response('', calls < 4 ? { name: 'fs_list', arguments: { path: '.' } } : { name: 'fs_write', arguments: { path: 'note.md', content: 'hello' } })
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: false, approvalMode: 'ask', maxModelCalls: 4, approvalReview: { provider: 'ollama', model: 'fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30_000 } })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Write note.md after inspecting the project' })
      // Pure read approval cards are answered directly in this fixture.
      let finalEffect = ''
      for await (const event of run.events) if (event.type === 'waiting') {
        const pending = await run.pendingInteractions()
        const item = pending[0]!.items[0]!
        if (calls === 4) { finalEffect = item.effectId; break }
        await run.reply(item.effectId, { approved: true })
      }
      expect(calls).toBe(4)
      const pending = await run.pendingInteractions()
      expect(await run.reviewApproval(finalEffect)).toMatchObject({ status: 'manual', reason: 'review_failed' })
      expect(calls).toBe(4)
      expect(await run.pendingInteractions()).toEqual(pending)
      await expect(readFile(join(root, 'note.md'), 'utf8')).rejects.toThrow()
      await run.reply(finalEffect, { approved: false, reason: 'Do not execute' })
      expect((await run.outcome()).error?.code).toBe('APPROVAL_DENIED')
      expect((await run.usage()).modelCalls).toBe(4)
      const log = await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'approval-reviews.jsonl'), 'utf8')
      expect(log).toContain('TASK_MODEL_CALL_BUDGET_EXHAUSTED')
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('approves necessary syntax checks locally without invoking a reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-check-approval-'))
    await writeFile(join(root, 'main.mjs'), 'export const ok = true')
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--check', 'main.mjs'] } }] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '验证 main.mjs 的语法' })
      for await (const event of run.events) if (event.type === 'waiting') {
        const pending = await run.pendingInteractions()
        expect(await run.reviewApproval(pending[0]!.items[0]!.effectId)).toEqual({ status: 'approved', reason: 'bounded_verification' })
      }
      await run.outcome()
      const audit = await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'approval-reviews.jsonl'), 'utf8')
      expect(audit).toContain('bounded_verification')
      const runDirectory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
      const snapshot = await hydrateRuntimeResultBodies(JSON.parse(await readFile(join(runDirectory, 'runtime.json'), 'utf8')), new FileRuntimeContentStore(join(runDirectory, 'runtime-results')))
      const result = snapshot.state.state.results.map(([, value]: any) => value.value).find((value: any) => value && typeof value.stdout === 'string')
      expect(result).toMatchObject({ code: 0, timedOut: false })
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('also bypasses model review for necessary syntax checks in auto mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-auto-check-'))
    await writeFile(join(root, 'main.mjs'), 'export const ok = true')
    let primary = 0, reviews = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (String(options.body).includes('You are the Pulse safety reviewer')) { reviews++; return response('DENY') }
      primary++
      return primary === 1 ? response('', { name: 'shell_exec', arguments: { command: 'node', args: ['--check', 'main.mjs'] } }) : response('checked')
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto', taskController: false, maxModelCalls: 4 })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '验证 main.mjs 的语法' })
      await run.outcome()
      expect(reviews).toBe(0)
      const runDirectory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
      const snapshot = await hydrateRuntimeResultBodies(JSON.parse(await readFile(join(runDirectory, 'runtime.json'), 'utf8')), new FileRuntimeContentStore(join(runDirectory, 'runtime-results')))
      const result = snapshot.state.state.results.map(([, value]: any) => value.value).find((value: any) => value && typeof value.stdout === 'string')
      expect(result).toMatchObject({ code: 0, timedOut: false })
      expect((await run.usage()).modelCalls).toBe(primary)
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('counts a successful local Ollama approval before continuing the original run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-local-review-used-'))
    let primary = 0, reviews = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (String(options.body).includes('You review pending tool operations')) { reviews++; return response('APPROVE') }
      primary++
      return primary === 1 ? response('', { name: 'fs_write', arguments: { path: 'note.md', content: 'hello' } }) : response('done')
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: false, approvalMode: 'ask', maxModelCalls: 4, approvalReview: { provider: 'ollama', model: 'fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30_000 } })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Write note.md' })
      for await (const event of run.events) if (event.type === 'waiting') {
        const pending = await run.pendingInteractions()
        expect(await run.reviewApproval(pending[0]!.items[0]!.effectId)).toEqual({ status: 'approved', reason: 'approved' })
      }
      await run.outcome()
      expect(reviews).toBe(1)
      expect((await run.usage()).modelCalls).toBe(primary + reviews)
      expect(primary + reviews).toBeLessThanOrEqual(4)
      expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('hello')
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('does not let a parent task-controller lane retry after a worker is denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-controller-denial-'))
    const goal = '检查运行时版本'
    let primary = 0, reviews = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const text = currentRequestText(JSON.parse(String(options.body)).messages)
      if (text.includes('You are the Pulse safety reviewer')) { reviews++; return response('DENY') }
      primary++
      if (text.includes('Create an executable plan')) return response(JSON.stringify({ tasks: [{ id: 'check', goal, criterionIds: acceptanceCriteriaFromObjective(goal).map(item => item.id), dependsOn: [], check: 'Check node version' }] }))
      return response('', { name: 'shell_exec', arguments: { command: 'node', args: ['-e', 'console.log(process.version)'] } })
    }))
    const host = createLocalHost({ approvalReview: { provider: 'ollama', model: 'fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30000 }, cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: true, approvalMode: 'auto', maxModelCalls: 16 })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: goal })
      await run.outcome()
      expect(primary).toBe(2); expect(reviews).toBe(1)
      expect((await run.usage()).modelCalls).toBe(3)
      expect((await run.taskOutcome())?.status).not.toBe('accepted')
      const runDirectory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
      const snapshot = await hydrateRuntimeResultBodies(JSON.parse(await readFile(join(runDirectory, 'runtime.json'), 'utf8')), new FileRuntimeContentStore(join(runDirectory, 'runtime-results')))
      expect(snapshot.state.state.effects.filter(([, effect]: any) => effect.kind === 'tool' && effect.input?.name === 'shell.exec')).toHaveLength(1)
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })
})

describe('failed request diagnostics and direct create protection', () => {
  it('records failed provider time without inventing token usage or cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-failed-latency-'))
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      throw new DOMException('redacted transport timeout', 'TimeoutError')
    }))
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: false, maxModelCalls: 4 })
    try {
      const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Explain local architecture' })
      const outcome = await run.outcome(), usage = await run.usage()
      expect(outcome.error?.code).toBe('PROVIDER_NETWORK_ERROR')
      expect(outcome.error?.message).toContain('TimeoutError')
      expect(usage.durationMs).toBeGreaterThan(0)
      expect(usage.modelCalls).toBe(1)
      expect(usage.inputTokens).toBeNull()
      expect(usage.outputTokens).toBeNull()
      expect(usage.providerCosts).toEqual([])
      expect(usage.completeness).toBe('unavailable')
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('checks syntax for direct fs.write without executing it (valid=%s)', async valid => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-direct-syntax-'))
    const content = valid ? 'throw new Error("parse only, never run")' : 'export function unfinished( {'
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'auto', taskController: false, maxTurns: 4, mockToolCalls: [{ name: 'fs.write', input: { path: 'new.mjs', content } }] })
    try {
      const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: 'Create new.mjs in this workspace' })
      await run.outcome()
      if (valid) expect(await readFile(join(root, 'new.mjs'), 'utf8')).toBe(content)
      else {
        await expect(readFile(join(root, 'new.mjs'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        const runDirectory = join(root, 'data/conversations', conversation.id, 'runs', run.id)
      const snapshot = await hydrateRuntimeResultBodies(JSON.parse(await readFile(join(runDirectory, 'runtime.json'), 'utf8')), new FileRuntimeContentStore(join(runDirectory, 'runtime-results')))
        expect(snapshot.state.state.effects.some(([, effect]: any) => effect.input?.name === 'fs.write' && effect.outcome?.error?.code === 'DRAFT_SYNTAX_INVALID')).toBe(true)
      }
    } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
  })
})
