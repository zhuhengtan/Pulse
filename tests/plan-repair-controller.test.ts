import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { consistentPlanReview, planReviewRequest } from './helpers/plan-review-provider.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it.each(['repair', 'stuck', 'early-business'] as const)('repairs a rejected whole plan within the closed execution gate: %s', async mode => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-repair-'))
  const objective = '先把方案写到 docs/plans/feature.md，确认后再实现 feature.txt。'
  const ids = acceptanceCriteriaFromObjective(objective).map(item => item.id)
  const bad = '# Plan\nThe status is both visible and hidden.\n'
  const good = '# Plan\nThe status stays visible; implementation starts after explicit confirmation.\n'
  let work = 0, repairs = 0, reviews = 0, offered = 0
  const reply = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, args: object) => reply({ content: '', tool_calls: [{ id: `call-${work}-${repairs}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body), request = JSON.parse(body), savedPlan = planReviewRequest(body)
    if (savedPlan) {
      reviews++
      const review = JSON.parse(String((consistentPlanReview(body) as { content: string }).content))
      if (savedPlan.content === bad) review.issues = [{ code: 'STATE_CONFLICT', message: 'Correct the contradictory visibility.', evidence: ['The status is both visible and hidden.'] }]
      return reply({ content: JSON.stringify(review) })
    }
    const text = currentRequestText(request.messages)
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [
      { id: 'plan', kind: 'edit', goal: 'Write docs/plans/feature.md', check: 'Concrete plan saved', criterionIds: ids, dependsOn: [] },
      { id: 'implement', kind: 'edit', goal: 'Create feature.txt', check: 'Implementation saved', criterionIds: ids, dependsOn: ['plan'] },
    ] }))
    if (text.includes('Repair only the saved docs/plans document')) {
      repairs++
      if (mode === 'stuck') return reply('The prerequisite is still unresolved; implementation has not started.')
      if (mode === 'early-business' && repairs === 1) return tool('fs_write', { path: 'feature.txt', content: 'UNAUTHORIZED' })
      if (repairs === (mode === 'early-business' ? 2 : 1)) return tool('fs_apply_patch', { path: 'docs/plans/feature.md', find: 'The status is both visible and hidden.', replace: 'The status stays visible; implementation starts after explicit confirmation.' })
      return reply('The complete saved plan now has a ready review. Await host confirmation.')
    }
    if (text.includes('Verify ONLY the active taskController stage')) return reply(JSON.stringify({ status: 'passed', evidenceRefs: suppliedRequestResults(request.messages).map(r => r.id), note: 'Saved plan receipt is present; the independent whole-plan review remains authoritative.' }))
    work++
    if (work === 1) return tool('plan_write', { path: 'docs/plans/feature.md', content: bad })
    return reply('Plan saved. Implementation awaits the whole-plan review and confirmation.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: true, approvalMode: 'auto', maxModelCalls: 32 })
  try {
    const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: objective })
    for await (const event of run.events) if (event.type === 'waiting') {
      offered++
      expect(mode).not.toBe('stuck')
      expect(await readFile(join(cwd, 'docs/plans/feature.md'), 'utf8')).toBe(good)
      expect(await readFile(join(cwd, 'feature.txt'), 'utf8').catch(() => null)).toBeNull()
      await run.reply(String(event.data!.effectId), { value: 'defer' })
    }
    await run.outcome()
    expect(offered).toBe(mode === 'stuck' ? 0 : 1)
    expect(reviews).toBe(mode === 'stuck' ? 1 : 2)
    expect(repairs).toBe(mode === 'early-business' ? 3 : 2)
    expect(await readFile(join(cwd, 'feature.txt'), 'utf8').catch(() => null)).toBeNull()
    const dir = join(cwd, 'data/conversations', c.id, 'runs', run.id)
    const state = JSON.parse(await readFile(join(dir, 'task-controller.json'), 'utf8'))
    expect(state.planReviewRepairs).toBe(mode === 'stuck' ? 2 : 1)
    const ledger = JSON.parse(await readFile(join(dir, 'model-budget.json'), 'utf8'))
    expect(ledger.used).toBeGreaterThan(repairs + reviews)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
