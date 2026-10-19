import { consistentPlanReview } from './helpers/plan-review-provider.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { PulseRuntime, defineLaneProgram, confirmedInteractionSurface, interactionIdentity } from '@hunterzhu/pulse-runtime'
import { StagedEditor } from '../packages/server/src/editing.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { createBuiltinSkillCapabilityPack } from '../packages/server/src/builtin-skills.js'
import { planConfirmationOptions } from '../packages/server/src/plan-confirmation.js'

const roots: string[] = []
const root = async () => { const path = await mkdtemp(join(tmpdir(), 'pulse-boundary-repair-')); roots.push(path); return path }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const tools = (name: string, input: unknown) => ({ finishReason: 'tool_calls', toolCalls: [{ name, input }] })
const finalOptions = [{ label: '暂不执行', value: 'hold' }, { label: '执行', value: 'execute' }]

describe('durable draft ownership and receipts', () => {
  it('isolates independent tasks while allowing the same owner to resume by normalized path', async () => {
    const files = new FilesystemTool(await root())
    const a = await new StagedEditor(files, 'run-A').execute({ operation: 'begin', path: 'report.md', content: 'Customer A' })
    const b = await new StagedEditor(files, 'run-B').execute({ operation: 'begin', path: './report.md', content: 'Customer B' })
    expect(b.draftId).not.toBe(a.draftId); expect(b.tail).toBe('Customer B')
    expect(await new StagedEditor(files, 'run-A').execute({ operation: 'begin', path: './report.md', content: 'do not reset' })).toEqual(a)
    await expect(new StagedEditor(files, 'run-B').execute({ operation: 'inspect', draftId: a.draftId })).rejects.toMatchObject({ code: 'DRAFT_OWNER_CONFLICT' })
  })
  it('recovers an unindexed draft after an injected index crash, without guessing by time', async () => {
    const files = new FilesystemTool(await root()), write = files.writeIfUnchanged.bind(files)
    files.writeIfUnchanged = async (...args) => { if (args[0].startsWith('.pulse/draft-targets/')) throw Object.assign(new Error('disk interrupted'), { code: 'INJECTED_CRASH' }); return write(...args) }
    await expect(new StagedEditor(files, 'same-run').execute({ operation: 'begin', path: 'notes.md', content: 'durable original' })).rejects.toMatchObject({ code: 'INJECTED_CRASH' })
    files.writeIfUnchanged = write
    const recovered = await new StagedEditor(files, 'same-run').execute({ operation: 'begin', path: 'notes.md', content: 'replacement' })
    expect(recovered.tail).toBe('durable original')
    expect(await readdir(join(files.root, '.pulse/drafts'))).toHaveLength(1)
  })
  it('concurrent begin creates one recoverable draft, preserving the winning content', async () => {
    const files = new FilesystemTool(await root())
    const receipts = await Promise.all(Array.from({ length: 4 }, (_, i) => new StagedEditor(files, 'one-run').execute({ operation: 'begin', path: 'report.md', content: `writer ${i}` })))
    expect(new Set(receipts.map(r => r.draftId)).size).toBe(1)
    expect(new Set(receipts.map(r => r.tail)).size).toBe(1)
    expect(await readdir(join(files.root, '.pulse/drafts'))).toHaveLength(1)
    await expect(files.read('report.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['changed', 'removed', 'unchanged'])('validates an idempotent commit against the current target (%s)', async mode => {
    const files = new FilesystemTool(await root()), editor = new StagedEditor(files, 'run')
    const begin = await editor.execute({ operation: 'begin', path: 'note.txt', content: 'original' })
    const receipt = await editor.execute({ operation: 'commit', draftId: begin.draftId, revision: begin.revision, expectedBytes: begin.bytes })
    if (mode === 'changed') await writeFile(join(files.root, 'note.txt'), 'user edits')
    if (mode === 'removed') await rm(join(files.root, 'note.txt'))
    const again = editor.execute({ operation: 'commit', draftId: receipt.draftId, revision: receipt.revision, expectedBytes: receipt.bytes })
    if (mode === 'unchanged') expect(await again).toEqual(receipt)
    else { await expect(again).rejects.toMatchObject({ code: 'DRAFT_TARGET_CHANGED' }); if (mode === 'changed') expect(await files.read('note.txt')).toBe('user edits') }
  })
})

describe('progress and decision identity', () => {
  it.each(['fs.apply_patch', 'fs.apply_patches'])('stops varying no-op %s requests at four rounds', async name => {
    let calls = 0, edits = 0
    const program = defineLaneProgram({ id: 'noop', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'fix config', maxTurns: 16, onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'tool') { edits++; return { value: { path: 'config', hash: 'same' } } }
      calls++; const pair = { find: `line ${calls}`, replace: `line ${calls}` }
      return { value: tools(name, { path: 'config', ...(name === 'fs.apply_patch' ? pair : { patches: [pair, { find: 'other', replace: 'other' }] }) }) }
    } })
    const { agentId } = runtime.createAgent('fix config', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
    expect(calls).toBe(4); expect(edits).toBe(4)
  })
  it('permits new options under the same prompt and blocks the repeated full decision', async () => {
    let calls = 0, questions = 0
    const program = defineLaneProgram({ id: 'questions', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'diagnose', maxTurns: 12, onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'human') { questions++; return { value: { value: 'A' } } }
      calls++; return { value: tools('ask.choice', { prompt: '下一步怎么处理？', options: calls === 1 ? [{ label: '先定位故障', value: 'A' }, { label: '先回滚', value: 'B' }] : [{ label: '补回归测试', value: 'A' }, { label: '补文档', value: 'B' }] }) }
    } })
    const { agentId } = runtime.createAgent('two decisions', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
    expect(questions).toBe(2)
  })
  it.each([true, false])('blocks report-layout paraphrases (explicit identity=%s)', async typed => {
    let calls = 0, questions = 0
    const program = defineLaneProgram({ id: 'paraphrases', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'decide layout once', maxTurns: 12, onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'human') { questions++; return { value: { value: 'A' } } }
      calls++; return { value: tools('ask.choice', { prompt: ['报告如何组织？', '你希望报告采用什么结构？', '报告文件应该怎样拆分？'][Math.min(calls - 1, 2)], options: [{ label: '每例独立报告加汇总', value: 'A' }, { label: '单报告', value: 'B' }], ...(typed ? { decisionId: 'report-layout', decisionScope: 'requirements' } : {}) }) }
    } })
    const { agentId } = runtime.createAgent('one layout decision', program)
    expect(await runtime.start(agentId).outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
    expect(questions).toBe(1); expect(calls).toBe(3)
  })
  it('permits one explicit user revision and then blocks unchanged repeats again', async () => {
    let models = 0, questions = 0
    let session: ReturnType<PulseRuntime['start']>
    const program = defineLaneProgram({ id: 'user-revision', version: '1' }, b => b.addReActLoopStep('work', { instruction: 'resolve layout', maxTurns: 12, onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ effectExecutor: async effect => {
      if (effect.kind === 'human') { questions++; return { value: { value: questions === 1 ? 'A' : 'B' } } }
      models++
      if (models === 2) await session.submitHumanInput('revision-1', { command: 'steer', text: '我改变决定，请重新确认报告布局。' })
      return { value: tools('ask.choice', { prompt: '报告如何组织？', decisionId: 'layout', options: [{ label: '独立报告', value: 'A' }, { label: '单报告', value: 'B' }] }) }
    } })
    const { agentId } = runtime.createAgent('decide report layout', program)
    session = runtime.start(agentId)
    expect(await session.outcome()).toMatchObject({ status: 'failed', error: { code: 'NO_PROGRESS' } })
    expect(questions, JSON.stringify({models,inputs:[...runtime.state.humanInputs.values()],lanes:[...runtime.state.lanes.values()].map(l=>({pending:l.pendingHumanInputs})),effects:[...runtime.state.effects.values()].map(e=>({kind:e.kind,key:e.key}))})).toBe(2)
    expect(models).toBe(4)
    const answers = [...runtime.state.effects.values()].filter(e => e.kind === 'human').map(e => runtime.state.results.get(e.outcome!.resultRef!)!.value)
    expect(answers).toEqual([{ value: 'A' }, { value: 'B' }])
  })
  it('distinguishes generic choices, stages, ask types and new alternatives', () => {
    const identity = (prompt: string, more = {}) => interactionIdentity('ask.choice', { prompt, options: ['A', 'B'], ...more })
    expect(identity('one').exact).not.toBe(identity('two').exact)
    expect(identity('one', { decisionScope: 's1' }).exact).not.toBe(identity('one', { decisionScope: 's2' }).exact)
    expect(identity('one').semantic).toBeUndefined()
    expect(planConfirmationOptions({ type: 'multi', options: finalOptions })).toBeUndefined()
    expect(identity('one', { decisionId: 'stable' }).semantic).toBe(identity('changed prompt', { decisionId: 'stable' }).semantic)
  })
  it('bounds the surface of 30 long answers, preserves exact source refs and marks excerpts', async () => {
    let calls = 0, questions = 0, maxConversationBytes = 0
    const answer = '保留原始证据与失败状态，禁止自动执行。'.repeat(80)
    const program = defineLaneProgram({ id: 'long-interview', version: '1', historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 2, instruction: 'retain decisions' } }, b => b.addReActLoopStep('work', { instruction: 'clarify', maxTurns: 64, onFinish: () => ({ complete: {} }) }))
    const runtime = new PulseRuntime({ historySoftTokens: 800, historyHardTokens: 8000, effectExecutor: async effect => {
      if (effect.kind === 'human') { questions++; return { value: { text: answer } } }
      if ((effect.input as any).task === 'summarize') return { value: { text: 'Earlier answers retained in exact ResultRefs.' } }
      const bytes = Buffer.byteLength(JSON.stringify((effect.input as any).inputs?.conversation ?? [])); maxConversationBytes = Math.max(maxConversationBytes, bytes)
      calls++; return { value: calls <= 30 ? tools('ask.input', { prompt: `独立需求${calls}`, decisionId: `requirement-${calls}` }) : { text: 'done' } }
    } })
    const { agentId } = runtime.createAgent('30 decisions', program)
    const outcome = await runtime.start(agentId).outcome()
    expect(outcome, JSON.stringify({ outcome, calls, questions, maxConversationBytes })).toMatchObject({ status: 'succeeded' })
    expect(questions).toBe(30); expect(maxConversationBytes).toBeLessThan(10000)
    const human = [...runtime.state.effects.values()].filter(e => e.kind === 'human')
    expect(human.every(e => (runtime.state.results.get(e.outcome!.resultRef!)!.value as any).text === answer)).toBe(true)
    const lane = [...runtime.state.lanes.values()].find(l => l.resume.locals && JSON.stringify(l.resume.locals).includes('workConfirmedAnswers'))!
    const decisions = (lane.resume.locals as any).$sdk.workConfirmedAnswers
    expect(decisions).toHaveLength(30)
    expect(decisions[0]).toMatchObject({ answer: { incomplete: true }, source: 'interaction_reply', resultRef: human[0]!.outcome!.resultRef })
    expect(Buffer.byteLength(JSON.stringify(confirmedInteractionSurface(decisions)))).toBeLessThan(9000)
    const hundred = Array.from({ length: 100 }, (_, i) => ({ ...decisions[i % decisions.length], resultRef: `result-${i}` }))
    expect(Buffer.byteLength(JSON.stringify(confirmedInteractionSurface(hundred)))).toBeLessThan(9000)
    expect((confirmedInteractionSurface(hundred) as any).total).toBe(100)
  }, 60000)
})

async function scenario(sequence: any[], onWait: (r: any) => Promise<void>) {
  const cwd = await root(); let calls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const review = consistentPlanReview(String(init.body))
    if (review) return new Response(JSON.stringify({ choices: [{ message: review, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    const message = sequence[calls++] ?? { content: 'done' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), logDir: join(cwd, 'logs'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16, taskController: false, capabilityPacks: [createBuiltinSkillCapabilityPack()], enabledCapabilityPacks: ['builtin-skills'] })
  try {
    const conversation = await host.createConversation(), run = await host.sendMessage(conversation.id, { text: '/grill-and-plan 保存计划、预览，确认后再实施' })
    for await (const event of run.events) if (event.type === 'waiting') {
      const pending = await run.pendingInteractions(); await onWait({ cwd, host, run, conversation, item: pending[0]!.items[0]!, calls })
    }
    return { cwd, host, run, calls, outcome: await run.outcome() }
  } finally { await host.close() }
}
const call = (name: string, input: unknown) => ({ content: '', tool_calls: [{ id: 'offline-call', function: { name, arguments: JSON.stringify(input) } }] })
const plan = call('plan_write', { path: 'docs/plans/feature.md', content: '# Plan\nImplement a greeting.' })
const confirm = call('ask_choice', { prompt: '计划已预览，是否执行？', options: finalOptions })
const implement = call('fs_write', { path: 'feature.txt', content: 'implementation' })
describe('concrete plan authorization', () => {
  it('blocks the execution question itself when the model skipped persistence/whole-plan review', async () => {
    const result = await scenario([confirm, implement], async () => { throw new Error('An unreviewed plan must not offer execution') })
    await expect(readFile(join(result.cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.calls).toBeLessThanOrEqual(4)
  })
  it('requires fresh explicit confirmation after external plan change', async () => {
    const result = await scenario([plan, confirm, implement], async ({ cwd, host, run, conversation, item }) => {
      const changed = '# Changed scope\nImplement a different greeting.'
      await writeFile(join(cwd, 'docs/plans/feature.md'), changed)
      await expect(run.reply(item.effectId, { value: 'execute' })).rejects.toMatchObject({ code: 'PLAN_CHANGED_RECONFIRM_REQUIRED' })
      await expect(readFile(join(cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await host.getConversationMessages(conversation.id)).some((m: any) => m.text === changed)).toBe(true)
      await expect(run.reply(item.effectId, { value: 'execute' })).rejects.toMatchObject({ code: 'PLAN_REVIEW_REQUIRED' })
      await run.reply(item.effectId, { value: 'hold' })
    })
    await expect(readFile(join(result.cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('revokes authorization when a plan changes after the reply but before a write', async () => {
    const result = await scenario([plan, confirm, implement], async ({ cwd, run, item }) => {
      // The Host guard independently re-hashes before every implementation operation.
      await run.reply(item.effectId, { value: 'execute' })
      await writeFile(join(cwd, 'docs/plans/feature.md'), '# Changed immediately after confirmation')
    })
    await expect(readFile(join(result.cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('allows the identical final question for a newly saved plan version, requiring a second approval', async () => {
    let questions = 0
    const result = await scenario([plan, confirm, call('fs_apply_patch', { path: 'docs/plans/feature.md', find: 'a greeting', replace: 'a revised greeting' }), confirm, implement], async ({ run, item }) => {
      questions++; await run.reply(item.effectId, { value: 'execute' })
    })
    expect(questions, JSON.stringify({calls:result.calls,outcome:result.outcome})).toBe(2)
    expect(await readFile(join(result.cwd, 'feature.txt'), 'utf8')).toBe('implementation')
  })
  it('rejects missing plans without consuming the pending decision', async () => {
    await scenario([plan, confirm], async ({ cwd, run, item }) => {
      await rm(join(cwd, 'docs/plans/feature.md'))
      await expect(run.reply(item.effectId, { value: 'execute' })).rejects.toMatchObject({ code: 'PLAN_CHANGED_RECONFIRM_REQUIRED' })
      expect((await run.pendingInteractions())[0].items[0].effectId).toBe(item.effectId)
      await run.reply(item.effectId, { value: 'hold' })
    })
  })
  it.each(['执行（仅查看，不实施）', '执行（不实施）', '执行（仅查看）', '执行（取消）'])('never opens a gate from contradictory label %s', async label => {
    expect(planConfirmationOptions({ options: [{ label: '暂不执行（默认）', value: 'hold' }, { label, value: 'execute' }] })).toBeUndefined()
    const result = await scenario([plan, call('ask_choice', { prompt: '只查看？', options: [{ label: '暂不执行（默认）', value: 'hold' }, { label, value: 'execute' }] }), implement], async ({ run, item }) => { await run.reply(item.effectId, { value: 'execute' }) })
    await expect(readFile(join(result.cwd, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
