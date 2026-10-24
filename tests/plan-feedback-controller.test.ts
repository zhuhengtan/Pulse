import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { explicitPlanDecision, planRevisionFeedback } from '../packages/server/src/plan-confirmation.js'
import { consistentPlanReview, planReviewRequest } from './helpers/plan-review-provider.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

const question = { kind: 'ask', type: 'choice', options: [{ label: '暂不执行', value: 'defer' }, { label: '执行', value: 'execute' }] }
it('separates free-form plan feedback from execution decisions and conflicting choices', () => {
  const feedback = { text: '改为滑动窗口，修改方案后再确认。' }
  expect(explicitPlanDecision(question, feedback)).toBeUndefined()
  expect(planRevisionFeedback(question, feedback)).toBe(feedback.text)
  expect(planRevisionFeedback(question, { text: '同意执行，但先修改方案' }, true)).toBeUndefined()
  expect(planRevisionFeedback(question, { text: '同意执行，但先修改方案' })).toBe('同意执行，但先修改方案')
  for (const answer of [{ value: 'execute', text: feedback.text }, { approved: true, text: feedback.text }, { text: '同意执行' }, { text: '暂不执行' }, { text: '' }, { text: 'x'.repeat(4001) }]) expect(planRevisionFeedback(question, answer)).toBeUndefined()
})

it.each(['normal', 'cold', 'limit', 'stale-review', 'external-plan-change'] as const)('repairs caller feedback under the closed gate and requires a new approval: %s', async mode => {
  const cold = mode === 'cold'
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-feedback-'))
  const objective = '先把方案写到 docs/plans/feature.md，确认后再实现 feature.txt。'
  const originalIds = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let plans = 0, repairs = 0, work = 0, reviews = 0, requests = 0
  const reply = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, args: object) => reply({ content: '', tool_calls: [{ id: `call-${requests}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    requests++
    const body = String(init.body), request = JSON.parse(body), savedPlan = planReviewRequest(body)
    if (savedPlan) {
      reviews++
      if (savedPlan.content.includes('sliding')) { expect(body).toContain('改为滑动窗口。'); expect(body).toContain('confirmedDecisions') }
      return reply(consistentPlanReview(body)!)
    }
    const text = currentRequestText(request.messages), ids = [...new Set([...originalIds, ...(body.match(/plan-feedback-result-\d+-\d+/g) ?? [])])]
    if (text.includes('Create an executable plan')) {
      plans++
      return reply(JSON.stringify({ tasks: plans === 1 ? [
        { id: 'plan', kind: 'edit', goal: 'Write docs/plans/feature.md', check: 'Plan saved', criterionIds: ids, dependsOn: [] },
        { id: 'implement', kind: 'edit', goal: 'Create feature.txt', check: 'Implementation saved', criterionIds: ids, dependsOn: ['plan'] },
      ] : [{ id: 'implement', kind: 'edit', goal: 'Create feature.txt according to the revised plan', check: 'Sliding feature saved', criterionIds: ids, dependsOn: [] }] }))
    }
    if (text.includes('Repair only the saved docs/plans document')) {
      repairs++
      if (mode === 'stale-review') return reply('The old plan review was ready, so proceed without reviewing feedback.')
      if (repairs === 1) return tool('fs_write', { path: 'feature.txt', content: 'UNAUTHORIZED' })
      if (repairs === 2) return tool('fs_apply_patch', { path: 'docs/plans/feature.md', find: 'fixed', replace: 'sliding' })
      if (mode === 'limit' && repairs === 4) return tool('fs_apply_patch', { path: 'docs/plans/feature.md', find: 'sliding', replace: 'sliding clarified' })
      return reply('Revised plan has a ready review; await a new Host approval.')
    }
    const refs = suppliedRequestResults(request.messages).map(r => r.id)
    if (text.includes('Verify ONLY the active')) {
      if (mode === 'external-plan-change' && plans > 1) await writeFile(join(cwd, 'docs/plans/feature.md'), '# Externally replaced after approval\n')
      return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Actual saved receipt supplied' }))
    }
    if (text.includes('Independently verify every ORIGINAL')) return reply(JSON.stringify({ criteria: ids.map(criterionId => ({ criterionId, status: 'passed', evidenceRefs: refs, rationale: 'Saved sliding feature and approved revised plan' })) }))
    if (++work === 1) return tool('plan_write', { path: 'docs/plans/feature.md', content: '# Plan\nUse fixed windows. Implement feature.txt only after explicit approval.\n' })
    if (plans > 1 && work === 2) return tool('fs_write', { path: 'feature.txt', content: 'sliding' })
    return reply('The current stage is complete.')
  }))
  const options = { cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: true, approvalMode: 'auto', maxModelCalls: 48 } as const
  let host = createLocalHost(options), run: Awaited<ReturnType<typeof host.sendMessage>> | undefined
  let offered = 0, firstEffect = '', firstHash = '', secondEffect = '', conversationId = ''
  try {
    const c = await host.createConversation(); conversationId = c.id; run = await host.sendMessage(c.id, { text: objective })
    const directory = join(cwd, 'data/conversations', c.id, 'runs', run.id)
    for await (const event of run.events) if (event.type === 'waiting') {
      offered++
      const effectId = String(event.data!.effectId)
      expect(await readFile(join(cwd, 'feature.txt'), 'utf8').catch(() => null)).toBeNull()
      const gate = JSON.parse(await readFile(join(directory, 'plan-gate.json'), 'utf8'))
      expect(gate.implementationAllowed).toBe(false)
      if (offered === 1) { firstEffect = effectId; firstHash = gate.binding.hash; await run.reply(effectId, { text: '改为滑动窗口。' }) }
      else {
        secondEffect = effectId
        expect(gate.binding.hash).not.toBe(firstHash)
        expect(await readFile(join(cwd, 'docs/plans/feature.md'), 'utf8')).toContain('sliding')
        await expect(run.reply(firstEffect, { text: '同意执行' })).rejects.toThrow('EFFECT_NOT_REPLYABLE')
        await expect(run.reply(effectId, { value: 'execute', text: '不要执行' })).rejects.toMatchObject({ code: 'PLAN_EXECUTION_DECISION_REQUIRED' })
        if (mode === 'limit') {
          if (offered === 2) await run.reply(effectId, { text: '保留滑动窗口，调整方案描述。' })
          else {
            await expect(run.reply(effectId, { text: '再次修改方案描述。' })).rejects.toMatchObject({ code: 'PLAN_REVISION_LIMIT_REACHED' })
            await run.reply(effectId, { text: '暂不执行' })
          }
          continue
        }
        if (cold) {
          const before = JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).used
          ;(host as any).active.get(run.id).runtime.cancelAgent = () => {}
          await host.close(); host = createLocalHost(options)
          run = await host.resumeRun(c.id)
          expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).used).toBe(before)
          expect((await run.pendingInteractions())[0]!.items[0]!.effectId).toBe(secondEffect)
          break
        }
        await run.reply(effectId, { text: '同意执行' })
      }
    }
    if (cold) await run!.reply(secondEffect, { text: '同意执行' })
    await run!.outcome()
    if (mode === 'normal' || mode === 'cold') expect(await run!.taskOutcome()).toMatchObject({ status: 'accepted' })
    if (mode === 'external-plan-change') {
      const outcome = await run!.taskOutcome()
      expect(outcome).toMatchObject({ status: 'incomplete' })
      expect(JSON.stringify(outcome)).toContain('EVIDENCE_CHANGED')
    }
    expect(offered).toBe(mode === 'stale-review' ? 1 : mode === 'limit' ? 3 : 2)
    expect(reviews).toBe(mode === 'stale-review' ? 1 : mode === 'limit' ? 3 : 2)
    expect(repairs).toBe(mode === 'stale-review' ? 2 : mode === 'limit' ? 5 : 3)
    expect(await readFile(join(cwd, 'feature.txt'), 'utf8').catch(() => null)).toBe(mode === 'stale-review' || mode === 'limit' ? null : 'sliding')
    const directory2 = join(cwd, 'data/conversations', conversationId, 'runs', run!.id)
    const input = JSON.parse(await readFile(join(directory2, 'input.json'), 'utf8'))
    const record = JSON.parse(await readFile(join(directory2, 'task-record.json'), 'utf8'))
    expect(input.planDecisionVersion).toBe(3)
    expect(record.acceptanceCriteria.some((c: any) => c.description === '改为滑动窗口。')).toBe(true)
    const budget = JSON.parse(await readFile(join(directory2, 'model-budget.json'), 'utf8'))
    expect(budget.used).toBe(requests)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
