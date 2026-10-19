import { consistentPlanReview } from './helpers/plan-review-provider.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '../packages/server/src/index.js'
import { requiresExplicitPlanConfirmation } from '../packages/server/src/plan-confirmation.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['先把方案写到 docs/plans/change.md，确认后再实现代码和测试。', true],
  ['确认计划后再实现代码。', true],
  ['确认方案后再开发。', true],
  ['批准该计划后再修改实现。', true],
  ['确认一下计划后再实现。', true],
  ['Write a plan. After I approve it, implement the code.', true],
  ['根据已确认方案直接实现代码。', false],
  ['写计划后直接执行，无需确认。', false],
  ['先确认阈值后写计划，再实现代码。', false],
])('detects an explicit saved-plan gate without imposing one on direct execution: %s', (text, expected) => {
  expect(requiresExplicitPlanConfirmation(text)).toBe(expected)
})

it.each([
  { choice: 'execute', mutate: false, atomic: false, revise: false },
  { choice: 'defer', mutate: false, atomic: false, revise: false },
  { choice: 'execute', mutate: true, atomic: false, revise: false },
  { choice: 'execute', mutate: false, atomic: true, revise: false },
  { choice: 'execute', mutate: false, atomic: false, revise: true },
])('binds natural-language confirmation to the saved plan before implementation (%j)', async ({ choice, mutate, atomic, revise }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-natural-plan-'))
  const objective = atomic ? '先更新 docs/plans/feature.md 方案，确认后再实现 greet.mjs。' : '先把方案写到 docs/plans/feature.md，确认后再实现 greet.mjs。'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  const plan = '# Plan v1\nCreate greet.mjs and preserve existing project files.\n'
  const saved = atomic ? plan.replace('v1', 'v2').replace('preserve existing', 'preserve all existing') : plan
  if (atomic) { await mkdir(join(cwd, 'docs/plans'), { recursive: true }); await writeFile(join(cwd, 'docs/plans/feature.md'), plan) }
  let stage = 0, waiting = 0
  const turns = [0, 0]
  const chat = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, args: object) => chat({ content: '', tool_calls: [{ id: 'call-' + stage + '-' + turns[stage], function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)), blob = currentRequestText(request.messages)
    const review = consistentPlanReview(String(init.body))
    if (review) return chat(review)
    const refs = request.messages.filter((m: any) => m.name === 'results').flatMap((m: any) => JSON.parse(m.content)).map((r: any) => r.id)
    if (blob.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [
      { id: 'plan', kind: 'edit', goal: (atomic ? 'Update' : 'Write') + ' docs/plans/feature.md', check: 'Concrete plan saved', dependsOn: [], criterionIds: ids },
      { id: 'implement', kind: 'edit', goal: 'Create greet.mjs', check: 'Implementation saved', dependsOn: ['plan'], criterionIds: ids },
    ] }))
    if (blob.includes('Verify ONLY the active taskController stage')) { stage++; return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Saved file verified' })) }
    if (blob.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: refs, rationale: 'Plan approval preceded implementation' })) }))
    const turn = ++turns[stage]!
    if (stage === 0 && turn === 1 && atomic) return tool('fs_apply_patches', { path: 'docs/plans/feature.md', patches: [{ find: 'Plan v1', replace: 'Plan v2' }, { find: 'preserve existing', replace: 'preserve all existing' }] })
    if (stage === 0 && turn === 1) return tool('plan_write', { path: 'docs/plans/feature.md', content: plan })
    if (stage === 0 && turn === 2 && revise) return tool('fs_apply_patch', { path: 'docs/plans/feature.md', find: 'preserve existing', replace: 'preserve all existing' })
    if (stage === 1 && turn === 1) return tool('fs_write', { path: 'greet.mjs', content: "export const greet = 'hello'\n" })
    return chat('Done.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: true, approvalMode: 'auto', maxModelCalls: 24 })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: objective })
    const previews: string[] = []
    for await (const event of run.events) {
      if (event.type === 'text' && typeof event.data === 'string') previews.push(event.data)
      if (event.type !== 'waiting') continue
      waiting++
      expect(stage).toBe(0)
      expect(turns[0]).toBe(waiting)
      const expectedPlan = revise && waiting === 2 ? saved.replace('preserve existing', 'preserve all existing') : saved
      expect(await readFile(join(cwd, 'docs/plans/feature.md'), 'utf8')).toBe(expectedPlan)
      expect(previews.some(text => text.includes(expectedPlan))).toBe(true)
      await expect(readFile(join(cwd, 'greet.mjs'), 'utf8')).rejects.toThrow()
      if (mutate) {
        await writeFile(join(cwd, 'docs/plans/feature.md'), saved + 'External change\n')
        await expect(run.reply(event.data!.effectId as string, { value: 'execute' })).rejects.toMatchObject({ code: 'PLAN_CHANGED_RECONFIRM_REQUIRED' })
        await expect(readFile(join(cwd, 'greet.mjs'), 'utf8')).rejects.toThrow()
        await run.reply(event.data!.effectId as string, { value: 'defer' })
      } else await run.reply(event.data!.effectId as string, { value: choice })
    }
    const outcome = await run.outcome()
    expect(waiting, outcome.text).toBe(revise ? 2 : 1)
    expect(outcome, outcome.text).toMatchObject({ status: 'succeeded' })
    const approved = choice === 'execute' && !mutate
    expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: approved ? 'accepted' : 'incomplete' })
    if (approved) expect(await readFile(join(cwd, 'greet.mjs'), 'utf8')).toContain('export const greet')
    else await expect(readFile(join(cwd, 'greet.mjs'), 'utf8')).rejects.toThrow()
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
