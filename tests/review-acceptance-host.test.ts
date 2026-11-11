import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { consistentPlanReview, planReviewRequest } from './helpers/plan-review-provider.js'
import { suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
it('never lets a final narrative pass an unresolved required plan review and reuses unchanged findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-review-acceptance-'))
  let work = 0, reviews = 0
  const reply = (message: object) => Response.json({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] })
  const plan = '# Saved plan\nChange result.txt and validate it.\nRequired validation is intentionally missing.\n'
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = String(init.body), request = JSON.parse(body)
    if (planReviewRequest(body)) {
      reviews++
      const result = JSON.parse(consistentPlanReview(body)!.content)
      result.checks.find((c: any) => c.area === 'validation').status = 'failed'
      result.checks.find((c: any) => c.area === 'validation').reason = 'Required validation is missing.'
      return reply({ content: JSON.stringify(result) })
    }
    if (body.includes('Assess whether the candidate')) return reply({ content: JSON.stringify({ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: suppliedRequestResults(request).map(r => r.id), rationale: 'The narrative says the plan is finished.' }] }) })
    work++
    if (work <= 2) return reply({ tool_calls: [{ id: `call-${work}`, function: { name: work === 1 ? 'plan_write' : 'plan_review', arguments: JSON.stringify(work === 1 ? { path: 'docs/plans/fix.md', content: plan } : { path: 'docs/plans/fix.md' }) } }] })
    return reply({ content: 'The saved plan is complete and ready.' })
  }))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', maxContextTokens: 128000 }, taskController: false, approvalMode: 'auto', maxModelCalls: 16 })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '先把修改 result.txt 的方案保存到 docs/plans/fix.md，复核通过并确认后再实施。' })
    for await (const _event of run.events) { /* no execution approval */ }
    await run.outcome()
    const saved = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'outcome.json'), 'utf8'))
    expect(saved.taskOutcome.status).toBe('incomplete')
    expect(saved.taskOutcome.reviewStatus).toBe('needs_work')
    expect(saved.taskOutcome.blockers.some((b: any) => b.code === 'PLAN_REVIEW_VALIDATION')).toBe(true)
    expect(reviews).toBe(1)
    expect(await readFile(join(root, 'docs/plans/fix.md'), 'utf8')).toBe(plan)
    await expect(readFile(join(root, 'result.txt'))).rejects.toThrow()
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not accept a coding claim supported only by the candidate result itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-review-code-proof-'))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: false, mockResponse: 'Implemented result.ts and all tests passed.', mockTaskAssessments: [{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'The candidate says it was implemented.' }] }] })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '修改 result.ts，实现输入验证并保存代码。' })
    for await (const _event of run.events) { /* drain */ }
    await run.outcome()
    const saved = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'outcome.json'), 'utf8'))
    expect(saved.taskOutcome.status).not.toBe('accepted')
    await expect(readFile(join(root, 'result.ts'))).rejects.toThrow()
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
