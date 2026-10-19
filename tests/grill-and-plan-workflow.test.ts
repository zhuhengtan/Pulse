import { consistentPlanReview } from './helpers/plan-review-provider.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '../packages/server/src/index.js'
import { createBuiltinSkillCapabilityPack } from '../packages/server/src/builtin-skills.js'

afterEach(() => vi.unstubAllGlobals())

it.each([['暂不执行', false], ['执行', false], ['暂不执行', true], ['执行', true]] as const)('preserves the interview, long plan and %s choice across a cold restore (native=%s)', async (choice, native) => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-grill-workflow-'))
  await mkdir(join(root, 'docs/plans'), { recursive: true })
  await writeFile(join(root, 'README.md'), 'Implement a greeting module. Preserve other files.')
  await writeFile(join(root, 'docs/plans/greet.md'), '# Existing user plan\n')
  const plan = '# Greeting plan\n\n' + '根据当前项目实现问候函数，保留已有文档，验证输入边界。\n'.repeat(100)
  let calls = 0, story = 0
  const messages: string[] = []
  const finalOptions = native ? [{ label: '暂不执行（默认，保留计划）', value: 'hold' }, { label: '执行（开始实施）', value: 'execute' }] : ['暂不执行', '执行']
  const tool = (name: string, input: unknown, content = '') => ({ content, tool_calls: [{ id: `call-${calls}`, function: { name, arguments: JSON.stringify(input) } }] })
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    calls++
    messages.push(String(options.body))
    const review = consistentPlanReview(String(options.body))
    if (review) return new Response(JSON.stringify({ choices: [{ message: review, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    if (String(options.body).includes('Summarize the older conversation and tool history')) return new Response(JSON.stringify({ choices: [{ message: { content: 'The project was read, interview answered, existing plan preserved and new plan saved. Final execution confirmation is pending.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    story++
    const sequence = [
      () => tool('fs_read', { path: 'README.md' }),
      () => tool('ask_input', { prompt: '名字空白时希望返回什么？' }),
      () => tool('fs_read', { path: 'docs/plans/greet.md' }),
      () => tool('ask_choice', { prompt: 'greet.md 已存在，是否换个名字保存？', options: ['换个名字', '停止'] }),
      () => tool('plan_write', { path: 'docs/plans/greet-v2.md', content: plan }),
      () => tool('ask_choice', { prompt: '计划已预览，是否执行？', options: finalOptions }, plan),
      () => choice === '执行' ? tool('fs_write', { path: 'greet.mjs', content: 'export const greet = name => `你好，${String(name ?? "").trim() || "访客"}`\n' }) : { content: '计划已保存，暂不执行。' },
    ]
    const message = sequence[story - 1]?.() ?? { content: '完成本次操作。' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }))
  const options = { cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, approvalMode: 'auto' as const, maxModelCalls: 16, capabilityPacks: [createBuiltinSkillCapabilityPack()], enabledCapabilityPacks: ['builtin-skills'] }
  const first = createLocalHost(options)
  let second: ReturnType<typeof createLocalHost> | undefined
  try {
    const conversation = await first.createConversation()
    const run = await first.sendMessage(conversation.id, { text: '/grill-and-plan 根据项目需求生成问候模块计划，每次只问一个问题，最终确认前不实施' })
    let waiting: Awaited<ReturnType<typeof run.pendingInteractions>> = []
    const previews: string[] = []
    for await (const event of run.events) {
      if (event.type === 'text' && typeof event.data === 'string') previews.push(event.data)
      if (event.type !== 'waiting') continue
      waiting = await run.pendingInteractions()
      const item = waiting[0]!.items[0]!
      if (story === 2) await run.reply(item.effectId, { text: '你好，访客' })
      else if (story === 4) await run.reply(item.effectId, { value: '换个名字' })
      else break
    }
    expect(story).toBe(6)
    expect(Buffer.byteLength(plan)).toBeGreaterThan(5000)
    expect(await readFile(join(root, 'docs/plans/greet-v2.md'), 'utf8')).toBe(plan)
    expect(await readFile(join(root, 'docs/plans/greet.md'), 'utf8')).toBe('# Existing user plan\n')
    expect(waiting[0]!.items[0]!.input.options).toEqual(native ? finalOptions : [{ label: '暂不执行', value: '暂不执行' }, { label: '执行', value: '执行' }])
    expect(messages.some(text => text.includes('Confirmed interaction data') && text.includes('selectedLabel') && text.includes('换个名字'))).toBe(true)
    expect(previews.some(text => text.includes(plan))).toBe(true)
    await expect(readFile(join(root, 'greet.mjs'), 'utf8')).rejects.toThrow()
    const runtime = (first as any).active.get(run.id).runtime
    const beforeRestore = calls
    runtime.cancelAgent = () => {}
    await first.close()
    second = createLocalHost({ ...options, maxModelCalls: 256 })
    const resumed = await second.resumeRun(conversation.id)
    expect(resumed.id).toBe(run.id)
    expect(await resumed.pendingInteractions()).toEqual(waiting)
    expect(calls).toBe(beforeRestore)
    await expect(readFile(join(root, 'greet.mjs'), 'utf8')).rejects.toThrow()
    await resumed.reply(waiting[0]!.items[0]!.effectId, { value: native ? choice === '执行' ? 'execute' : 'hold' : choice })
    await resumed.outcome()
    if (choice === '暂不执行') expect(calls).toBe(beforeRestore)
    else expect(messages.slice(beforeRestore).some(text => text.includes('Confirmed interaction data') && text.includes('换个名字'))).toBe(true)
    if (choice === '执行') expect(await readFile(join(root, 'greet.mjs'), 'utf8')).toContain('export const greet')
    else await expect(readFile(join(root, 'greet.mjs'), 'utf8')).rejects.toThrow()
    const ledger = JSON.parse(await readFile(join(root, 'data/conversations', conversation.id, 'runs', run.id, 'model-budget.json'), 'utf8'))
    expect(ledger.limit).toBe(16); expect(ledger.used).toBe(calls)
  } finally { await first.close(); await second?.close(); await rm(root, { recursive: true, force: true }) }
})
