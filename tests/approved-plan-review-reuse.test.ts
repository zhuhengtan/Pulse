import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { consistentPlanReview, planReviewRequest } from './helpers/plan-review-provider.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it.each(['same', 'changed', 'closed', 'cold'] as const)('reuses only the still-authorized unchanged plan review: %s', async mode => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-approved-review-'))
  const objective = '先把方案写到 docs/plans/feature.md，确认后实现 feature.txt 并读取验证。'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let reviews = 0, planWrites = 0, impl = 0, approvalCount = 0, resumed = false
  let closedApplied = false
  const questions: unknown[] = []
  const guards: unknown[] = []
  let host: ReturnType<typeof createLocalHost>, run: Awaited<ReturnType<typeof host.sendMessage>> | undefined
  const reply = (value: any) => Response.json({ choices: [{ message: typeof value === 'string' ? { content: value } : value, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, args: object) => reply({ content: '', tool_calls: [{ id: `fixture-${planWrites}-${impl}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), text = currentRequestText(request.messages)
    if (request.messages.some((message: any) => message.content?.includes('You are the Pulse safety reviewer'))) return reply('APPROVE')
    if (planReviewRequest(String(init.body))) {
      reviews++
      // The reviewer drifts on a redundant request. An unchanged approved plan
      // must not make that request; a changed/closed grant must fail closed.
      return reply(reviews === 1 ? consistentPlanReview(String(init.body))! : '{}')
    }
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [
      { id: 'plan', kind: 'edit', goal: 'Write docs/plans/feature.md', check: 'Plan saved and reviewed', criterionIds: ids, dependsOn: [] },
      { id: 'implement', kind: 'edit', goal: 'Create feature.txt and read back the content', check: 'feature.txt contains verified fixture', criterionIds: ids, dependsOn: ['plan'] },
    ] }))
    const refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (text.includes('Verify ONLY the active')) return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Actual saved receipts checked' }))
    if (text.includes('Independently verify every ORIGINAL')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Approved plan and actual saved feature' })) }))
    const active = request.messages.flatMap((message: any) => {
      try { const value = JSON.parse(String(message.content)); return value?.activeStage?.id ? [value.activeStage.id] : [] } catch { return [] }
    }).at(-1)
    if (active === 'plan') return ++planWrites === 1 ? tool('plan_write', { path: 'docs/plans/feature.md', content: '# Plan\nAfter explicit approval, create feature.txt containing verified fixture; read it back.\n' }) : reply('Plan saved; await approval.')
    if (++impl === 1) return tool('ask_confirm', { prompt: 'Deterministic fixture checkpoint before read-only plan review' })
    if (impl === 2) {
      if (mode === 'changed') await writeFile(join(cwd, 'docs/plans/feature.md'), '# Externally replaced after approval\n')
      return tool('plan_review', { path: 'docs/plans/feature.md' })
    }
    if (impl === 3) return tool('fs_write', { path: 'feature.txt', content: 'verified fixture' })
    if (impl === 4) return tool('fs_read', { path: 'feature.txt' })
    return reply('Fixture stage complete.')
  }))
  const options = { cwd, dataDir: join(cwd, '.host'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'ask', taskController: true, jarvis: { enabled: false }, maxModelCalls: 40 } as const
  host = createLocalHost(options)
  if (mode === 'closed') {
    const original = (host as any).planGateDenies.bind(host)
    ;(host as any).planGateDenies = async (...args: any[]) => {
      const before = structuredClone((host as any).planGates.get(args[0]))
      const denied = await original(...args)
      guards.push({ tool: args[1], before, denied })
      return denied
    }
  }
  try {
    const conversation = await host.createConversation()
    run = await host.sendMessage(conversation.id, { text: objective })
    for await (const event of run.events) if (event.type === 'waiting') {
      const effectId = String(event.data!.effectId)
      const pending = (await run.pendingInteractions()).flatMap((i: any) => i.items).find((i: any) => i.effectId === effectId) as any
      questions.push(pending.input)
      if (pending.input.decisionScope === 'plan-execution') { approvalCount++; await run.reply(effectId, { value: 'execute' }); continue }
      const checkpoint = pending.input.kind === 'ask' && pending.input.prompt === 'Deterministic fixture checkpoint before read-only plan review'
      if (mode === 'closed' && checkpoint) {
        ;(host as any).planGates.get(run.id).open = false
        await (host as any).savePlanGate(conversation.id, run.id)
        closedApplied = true
      }
      if (mode === 'cold' && !resumed && checkpoint) {
        const budgetPath = join(cwd, '.host/conversations', conversation.id, 'runs', run.id, 'model-budget.json')
        const before = JSON.parse(await readFile(budgetPath, 'utf8')).used
        ;(host as any).active.get(run.id).runtime.cancelAgent = () => {}
        await host.close(); host = createLocalHost(options); run = await host.resumeRun(conversation.id)
        expect(JSON.parse(await readFile(budgetPath, 'utf8')).used).toBe(before)
        resumed = true
        await run.reply(effectId, { value: 'confirm' })
        break
      }
      await run.reply(effectId, checkpoint ? { value: 'confirm' } : { approved: true })
    }
    if (resumed) for await (const event of run.events) if (event.type === 'waiting') await run.reply(String(event.data!.effectId), { approved: true })
    await run.outcome()
    const task = await run.taskOutcome(), accepted = mode === 'same' || mode === 'cold'
    expect(task?.status === 'accepted', JSON.stringify({ task, reviews, approvalCount, resumed, closedApplied, guards, questions })).toBe(accepted)
    if (accepted) expect(reviews).toBe(1)
    else expect(reviews).toBeGreaterThanOrEqual(2)
    expect(approvalCount).toBe(1)
    expect(resumed).toBe(mode === 'cold')
    expect(await readFile(join(cwd, 'feature.txt'), 'utf8').catch(() => null)).toBe(accepted ? 'verified fixture' : null)
    const directory = join(cwd, '.host/conversations', conversation.id, 'runs', run.id)
    const reused = await readFile(join(directory, 'plan-review-reuse.jsonl'), 'utf8').catch(() => '')
    expect(Boolean(reused)).toBe(accepted)
    if (accepted) expect(JSON.parse(reused.trim())).toMatchObject({ schemaVersion: 1, scope: 'unchanged-approved-plan', newModelCall: false })
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
}, 30_000)
