import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost, validateAskReply } from '../packages/server/src/index.js'
import { explicitPlanDecision, PLAN_CONFIRMATION_PENDING } from '../packages/server/src/plan-confirmation.js'
import { initialController, unmetGoalCanChangeApproach } from '../packages/server/src/task-controller/state.js'
import { consistentPlanReview, planReviewRequest } from './helpers/plan-review-provider.js'

afterEach(() => vi.unstubAllGlobals())
it.each(['input', 'choice', 'multi'])('accepts an explicit dismissal without a fabricated %s answer', type => {
  expect(() => validateAskReply({ kind: 'ask', type, options: ['A'], min: 1 }, { dismissed: true })).not.toThrow()
  for (const value of [{ dismissed: false }, { dismissed: true, value: 'A' }, { dismissed: true, text: 'execute' }]) {
    expect(() => validateAskReply({ kind: 'ask', type, options: ['A'] }, value)).toThrow('ASK_RESPONSE_INVALID:dismissed')
  }
})
it('treats closing execution confirmation as deferred without a denial that can be replanned', () => {
  expect(explicitPlanDecision({ type: 'choice', options: [{ value: 'defer', label: '暂不执行' }, { value: 'execute', label: '执行' }] }, { dismissed: true })).toBe('deferred')
  expect(PLAN_CONFIRMATION_PENDING.startsWith('APPROVAL_DENIED')).toBe(false)
  const state = initialController(32)
  state.tasks = [{ id: 'implement', goal: 'Implement the saved plan', criterionIds: ['c1'], dependsOn: [], status: 'blocked', attempts: 0, evidenceRefs: [], note: PLAN_CONFIRMATION_PENDING }]
  expect(unmetGoalCanChangeApproach(state)).toBe(false)
})

it('previews a hash-bound plan from a cold reader while its run is waiting, and dismissal grants no execution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-plan-preview-')), dataDir = join(cwd, '.data'), path = 'docs/plans/feature.md'
  const content = '# Feature plan\n\nCreate feature.txt only after explicit approval.\n'
  let turns = 0, previewed = false
  const reply = (message: unknown) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: typeof message === 'object' ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, args: object) => reply({ content: '', tool_calls: [{ id: `tool-${turns}`, function: { name, arguments: JSON.stringify(args) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const text = String(init.body)
    if (planReviewRequest(text)) return reply(consistentPlanReview(text)!)
    if (text.includes('You are the Pulse safety reviewer')) return reply('APPROVE')
    if (++turns === 1) return tool('plan_write', { path, content })
    if (turns === 2) return tool('ask_input', { prompt: '计划已经保存，请提供反馈。' })
    if (turns === 3) { expect(text).toContain('dismissed'); expect(text).toContain('No answer or permission was supplied'); return tool('fs_write', { path: 'feature.txt', content: 'must not execute' }) }
    return reply('用户未作答，计划没有执行。')
  }))
  const options = { cwd, dataDir, taskController: false, provider: { provider: 'openai-compatible' as const, defaultModel: 'fixture' }, approvalMode: 'auto' as const, jarvis: { enabled: false }, maxModelCalls: 20 }
  const host = createLocalHost(options), reader = createLocalHost({ cwd, dataDir, jarvis: { enabled: false } })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: `先把方案写到 ${path}，确认后再实现 feature.txt。` })
    const events: unknown[] = []
    for await (const event of run.events) { events.push(event); if (event.type === 'waiting') {
      const interaction = (await run.pendingInteractions()).find(item => item.kind === 'ask')!
      expect(interaction).toBeDefined()
      expect(await reader.listArtifacts(conversation.id)).toEqual([])
      expect((await reader.readArtifact(conversation.id, path, run.id)).content).toBe(content)
      expect((await reader.artifactFile(conversation.id, path, run.id)).hash).toMatch(/^[a-f0-9]{64}$/)
      await expect(reader.artifactFile(conversation.id, path, 'run-unrelated')).rejects.toThrow('ARTIFACT_NOT_FOUND')
      await writeFile(join(cwd, path), '# changed')
      await expect(reader.artifactFile(conversation.id, path, run.id)).rejects.toThrow('ARTIFACT_CHANGED')
      await writeFile(join(cwd, path), content)
      previewed = true
      await run.reply(interaction.items[0]!.effectId, { dismissed: true })
    }
    }
    const outcome = await run.outcome()
    expect(previewed, JSON.stringify({ turns, outcome, events: events.filter((e: any) => ['observation', 'complete', 'status'].includes(e.type)).slice(-8) })).toBe(true)
    await expect(readFile(join(cwd, 'feature.txt'))).rejects.toThrow()
  } finally { await host.close(); await reader.close(); await rm(cwd, { recursive: true, force: true }) }
})
