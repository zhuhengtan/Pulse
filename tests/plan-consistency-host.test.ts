import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '../packages/server/src/index.js'
import { consistentPlanReview, planReviewRequest } from './helpers/plan-review-provider.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())

it('reviews the entire revised plan and repairs a prerequisite cycle before offering execution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-consistency-'))
  const bad = '# V3\n步骤5：P1未解决前不得进入步骤6。\nP1：步骤6完成并取得旧测试失败证据后才能更新基线。\n'
  const good = '# V4\n步骤1：由调用方先完成测试契约验证与基线交接。\n步骤2：基线交接完成后实施源码变更。\n'
  let turns = 0, reviews = 0, offered = 0
  const response = (message: object) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, args: object) => response({ content: '', tool_calls: [{ id: `call-${turns}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body)
    const request = planReviewRequest(body)
    if (request) {
      reviews++
      const broken = request.content.includes('步骤5：P1未解决前')
      expect(request.content).toBe(broken ? bad : good)
      const nodes = broken
        ? [{ id: 'step6', requires: ['P1'], evidence: '步骤5：P1未解决前不得进入步骤6。' }, { id: 'P1', requires: ['step6'], evidence: 'P1：步骤6完成并取得旧测试失败证据后才能更新基线。' }]
        : [{ id: 'step1', requires: [], evidence: '步骤1：由调用方先完成测试契约验证与基线交接。' }, { id: 'step2', requires: ['step1'], evidence: '步骤2：基线交接完成后实施源码变更。' }]
      return response({ content: JSON.stringify({ checks: ['dependencies', 'prerequisites', 'state', 'scope', 'validation'].map(area => ({ area, status: 'passed', reason: 'Checked the full document', evidence: [broken ? nodes[0]!.evidence : nodes[1]!.evidence] })), nodes, issues: [] }) })
    }
    turns++
    if (turns === 1) return tool('plan_write', { path: 'docs/plans/v3.md', content: bad })
    if (turns === 3) {
      expect(body).toContain('PLAN_DEPENDENCY_CYCLE')
      expect(offered).toBe(0)
      return tool('plan_write', { path: 'docs/plans/v4.md', content: good })
    }
    return tool('ask_choice', { prompt: '是否执行已保存计划？', options: [{ label: '暂不执行', value: 'hold' }, { label: '执行', value: 'execute' }] })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '/grill-and-plan 修订计划，完整核对后确认再实施。' })
    for await (const event of run.events) {
      if (event.type !== 'waiting') continue
      offered++
      try { expect(reviews).toBe(2); expect(turns).toBe(4) }
      catch (error) { await run.cancel('TEST_CLEANUP'); throw error }
      await run.reply(String(event.data!.effectId), { value: 'hold' })
    }
    const outcome = await run.outcome()
    expect(outcome, JSON.stringify({ outcome, turns, reviews, offered })).toMatchObject({ status: 'succeeded' })
    expect(offered).toBe(1)
    expect(await readFile(join(cwd, 'docs/plans/v3.md'), 'utf8')).toBe(bad)
    expect(await readFile(join(cwd, 'docs/plans/v4.md'), 'utf8')).toBe(good)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

it.each(['malformed', 'unavailable', 'unresolved'] as const)('preserves the saved plan and refuses execution when review is %s', async mode => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-review-blocked-'))
  const plan = '# Plan\nP1 requires an unavailable test-update mechanism.\n'
  let turns = 0, reviews = 0
  const reply = (message: object) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body), request = planReviewRequest(body)
    if (request) {
      reviews++
      if (mode === 'unavailable') return new Response('Reviewer unavailable', { status: 400 })
      if (mode === 'malformed') return reply({ content: 'Looks good, execute now.' })
      const review = JSON.parse(String((consistentPlanReview(body) as { content: string }).content))
      review.nodes = [{ id: 'P1', requires: [], unresolved: true, evidence: 'P1 requires an unavailable test-update mechanism.' }]
      return reply({ content: JSON.stringify(review) })
    }
    turns++
    const name = turns === 1 ? 'plan_write' : 'ask_choice'
    const args = turns === 1 ? { path: 'docs/plans/blocked.md', content: plan } : { prompt: '是否执行？', options: [{ label: '暂不执行', value: 'hold' }, { label: '执行', value: 'execute' }] }
    return reply({ content: '', tool_calls: [{ id: `call-${turns}`, function: { name, arguments: JSON.stringify(args) } }] })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'auto', maxModelCalls: 12 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '/grill-and-plan 保存计划，确认后再实现。' })
    for await (const event of run.events) expect(event.type).not.toBe('waiting')
    expect(await run.outcome()).toMatchObject({ status: 'failed', error: { code: 'QUESTION_VALIDATION_FAILED' } })
    expect(await readFile(join(cwd, 'docs/plans/blocked.md'), 'utf8')).toBe(plan)
    expect(reviews).toBe(1)
    expect(turns).toBe(4)
    const dir = join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'plan-reviews')
    const saved = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]!), 'utf8'))
    expect(saved.status).toBe(mode === 'unresolved' ? 'blocked' : 'unavailable')
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

it('rechecks a patched plan, revokes its earlier approval, and blocks a new contradictory version', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-review-revision-'))
  const plan = '# Plan\nThe card stays visible.\n', changed = 'The card is hidden during pending, but its buttons remain visible.'
  let turns = 0, reviews = 0, offered = 0
  const reply = (message: object) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  const tool = (name: string, args: object) => reply({ content: '', tool_calls: [{ id: `call-${turns}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body), request = planReviewRequest(body)
    if (request) {
      reviews++
      const review = JSON.parse(String((consistentPlanReview(body) as { content: string }).content))
      if (request.content.includes(changed)) review.issues = [{ code: 'PENDING_VISIBILITY_CONFLICT', message: 'Hidden card cannot retain visible buttons.', evidence: [changed] }]
      return reply({ content: JSON.stringify(review) })
    }
    turns++
    if (turns === 1) return tool('plan_write', { path: 'docs/plans/feature.md', content: plan })
    if (turns === 3) return tool('fs_apply_patch', { path: 'docs/plans/feature.md', find: 'The card stays visible.', replace: changed })
    if (turns === 5) return tool('fs_write', { path: 'feature.txt', content: 'must not be written' })
    if (turns >= 6) return reply({ content: 'The revised plan is blocked by contradictory card behavior. Plan saved; implementation has not run.' })
    return tool('ask_choice', { prompt: '执行？', options: [{ label: '暂不执行', value: 'hold' }, { label: '执行', value: 'execute' }] })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '/grill-and-plan 完整核对计划，确认后再实施。' })
    for await (const event of run.events) if (event.type === 'waiting') {
      offered++; expect(turns).toBe(2); await run.reply(String(event.data!.effectId), { value: 'execute' })
    }
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    expect(offered).toBe(1); expect(reviews).toBe(2)
    expect(await readFile(join(cwd, 'docs/plans/feature.md'), 'utf8')).toContain(changed)
    await expect(readFile(join(cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const ledger = JSON.parse(await readFile(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'model-budget.json'), 'utf8'))
    expect(ledger.used).toBe(turns + reviews)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

it('refuses legacy unreviewed approval after cold restore without replaying a write or review', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-review-restore-'))
  let turns = 0, reviews = 0
  const reply = (message: object) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const review = consistentPlanReview(String(init.body))
    if (review) { reviews++; return reply(review) }
    turns++
    return reply({ content: '', tool_calls: [{ id: `call-${turns}`, function: { name: turns === 1 ? 'plan_write' : 'ask_choice', arguments: JSON.stringify(turns === 1 ? { path: 'docs/plans/restore.md', content: '# Plan\nImplement a greeting.' } : { prompt: '执行？', options: [{ label: '暂不执行', value: 'hold' }, { label: '执行', value: 'execute' }] }) } }] })
  }))
  const options = { cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'auto' as const, maxModelCalls: 12 }
  const first = createLocalHost(options)
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation(), run = await first.sendMessage(conversation.id, { text: '/grill-and-plan 保存计划，确认后再实现。' })
    let effectId = ''
    for await (const event of run.events) if (event.type === 'waiting') { effectId = String(event.data!.effectId); break }
    expect(effectId).not.toBe('')
    // Simulate a pre-review checkpoint without changing its original file or human effect.
    await rm(join(cwd, 'data/conversations', conversation.id, 'runs', run.id, 'plan-reviews'), { recursive: true })
    ;(first as any).active.get(run.id).runtime.cancelAgent = () => {}
    await first.close()
    second = createLocalHost(options)
    const restored = await second.resumeRun(conversation.id)
    await expect(restored.reply(effectId, { value: 'execute' })).rejects.toMatchObject({ code: 'PLAN_REVIEW_REQUIRED' })
    expect((await restored.pendingInteractions())[0]!.items[0]!.effectId).toBe(effectId)
    expect(turns).toBe(2); expect(reviews).toBe(1)
    await restored.reply(effectId, { value: 'hold' })
    expect(await restored.outcome()).toMatchObject({ status: 'succeeded' })
  } finally { await first.close(); await second?.close(); await rm(cwd, { recursive: true, force: true }) }
})

it('reports a blocked controller plan without entering an approval or dispatch loop', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-controller-plan-review-'))
  const objective = '先把方案写到 docs/plans/feature.md，确认后再实现 feature.txt。'
  const ids = acceptanceCriteriaFromObjective(objective).map(item => item.id)
  let work = 0, reviewed = 0
  const reply = (message: any) => new Response(JSON.stringify({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body), review = consistentPlanReview(body)
    if (review) {
      reviewed++
      const value = JSON.parse(String((review as { content: string }).content))
      value.nodes = [{ id: 'P1', requires: [], unresolved: true, evidence: 'P1: no authorized mechanism exists.' }]
      return reply({ content: JSON.stringify(value) })
    }
    const request = JSON.parse(body), text = currentRequestText(request.messages)
    if (text.includes('Create an executable plan')) return reply(JSON.stringify({ tasks: [
      { id: 'plan', kind: 'edit', goal: 'Write docs/plans/feature.md', check: 'Concrete plan saved', criterionIds: ids, dependsOn: [] },
      { id: 'implement', kind: 'edit', goal: 'Create feature.txt', check: 'Implementation saved', criterionIds: ids, dependsOn: ['plan'] },
    ] }))
    if (text.includes('Verify ONLY the active taskController stage')) {
      const refs = request.messages.filter((message: any) => message.name === 'results').flatMap((message: any) => JSON.parse(message.content)).map((item: any) => item.id)
      return reply(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'File saved; whole-plan review remains authoritative.' }))
    }
    work++
    if (work === 1) return reply({ content: '', tool_calls: [{ id: 'save-plan', function: { name: 'plan_write', arguments: JSON.stringify({ path: 'docs/plans/feature.md', content: '# Plan\nP1: no authorized mechanism exists.' }) } }] })
    return reply('Plan saved; prerequisite remains blocked.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, taskController: true, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: objective })
    for await (const event of run.events) expect(event.type).not.toBe('waiting')
    const outcome = await run.outcome()
    expect(outcome.text).toContain('PLAN_REVIEW_REQUIRED')
    expect(outcome.text).not.toContain('NO_PROGRESS')
    expect(await run.taskOutcome()).toMatchObject({ status: 'incomplete' })
    expect(reviewed).toBe(1)
    await expect(readFile(join(cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})
