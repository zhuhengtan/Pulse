import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { PulseRuntime, type JsonValue } from '@hunterzhu/pulse-runtime'
import { cachedCompletionReply, completionFilePaths, completionUserRequest, composeCompletionReply, completionReplyPrompt, completionReplySystem, settleFinalReply, writeCompletionReport, type CompletionReplyInput } from '../packages/server/src/completion-reply.js'
import { controllerFromGlobal, fitPlanToBudget, initialController, mergePreparatoryStages, mergeRoutineVerificationStages, planSchema, validatePlan, type PlannedTask } from '../packages/server/src/task-controller/state.js'
import { buildTaskControllerProgram } from '../packages/server/src/task-controller/program.js'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'

const dirs: string[] = []
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }) })
const result = (text: string) => ({ text, toolCalls: [], finishReason: 'stop' as const })
function input(update: Partial<CompletionReplyInput> = {}): CompletionReplyInput {
  return { request: '修复停止后台的问题', status: 'accepted', completed: [{ goal: '修复后台停止', text: '停止后台后不会自动重启。' }], pending: [], checks: [{ status: 'passed', description: '停止回归', reason: '2 checks passed' }], files: ['/workspace/main.ts'], internalIds: ['stage-internal-42', 'criterion-1', 'result-123'], ...update }
}
it('returns a natural reply once, with real delivery links and no audit headings', async () => {
  const generate = vi.fn(async () => result('已修复后台停止后自动重启的问题，相关回归通过。'))
  const reply = await composeCompletionReply(input(), generate)
  expect(reply.source).toBe('model'); expect(generate).toHaveBeenCalledTimes(1)
  expect(reply.text).toContain('已修复'); expect(reply.text).toContain('[main.ts](</workspace/main.ts>)')
  expect(reply.text).not.toMatch(/stage-internal|criterion-1|result-123|逐项验收/)
  expect(completionReplySystem).toContain('untrusted source material')
  expect(completionReplySystem).toContain('Do not invoke tools')
})
it.each(['incomplete','unverifiable','failed'] as const)('keeps %s truthful even if the composer claims everything passed', async status => {
  const facts = input({ status, pending: [{ description: '验证真实桌面行为', reason: '当前没有可用的桌面环境' }] })
  const before = structuredClone(facts)
  const reply = await composeCompletionReply(facts, async () => result('任务已完成，所有测试都已通过。'))
  expect(reply).toMatchObject({ source:'fallback', reason:'verdict-mismatch' })
  expect(reply.text).toContain('没有可用的桌面环境'); expect(reply.text).toContain('验证真实桌面行为')
  expect(facts).toEqual(before)
})
it('retains a genuine short explanation of partial completion', async () => {
  const reply = await composeCompletionReply(input({status:'incomplete',pending:[{description:'运行设备检查',reason:'设备未连接'}]}),async()=>result('代码已修复，设备未连接，真机行为仍待验证。'))
  expect(reply).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' }); expect(reply.text).toContain('设备未连接')
})
it('does not call a model after cancellation', async () => {
  const generate = vi.fn()
  const reply = await composeCompletionReply(input({status:'cancelled'}),generate)
  expect(generate).not.toHaveBeenCalled();expect(reply.text).toContain('任务已取消')
})
it.each(['', '✓ stage-internal-42: passed', 'criterion-1: passed', 'result-123', '任务逐项验收通过。'])('falls back without retrying invalid text: %s', async text => {
  const generate=vi.fn(async()=>result(text))
  expect((await composeCompletionReply(input(),generate)).source).toBe('fallback')
  expect(generate).toHaveBeenCalledTimes(1)
})
it('rejects tool requests and truncated outputs without a repair call', async () => {
  for(const invalid of [{...result('partial'),finishReason:'length' as const},{...result('execute'),toolCalls:[{name:'shell.exec',arguments:{command:'danger'}}]}]) {
    const generate=vi.fn(async()=>invalid as any)
    expect((await composeCompletionReply(input(),generate)).source).toBe('fallback');expect(generate).toHaveBeenCalledTimes(1)
  }
})
it('uses a short fallback when a coding-task summary turns into another long report', async () => {
  const reply=await composeCompletionReply(input(),async()=>result('修复工作已经完成，相关说明如下。'.repeat(100)))
  expect(reply).toMatchObject({source:'fallback',reason:'verbose-reply'})
  expect(reply.text.length).toBeLessThan(200)
})
it('preserves user-requested long prose and literal commit text rather than substituting an acknowledgement', async () => {
  const body='详细结论。'.repeat(1000)+'\n\nfix(runtime): retain the selected stage\n提交：abc1234'
  const facts=input({request:'请给出完整分析报告及提交信息',files:[],completed:[{goal:'报告',text:body}]})
  expect((await composeCompletionReply(facts)).text).toBe(body)
  expect((await composeCompletionReply(facts,async()=>result(body))).text).toBe(body)
  const omitted=await composeCompletionReply(facts,async()=>result('报告和提交说明已准备好。'))
  expect(omitted).toMatchObject({source:'fallback',reason:'delivery-omitted'});expect(omitted.text).toBe(body)
})
it('does not concatenate intermediate coding notes in a budget fallback without output files', async () => {
  const reply=await composeCompletionReply(input({files:[],completed:[{goal:'查找原因',text:'定位完成。'},{goal:'修复',text:'修改完成。'},{goal:'检查',text:'检查完成。'}]}))
  expect(reply.text).toBe('已完成这项任务。')
})
it('does not suppress stage when it is part of the user subject, identifier, or a file path', async () => {
  const text='stage-internal-42 的状态已修复，文件位于 /workspace/stage-internal-42.ts。'
  const facts=input({request:'修复 stage-internal-42 的状态',files:[]})
  expect((await composeCompletionReply(facts,async()=>result(text))).text).toBe(text)
  expect(completionReplyPrompt(input({completed:[],pending:[{description:'stage-internal-42 检查',reason:'criterion-1 受阻 result-123'}]}))).not.toMatch(/stage-internal-42|criterion-1|result-123/)
})
it('retains concrete commit hashes and source links when short model text omits them', async () => {
  const facts=input({completed:[{goal:'修改',text:'提交：abc1234\n参考：[接口文档](https://example.test/docs)'}]})
  for(const reply of [await composeCompletionReply(facts),await composeCompletionReply(facts,async()=>result('修复已完成。'))]) {
    expect(reply.text).toContain('abc1234');expect(reply.text).toContain('[接口文档](https://example.test/docs)')
  }
})
it('preserves whole supplied text when it cannot fit the optional composer request', async () => {
  const body='正文'.repeat(30_000),generate=vi.fn()
  expect((await composeCompletionReply(input({request:'输出完整正文',files:[],completed:[{goal:'正文',text:body}]}),generate)).text).toBe(body)
  expect(generate).not.toHaveBeenCalled()
})
it('caches one presentation attempt and final reply across concurrent readers and a cold reopening', async () => {
  const dir=await mkdtemp(join(tmpdir(),'pulse-final-cache-'));dirs.push(dir)
  const path=join(dir,'completion.json'),generate=vi.fn(async()=>result('停止后台的问题已修复。'))
  const [first,second]=await Promise.all([cachedCompletionReply(path,input(),generate),cachedCompletionReply(path,input(),generate)])
  expect(second).toEqual(first);expect(await cachedCompletionReply(path,input(),generate)).toEqual(first)
  expect(generate).toHaveBeenCalledTimes(1);expect(JSON.parse(await readFile(path,'utf8'))).toMatchObject({status:'complete',source:'model'})
  const marker=join(dir,'interrupted.json');await writeFile(marker,JSON.stringify({schemaVersion:1,status:'attempted'}))
  expect((await cachedCompletionReply(marker,input(),generate)).reason).toBe('already-attempted');expect(generate).toHaveBeenCalledTimes(1)
})
it('counts presentation in the original budget and uses a fallback when it is exhausted', async () => {
  const dir=await mkdtemp(join(tmpdir(),'pulse-final-budget-'));dirs.push(dir)
  const budget=await ModelAttemptBudget.open(join(dir,'budget.json'),3,1,{verificationReserve:2})
  await budget.reserve('final-verification')
  const generate=vi.fn(async()=>{await budget.reserve('completion-summary');return result('修复已完成。')})
  expect((await composeCompletionReply(input(),generate)).source).toBe('model')
  expect(budget.used).toBe(3);expect(budget.accounting.purposes?.['completion-summary']).toBe(1)
  expect((await composeCompletionReply(input(),generate)).source).toBe('fallback');expect(budget.used).toBe(3)
})
it('keeps all committed output links without treating read files, drafts or no-op edits as deliveries', () => {
  const results = new Map(), effects = new Map()
  for (const [ref,name,body] of [
    ['one','fs.write',{path:'nested/one.txt',hash:'a'}],
    ['two','fs.apply_patch',{path:'two.txt',changed:true}],
    ['read','fs.read',{path:'private-context.txt',hash:'b'}],
    ['draft','fs.stage',{path:'draft.txt',committed:false}],
    ['noop','fs.apply_patch',{path:'unchanged.txt',changed:false}],
    ['move','fs.move',{destination:'moved.txt'}],
    ['inplace','shell.exec',{code:0,fileChanges:{schemaVersion:1,operation:'in-place',scriptHash:'a'.repeat(64),entries:[{path:'nested/out.json',beforeHash:'b'.repeat(64),hash:'c'.repeat(64)}]}}],
    ['stdout','shell.exec',{code:0,stdout:'wrote /workspace/secret.txt > redirected.txt'}],
    ['redirect','shell.exec',{code:0,fileChanges:{schemaVersion:1,operation:'redirect',entries:[{path:'redirected.txt'}]}}],
  ] as const) {
    results.set(ref,{producer:{kind:'effect',id:ref},value:body})
    effects.set(ref,{kind:'tool',input:{name},outcome:{status:'succeeded'}})
  }
  const runtime={state:{results,effects}} as any
  expect(completionFilePaths(runtime,[...results.keys()],' /workspace'.trim())).toEqual(['/workspace/nested/one.txt','/workspace/two.txt','/workspace/moved.txt','/workspace/nested/out.json'])
})
it('keeps user follow-ups and plan feedback out of host recovery prompts', () => {
  const request = completionUserRequest('为什么后台会自己重启', ['请把超时改成 30 秒', 'Goal recovery 1: the original goal is not met. Keep every file already written. Fix only the failed check below.\nstage-internal-42: 修复后台 — blocked', 'PLAN_CONFIRMATION_PENDING: implementation stays unauthorized'])
  expect(request).toBe('为什么后台会自己重启\n请把超时改成 30 秒')
  expect(request).not.toMatch(/Goal recovery|\bFix\b|stage-internal-42|PLAN_CONFIRMATION_PENDING/)
})
it('does not drop an explanation or leak a stage id that exists only in host recovery text', async () => {
  const request = completionUserRequest('为什么后台会自己重启', ['Goal recovery 1: the original goal is not met. Fix only the failed check below.\nstage-internal-42: 修复后台 — blocked'])
  const facts = input({ request, files: [], status: 'incomplete', completed: [{ goal: '说明原因', text: '旧进程仍在，所以会再次拉起。' }], pending: [{ description: 'stage-internal-42 仍需核实', reason: '还没有桌面环境' }], internalIds: ['stage-internal-42', 's'] })
  const echoed = await composeCompletionReply(facts, async () => result('stage-internal-42 已修复，后台不会再重启。'))
  expect(echoed.source).toBe('fallback')
  expect(echoed.text).toContain('旧进程仍在')
  expect(echoed.text).not.toContain('stage-internal-42')
  const natural = await composeCompletionReply(facts, async () => result('旧进程仍在，所以会再次拉起。还没有桌面环境，所以这次没法复核。'))
  expect(natural).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(natural.text).toContain('旧进程仍在，所以会再次拉起。')
  const paraphrase = await composeCompletionReply(facts, async () => result('旧进程还在，所以后台会再次拉起，桌面环境还没法复核。'))
  expect(paraphrase.source).toBe('fallback')
  expect(paraphrase.text).toContain('旧进程仍在，所以会再次拉起。')
  expect(paraphrase.text).toContain('还没有桌面环境')
})
it('keeps a natural unverified explanation and still rejects an unqualified success claim', async () => {
  const facts = input({ status: 'incomplete', pending: [{ description: '验证真实桌面行为', reason: '当前没有可用的桌面环境' }] })
  const natural = await composeCompletionReply(facts, async () => result('后台逻辑已经改完。当前没有可用的桌面环境，所以这次不能确认真机行为。'))
  expect(natural).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(natural.text).toContain('当前没有可用的桌面环境')
  const claimed = await composeCompletionReply(facts, async () => result('所有检查都通过了。'))
  expect(claimed).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  const negated = await composeCompletionReply(facts, async () => result('没有全部通过。当前没有可用的桌面环境。'))
  expect(negated).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(negated.text).toContain('当前没有可用的桌面环境')
  const substituted = await composeCompletionReply(facts, async () => result('用途分析已完成，配置验证仍受阻，不能确认全部完成。'))
  expect(substituted).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(substituted.text).toContain('当前没有可用的桌面环境')
})
it('does not treat a short stage id as an internal token inside ordinary English', async () => {
  const text = "The script's parser now keeps the trailing quote."
  const facts = input({ request: 'Explain the script failure', files: [], status: 'accepted', completed: [{ goal: 'Explain', text }], pending: [], internalIds: ['s', 'a'] })
  const reply = await composeCompletionReply(facts, async () => result(text))
  expect(reply.source).toBe('model')
  expect(reply.text).toBe(text)
})
it('reuses a completed reply after the input fingerprint changes when the verdict still matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-final-reuse-')); dirs.push(dir)
  const path = join(dir, 'completion.json')
  const generate = vi.fn(async () => result('停止后台的问题已修复。'))
  const first = await cachedCompletionReply(path, input(), generate)
  const drifted = input({ files: ['/workspace/main.ts', '/workspace/extra.ts'], checks: [{ status: 'passed', description: '另一项回归', reason: 'ok' }] })
  const again = await cachedCompletionReply(path, drifted, generate)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(again.source).toBe('model')
  expect(again.text).toContain(first.text.split('\n')[0]!)
  expect(again.text).toContain('/workspace/extra.ts')
  const contradicted = await cachedCompletionReply(path, input({ status: 'incomplete', pending: [{ description: '验证真实桌面行为', reason: '当前没有可用的桌面环境' }] }), generate)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(contradicted).toMatchObject({ source: 'fallback', reason: 'stale-reply' })
  expect(contradicted.text).toContain('没有可用的桌面环境')
  expect(contradicted.text).not.toContain('已修复')
})
it('records an audit copy without throwing when the report path cannot be written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-final-report-')); dirs.push(dir)
  const report = join(dir, 'completion-report.json')
  expect(await writeCompletionReport(report, { schemaVersion: 1, text: 'audit' })).toBe(true)
  expect(JSON.parse(await readFile(report, 'utf8')).text).toBe('audit')
  expect(await writeCompletionReport(join(dir, 'missing', 'completion-report.json'), { schemaVersion: 1, text: 'kept' })).toBe(false)
})
const review = (update: Partial<CompletionReplyInput> = {}): CompletionReplyInput => ({ request: 'Explain how the parser works', status: 'accepted', completed: [{ goal: 'Explain parser', text: 'The parser reads the input and returns tokens.' }], pending: [], checks: [], files: [], internalIds: [], ...update })
it('keeps prose when a stage id is an ordinary word', async () => {
  const reply = await composeCompletionReply(review({ internalIds: ['read'], completed: [{ goal: 'Explain parser', text: 'First read the input, then return its tokens.' }] }))
  expect(reply.text).toContain('First read the input, then return its tokens.')
  expect(reply.text).not.toBe('The task is complete.')
  expect(reply).toMatchObject({ source: 'fallback', reason: 'unavailable' })
})
it('does not replace a requested draft with an acknowledgement that omits its content', async () => {
  const facts = review({ request: '起草项目介绍', completed: [{ goal: '起草介绍', text: 'Pulse 是本地任务助手，支持持久化任务与人工审批。' }] })
  const reply = await composeCompletionReply(facts, async () => result('项目介绍已准备好。'))
  expect(reply).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(reply.text).toContain('持久化')
  expect(reply.text).not.toBe('项目介绍已准备好。')
})
it('rejects a closure claim when the settled task is still incomplete', async () => {
  const facts = review({ status: 'incomplete', pending: [{ description: 'Deploy the app', reason: 'No deployment credentials' }] })
  const reply = await composeCompletionReply(facts, async () => result('The task is complete. No pending work remains.'))
  expect(reply).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(reply.text).toContain('No deployment credentials')
  expect(reply.text).not.toContain('No pending work remains')
})
it('does not reuse an unverified reply after the settled verdict becomes accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-final-accepted-')); dirs.push(dir)
  const path = join(dir, 'reply.json')
  const unverified = 'Implementation is complete; tests are still unverified. test runner unavailable'
  const generate = vi.fn(async () => result(unverified))
  const first = await cachedCompletionReply(path, review({ status: 'incomplete', completed: [{ goal: 'Fix parser', text: unverified }], pending: [{ description: 'Run tests', reason: 'test runner unavailable' }] }), generate)
  expect(first).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(first.text).toContain('test runner unavailable')
  const again = await cachedCompletionReply(path, review({ status: 'accepted', completed: [{ goal: 'Fix parser', text: 'Parser fixed, tests passed.' }] }))
  expect(generate).toHaveBeenCalledTimes(1)
  expect(again).toMatchObject({ source: 'fallback', reason: 'stale-reply' })
  expect(again.text).toContain('Parser fixed, tests passed.')
  expect(again.text).not.toContain('unverified')
})
it('publishes the current verdict when a stored final message still says the old one', async () => {
  const selected = '任务尚未完成，待完成或核实：验证停止行为。原因：环境不可用'
  const stored = '后台停止问题已修复。'
  expect(settleFinalReply(stored, selected)).toEqual({ text: selected, replaceStored: true })
  expect(settleFinalReply(selected, selected)).toEqual({ text: selected, replaceStored: false })
  const source = await readFile(new URL('../packages/server/src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('      if (text !== undefined) {', source.indexOf('text = (await cachedCompletionReply'))
  const end = source.indexOf('      const current =', start)
  const actual = source.slice(start, end).replace('.call<StoredMessage>(', '.call(')
  const execute = new Function('text', 'stages', 'runId', 'conversationId', 'randomUUID', `return (async () => { ${actual}; return text }).call(this)`) as (this: { conversationData: { call: (...args: unknown[]) => Promise<unknown> }; appendMessage: () => Promise<void> }, text: string, stages: unknown[], runId: string, conversationId: string, randomUUID: () => string) => Promise<string>
  const revised: unknown[] = []
  const host = {
    conversationData: { call: async (...args: unknown[]) => { if (args[0] === 'revise') revised.push(args[2]); return { text: stored } } },
    appendMessage: async () => { throw new Error('should not append') },
  }
  const published = await execute.call(host, selected, [{}], 'run-review', 'conversation-review', () => 'uuid')
  expect(published).toContain('环境不可用')
  expect(published).not.toContain('已修复')
  expect(revised).toEqual([{ text: selected }])
})
it('keeps the settled blocker when an incomplete reply claims completion or names a different issue', async () => {
  const facts = review({ request: 'Fix the deployment', status: 'incomplete', completed: [], pending: [{ description: 'Deploy', reason: 'Credentials missing' }] })
  const closed = await composeCompletionReply(facts, async () => result('Everything is done; there are no issues pending.'))
  expect(closed).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(closed.text).toContain('Credentials missing')
  expect(closed.text).not.toContain('no issues pending')
  const replaced = await composeCompletionReply(facts, async () => result('Implementation is complete; a minor UI polish is pending.'))
  expect(replaced).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(replaced.text).toContain('Credentials missing')
  expect(replaced.text).not.toContain('UI polish')
})
it('preserves the exact delivery, including numbers, wording, unfinished reports and other scripts', async () => {
  const numbers = '部署配置：端口 8080；超时 30 秒；重试 2 次。'
  const changed = await composeCompletionReply(review({ request: '输出完整正文', completed: [{ goal: '配置', text: numbers }] }), async () => result('部署配置：端口 80；超时 3 秒；重试 20 次。'))
  expect(changed).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(changed.text).toContain(numbers)
  expect(changed.text).not.toContain('重试 20 次')
  const commit = 'fix: preserve parser trailing quote'
  const trimmed = await composeCompletionReply(review({ request: 'Return the exact commit message verbatim', completed: [{ goal: 'commit message', text: commit }] }), async () => result('fix: preserve parser quote'))
  expect(trimmed).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(trimmed.text).toContain(commit)
  const arabic = 'هذا المشروع يساعد المستخدمين على تنظيم المهام وحفظ النتائج ومراجعة العمل بسهولة.'
  const acknowledgement = await composeCompletionReply(review({ request: 'Write an Arabic introduction for the project', completed: [{ goal: 'Introduction', text: arabic }] }), async () => result('The introduction is ready.'))
  expect(acknowledgement).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(acknowledgement.text).toContain(arabic)
  const report = '分析报告：后台重启来自遗留进程，解决方法是持久化退出标志。'
  const partial = await composeCompletionReply(review({ request: '输出完整分析报告，并说明尚未完成的验证', status: 'incomplete', completed: [{ goal: '报告', text: report }], pending: [{ description: '验证桌面', reason: '当前没有桌面' }] }), async () => result('当前没有桌面。部分分析完成，桌面验证受阻。'))
  expect(partial).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(partial.text).toContain(report)
  expect(partial.text).toContain('当前没有桌面')
})
it('does not reuse a cached reply after the delivered facts change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-final-facts-')); dirs.push(dir)
  const path = join(dir, 'reply.json')
  const previous = '部署配置：端口 8080；超时 30 秒；重试 2 次。'
  const current = '部署配置：端口 80；超时 3 秒；重试 20 次。'
  const generate = vi.fn(async () => result(previous))
  await cachedCompletionReply(path, review({ request: '输出完整正文', completed: [{ goal: '配置', text: previous }] }), generate)
  const selected = await cachedCompletionReply(path, review({ request: '输出完整正文', completed: [{ goal: '配置', text: current }] }))
  expect(generate).toHaveBeenCalledTimes(1)
  expect(selected).toMatchObject({ source: 'fallback', reason: 'stale-reply' })
  expect(selected.text).toContain(current)
  expect(selected.text).not.toContain('8080')
})
it('renders the settled blocker as current when a completion claim only quotes it as history', async () => {
  const facts = review({ request: 'Fix deployment', status: 'incomplete', completed: [], pending: [{ description: 'Deploy', reason: 'Credentials missing' }] })
  for (const text of ['Everything is done; there are no issues pending. Previously: Credentials missing.', 'All work is finished. Historical note: Credentials missing.']) {
    const reply = await composeCompletionReply(facts, async () => result(text))
    expect(reply).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
    expect(reply.text).toContain('Credentials missing')
    expect(reply.text).toContain('The task is not complete')
    expect(reply.text).not.toMatch(/Everything is done|All work is finished|Previously|Historical note/)
  }
  const empty = await composeCompletionReply(review({ request: 'Fix deployment', status: 'unverifiable', completed: [], pending: [] }), async () => result('Everything is done; there are no issues pending.'))
  expect(empty).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(empty.text).toContain('The task is not complete')
  expect(empty.text).not.toContain('Everything is done')
  const quoted = await composeCompletionReply(review({ request: '修复部署', status: 'failed', completed: [], pending: [{ description: '部署', reason: '凭据缺失' }] }), async () => result('此前记录为凭据缺失。现在全部完成，没有待处理事项。'))
  expect(quoted).toMatchObject({ source: 'fallback', reason: 'verdict-mismatch' })
  expect(quoted.text).toContain('凭据缺失')
  expect(quoted.text).not.toContain('全部完成')
})
it('rejects an extra instruction after the exact delivery and does not keep that instruction in cache', async () => {
  const body = '部署配置：端口 8080；超时 30 秒；重试 2 次。'
  const reply = await composeCompletionReply(review({ request: '输出最终配置报告', completed: [{ goal: '配置', text: body }] }), async () => result(`${body}\n最终请使用端口 80、超时 3 秒、重试 20 次。`))
  expect(reply).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(reply.text).toBe(body)
  const dir = await mkdtemp(join(tmpdir(), 'pulse-final-contradiction-')); dirs.push(dir)
  const path = join(dir, 'reply.json')
  const current = '最终配置：端口 80；超时 3 秒；重试 20 次。'
  const stale = `${current}\n实际部署请使用端口 8080、超时 30 秒、重试 2 次。`
  const generate = vi.fn(async () => result(stale))
  await cachedCompletionReply(path, review({ request: '输出最终配置报告', completed: [{ goal: '旧报告', text: stale }] }), generate)
  const selected = await cachedCompletionReply(path, review({ request: '输出最终配置报告', completed: [{ goal: '当前最终版', text: current }] }))
  expect(generate).toHaveBeenCalledTimes(1)
  expect(selected).toMatchObject({ source: 'fallback', reason: 'stale-reply' })
  expect(selected.text).toBe(current)
  expect(selected.text).not.toContain('8080')
})
it('keeps independent deliveries that share a label and only drops a delivery an explicit successor names', async () => {
  const billing = 'Service A: timeout 30. This service handles billing.'
  const search = 'Service B: timeout 3. This service handles search.'
  const separate = review({ request: '分别起草服务A和B的配置说明，保留两份完整正文', completed: [{ id: 'service-a', goal: '服务A独立交付', text: billing }, { id: 'service-b', goal: '服务B独立交付', text: search }] })
  const offline = await composeCompletionReply(separate)
  expect(offline.text).toContain(billing)
  expect(offline.text).toContain(search)
  expect(offline.text).toContain('服务A独立交付')
  const together = await composeCompletionReply(separate, async () => result(`${billing}\n\n${search}`))
  expect(together).toMatchObject({ source: 'model' })
  expect(together.text).toContain(billing)
  expect(together.text).toContain(search)
  const onlySearch = await composeCompletionReply(separate, async () => result(search))
  expect(onlySearch).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(onlySearch.text).toContain(billing)
  expect(onlySearch.text).toContain(search)
  const unitedStates = '最终发布地区：美国。'
  const germany = '最终发布地区：德国。'
  const unlabeled = review({ request: '起草地区报告，再复核并给出修订后的最终版', completed: [{ id: 'draft-region', goal: '初稿', text: unitedStates }, { id: 'final-region', goal: '复核并修订终稿', text: germany }] })
  const unresolved = await composeCompletionReply(unlabeled, async () => result(germany))
  expect(unresolved).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(unresolved.text).toContain(unitedStates)
  expect(unresolved.text).toContain(germany)
  expect(completionReplyPrompt(unlabeled)).not.toMatch(/draft-region|final-region/)
  const replaced = review({ request: '起草地区报告，再复核并给出修订后的最终版', completed: [{ id: 'draft-region', deliverableId: 'region-report', resultRef: 'result-draft', goal: '初稿', text: unitedStates }, { id: 'final-region', deliverableId: 'region-report', goal: '复核并修订终稿', text: germany, supersedes: ['result-draft'] }] })
  expect(await composeCompletionReply(replaced, async () => result(germany))).toMatchObject({ source: 'model', text: germany })
  const replacedOffline = await composeCompletionReply(replaced)
  expect(replacedOffline.text).toBe(germany)
  expect(replacedOffline.text).not.toContain(unitedStates)
  const first = '草案一：保留初版说明。'
  const second = '草案二：改写范围。'
  const third = '草案三：确定发布范围。'
  const chain = await composeCompletionReply(review({ request: '输出最终报告', completed: [{ id: 'v1', deliverableId: 'report', goal: '第一版', text: first }, { id: 'v2', deliverableId: 'report', goal: '第二版', text: second, supersedes: ['v1'] }, { id: 'v3', deliverableId: 'report', goal: '第三版', text: third, supersedes: ['v2'] }] }))
  expect(chain.text).toBe(third)
  const cycle = await composeCompletionReply(review({ request: '输出两份说明', completed: [{ id: 'left', deliverableId: 'note', goal: '左稿', text: first, supersedes: ['right'] }, { id: 'right', deliverableId: 'note', goal: '右稿', text: second, supersedes: ['left'] }] }))
  expect(cycle.text).toContain(first)
  expect(cycle.text).toContain(second)
  const reachable = await composeCompletionReply(review({ request: '输出说明', completed: [{ id: 'a', deliverableId: 'note', goal: 'A', text: '正文甲。', supersedes: ['b'] }, { id: 'b', deliverableId: 'note', goal: 'B', text: '正文乙。', supersedes: ['a'] }, { id: 'c', deliverableId: 'note', goal: 'C', text: '正文丙。', supersedes: ['a'] }] }))
  expect(reachable.text).toContain('正文乙。')
  expect(reachable.text).toContain('正文丙。')
  expect(reachable.text).not.toContain('正文甲。')
  const crossed = await composeCompletionReply(review({ request: '输出两份说明', completed: [{ id: 'alpha', deliverableId: 'one', goal: '甲', text: '服务甲说明。' }, { id: 'beta', deliverableId: 'two', goal: '乙', text: '服务乙说明。', supersedes: ['alpha'] }] }))
  expect(crossed.text).toContain('服务甲说明。')
  expect(crossed.text).toContain('服务乙说明。')
  const oldSource = '旧说明：[旧接口](https://example.test/old)'
  const newSource = '新说明：[新接口](https://example.test/new)'
  const sources = await composeCompletionReply(review({ request: '输出最终说明', completed: [{ id: 'old', deliverableId: 'doc', goal: '旧版', text: oldSource }, { id: 'current', deliverableId: 'doc', goal: '新版', text: newSource, supersedes: ['old'] }] }), async () => result(newSource))
  expect(sources).toMatchObject({ source: 'model', text: newSource })
  expect(sources.text).not.toContain('https://example.test/old')
})
it('rejects a contradictory instruction hidden in a link label and does not cache it', async () => {
  const body = '最终配置：端口 8080；超时 30 秒。'
  const sourceLink = '说明见 [接口文档](https://example.test/docs)。'
  const facts = review({ request: '输出完整配置正文', completed: [{ goal: '配置', text: body }] })
  const disguised = await composeCompletionReply(facts, async () => result(`${body}\n[最终请用端口 80、超时 3 秒](https://example.test/deploy)`))
  expect(disguised).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(disguised.text).toBe(body)
  expect(disguised.text).not.toContain('example.test')
  const changedLabel = await composeCompletionReply(review({ request: '输出完整说明', completed: [{ goal: '说明', text: sourceLink }] }), async () => result(`${sourceLink}\n[请改用另一套配置](https://example.test/docs)`))
  expect(changedLabel).toMatchObject({ source: 'fallback', reason: 'delivery-omitted' })
  expect(changedLabel.text).toBe(sourceLink)
  expect(changedLabel.text).not.toContain('另一套配置')
  const repeated = await composeCompletionReply(review({ request: '输出完整说明', completed: [{ goal: '说明', text: sourceLink }] }), async () => result(`${sourceLink}\n[接口文档](https://example.test/docs)`))
  expect(repeated.source).toBe('model')
  expect(repeated.text).toContain('[接口文档](https://example.test/docs)')
  const dir = await mkdtemp(join(tmpdir(), 'pulse-final-link-')); dirs.push(dir)
  const seeded = join(dir, 'seeded.json')
  const hidden = `${body}\n[最终请用端口 80、超时 3 秒](https://example.test/deploy)`
  await writeFile(seeded, JSON.stringify({ schemaVersion: 1, status: 'complete', source: 'model', inputHash: 'stale', text: hidden }))
  const selected = await cachedCompletionReply(seeded, facts)
  expect(selected).toMatchObject({ source: 'fallback', reason: 'stale-reply' })
  expect(selected.text).toBe(body)
  expect(selected.text).not.toContain('example.test')
  const generated = join(dir, 'generated.json')
  let calls = 0
  const billing = 'Service A: timeout 30. This service handles billing.'
  const search = 'Service B: timeout 3. This service handles search.'
  const combined = review({ request: '分别起草服务A和B的配置说明，保留两份完整正文', completed: [{ id: 'service-a', goal: '服务A', text: billing }, { id: 'service-b', goal: '服务B', text: search }] })
  const first = await cachedCompletionReply(generated, combined, async () => { calls += 1; return result(`${billing}\n\n${search}\n[请把服务A超时改成 3](https://example.test/override)`) })
  const again = await cachedCompletionReply(generated, combined)
  expect(calls).toBe(1)
  expect(first.text).toContain(billing)
  expect(first.text).toContain(search)
  expect(first.text).not.toContain('example.test')
  expect(again.text).toContain(billing)
  expect(again.text).not.toContain('override')
})
it('keeps an explicit replacement through the plan schema, restored controller, and host projection', async () => {
  const unitedStates = '最终发布地区：美国。'
  const germany = '最终发布地区：德国。'
  const plan = planSchema.parse({ tasks: [
    { id: 'draft', deliverableId: 'region-report', goal: '起草初稿', criterionIds: ['criterion-1'], dependsOn: [], check: '初稿已提供' },
    { id: 'final', deliverableId: 'region-report', goal: '复核并修订终稿', criterionIds: ['criterion-1'], dependsOn: ['draft'], check: '终稿正确', supersedes: ['draft'] },
  ] })
  expect(plan.tasks[1]?.supersedes).toEqual(['draft'])
  validatePlan(plan.tasks.map(task => ({ ...task })), ['criterion-1'])
  expect(() => validatePlan(plan.tasks.map(task => task.id === 'final' ? { ...task, deliverableId: 'other-report' } : { ...task }), ['criterion-1'])).toThrow('TASK_PLAN_SUPERSESSION_IDENTITY')
  expect(() => validatePlan(plan.tasks.map(task => task.id === 'final' ? { ...task, supersedes: ['missing'] } : { ...task }), ['criterion-1'])).toThrow('TASK_PLAN_UNKNOWN_SUPERSESSION')
  expect(() => validatePlan(plan.tasks.map(task => ({ ...task, supersedes: task.id === 'draft' ? ['final'] : ['draft'] })), ['criterion-1'])).toThrow('TASK_PLAN_SUPERSESSION_CYCLE')
  const state = initialController(20)
  state.tasks = plan.tasks.map(task => ({ ...task, status: 'passed', attempts: 1, evidenceRefs: [], candidateRef: task.id === 'draft' ? 'result-draft' : 'result-final' }))
  const restored = controllerFromGlobal(JSON.parse(JSON.stringify({ taskController: state })))
  expect(restored?.tasks[1]?.supersedes).toEqual(['draft'])
  expect(restored?.tasks[1]?.deliverableId).toBe('region-report')
  const source = await readFile(new URL('../packages/server/src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("tasks.filter(task => task.status === 'passed').map(task => {", source.indexOf('const input: CompletionReplyInput'))
  const end = source.indexOf('\n          pending:', start)
  const expression = source.slice(start, end).trim().replace(/,$/, '')
  const project = new Function('tasks', 'runtime', `return ${expression}`) as (this: { resultText: (runtime: unknown, ref: string) => string }, tasks: typeof restored.tasks, runtime: unknown) => CompletionReplyInput['completed']
  const bodies = new Map([['result-draft', unitedStates], ['result-final', germany]])
  const completed = project.call({ resultText: (_runtime, ref) => bodies.get(ref) ?? '' }, restored!.tasks, {})
  expect(completed[1]?.supersedes).toEqual(['draft'])
  const reply = await composeCompletionReply({ request: '起草地区报告，再复核并给出修订后的最终版，只交付终稿', status: 'accepted', completed, pending: [], checks: [], files: [], internalIds: [] }, async () => result(germany))
  expect(reply).toMatchObject({ source: 'model', text: germany })
  expect(reply.text).not.toContain(unitedStates)
  const dependencyOnly = project.call({ resultText: (_runtime, ref) => bodies.get(ref) ?? '' }, restored!.tasks.map(task => ({ ...task, supersedes: undefined })), {})
  const retained = await composeCompletionReply({ request: '起草地区报告，再复核并给出修订后的最终版，只交付终稿', status: 'accepted', completed: dependencyOnly, pending: [], checks: [], files: [], internalIds: [] })
  expect(retained.text).toContain(unitedStates)
  expect(retained.text).toContain(germany)
})
it('keeps a legal replacement when the budget merge and repair transforms would cross delivery identities', async () => {
  const stage = (id: string, deliverableId: string, dependsOn: string[] = [], supersedes: string[] = []): PlannedTask => ({ id, deliverableId, kind: 'analyze', goal: id, check: `${id}已提供`, criterionIds: [deliverableId], dependsOn, ...(supersedes.length ? { supersedes } : {}) })
  const plan = planSchema.parse({ tasks: [stage('draft-a', 'a'), stage('service-b', 'b'), stage('final-a', 'a', ['draft-a'], ['draft-a'])] })
  expect(() => validatePlan(plan.tasks.map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
  const fitted = fitPlanToBudget(plan.tasks, 14)
  expect(fitted.map(task => task.id)).toEqual(['draft-a', 'service-b', 'final-a'])
  expect(fitted.find(task => task.id === 'final-a')?.supersedes).toEqual(['draft-a'])
  expect(() => validatePlan(fitted.map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
  const preserved = { ...stage('kept', 'a'), criterionIds: ['kept'] }
  const recovery = [stage('draft-a', 'a', [], ['kept']), stage('service-b', 'b'), stage('final-a', 'a', ['draft-a'], ['draft-a'])]
  const recovered = fitPlanToBudget(recovery, 14, [preserved])
  expect(recovered.find(task => task.id === 'draft-a')?.supersedes).toEqual(['kept'])
  expect(() => validatePlan([{ ...preserved }, ...recovered.map(task => ({ ...task }))], ['kept', 'a', 'b'])).not.toThrow()
  const sameDelivery = [1, 2, 3, 4].map(n => stage(`v${n}`, 'report', n > 1 ? [`v${n - 1}`] : [], n > 1 ? [`v${n - 1}`] : []))
  const collapsed = fitPlanToBudget(sameDelivery, 14)
  expect(collapsed.length).toBeLessThanOrEqual(2)
  expect(() => validatePlan(collapsed.map(task => ({ ...task, criterionIds: ['report'] })), ['report'])).not.toThrow()
  const prep = { id: 'inspect', kind: 'analyze' as const, deliverableId: 'a', goal: '读取范围', check: '范围已读取', criterionIds: ['a'], dependsOn: [] }
  const repair = { id: 'fix', kind: 'edit' as const, deliverableId: 'b', goal: '修复实现', check: '实现已修复', criterionIds: ['b'], dependsOn: ['inspect'] }
  const revised = { id: 'final', kind: 'analyze' as const, deliverableId: 'a', goal: '修订终稿', check: '终稿已提供', criterionIds: ['a'], dependsOn: ['fix'], supersedes: ['inspect'] }
  const keptSeparate = mergePreparatoryStages([prep, repair, revised])
  expect(keptSeparate.map(task => task.id)).toEqual(['inspect', 'fix', 'final'])
  expect(() => validatePlan(keptSeparate.map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
  const edit = { id: 'impl', kind: 'edit' as const, deliverableId: 'a', goal: '修改实现', check: '实现已修改', criterionIds: ['a', 'b'], dependsOn: [] }
  const verify = { id: 'check', kind: 'verify' as const, deliverableId: 'b', goal: '复核结果', check: '复核完成', criterionIds: ['b'], dependsOn: ['impl'] }
  const successor = { id: 'next', kind: 'analyze' as const, deliverableId: 'b', goal: '形成终稿', check: '终稿已提供', criterionIds: ['a'], dependsOn: ['check'], supersedes: ['check'] }
  const verification = mergeRoutineVerificationStages([edit, verify, successor])
  expect(verification.map(task => task.id)).toEqual(['impl', 'check', 'next'])
  expect(() => validatePlan(verification.map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
  const tasks = plan.tasks
  let agentId = ''
  let captured: PlannedTask[] | undefined
  const program = buildTaskControllerProgram({ version: '54', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 15 })
  const runtime = new PulseRuntime({ programs: [program], effectExecutor: async effect => {
    if (effect.key?.startsWith('plan')) return { value: { tasks } }
    const agent = runtime.state.agents.get(agentId)!
    const global = agent.globalVersions.get(agent.latestGlobalVersion) as { taskController?: { tasks?: PlannedTask[] } }
    captured ??= global.taskController?.tasks
    throw Object.assign(new Error('REVIEW_STOP_AFTER_PLAN'), { retryable: false })
  } })
  const initialGlobal: JsonValue = { taskRecord: { schemaVersion: 1, runId: 'review6', objective: '起草A和B说明，再修订A，交付A终稿及B说明', acceptanceCriteria: [{ id: 'a', description: 'A最终说明' }, { id: 'b', description: 'B独立说明' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } }
  agentId = runtime.createAgent({ goal: '起草A和B说明，再修订A，交付A终稿及B说明', program, initialGlobal }).agentId
  await runtime.start(agentId).outcome()
  expect(captured?.map(task => task.id)).toEqual(['draft-a', 'service-b', 'final-a'])
  expect(captured?.find(task => task.id === 'final-a')?.deliverableId).toBe('a')
  expect(() => validatePlan((captured ?? []).map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
})
it('does not let an undeclared delivery inherit another identity during replacement merges', async () => {
  const bare = (id: string, criterionIds: string[], extra: Partial<PlannedTask> = {}): PlannedTask => ({ id, kind: 'analyze', goal: id, check: `${id}已提供`, criterionIds, dependsOn: [], ...extra })
  const untyped = planSchema.parse({ tasks: [
    { id: 'draft-a', deliverableId: 'a', kind: 'analyze', goal: '起草服务A说明', criterionIds: ['a'], dependsOn: [], check: 'A初稿已提供' },
    { id: 'service-b', kind: 'analyze', goal: '起草独立服务B说明', criterionIds: ['b'], dependsOn: [], check: 'B独立说明已提供' },
    { id: 'final-a', deliverableId: 'a', kind: 'analyze', goal: '复核并修订服务A终稿', criterionIds: ['a'], dependsOn: ['draft-a'], check: 'A终稿已提供', supersedes: ['draft-a'] },
  ] }).tasks
  expect(() => validatePlan(untyped.map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
  const fitted = fitPlanToBudget(untyped, 14)
  expect(fitted.map(task => task.id)).toEqual(['draft-a', 'service-b', 'final-a'])
  expect(fitted.find(task => task.id === 'service-b')?.deliverableId).toBeUndefined()
  expect(fitted.find(task => task.id === 'draft-a')?.deliverableId).toBe('a')
  expect(() => validatePlan(fitted.map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
  const open = fitPlanToBudget([bare('named', ['a'], { deliverableId: 'a' }), bare('plain', ['b']), bare('other', ['c'])], 14)
  expect(open.find(task => task.goal.includes('plain'))?.deliverableId).toBeUndefined()
  expect(() => validatePlan(open.map(task => ({ ...task })), ['a', 'b', 'c'])).not.toThrow()
  const many = fitPlanToBudget([
    bare('draft-a', ['a'], { deliverableId: 'a' }),
    bare('note', ['n']),
    bare('service-b', ['b']),
    bare('final-a', ['a'], { deliverableId: 'a', dependsOn: ['draft-a'], supersedes: ['draft-a'] }),
  ], 14)
  expect(many.find(task => task.deliverableId === 'a' && /note|service-b/.test(task.goal))).toBeUndefined()
  expect(many.find(task => task.id === 'final-a')?.supersedes).toEqual(['draft-a'])
  expect(() => validatePlan(many.map(task => ({ ...task })), ['a', 'n', 'b'])).not.toThrow()
  const prep = { id: 'inspect', kind: 'analyze' as const, goal: '读取范围', check: '范围已读取', criterionIds: ['b'], dependsOn: [] }
  const repair = { id: 'fix', kind: 'edit' as const, deliverableId: 'a', goal: '修复实现', check: '实现已修复', criterionIds: ['a'], dependsOn: ['inspect'] }
  const revised = { id: 'final', kind: 'analyze' as const, deliverableId: 'a', goal: '修订终稿', check: '终稿已提供', criterionIds: ['a'], dependsOn: ['fix'], supersedes: ['fix'] }
  expect(mergePreparatoryStages([prep, repair, revised]).map(task => task.id)).toEqual(['inspect', 'fix', 'final'])
  const source = await readFile(new URL('../packages/server/src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("tasks.filter(task => task.status === 'passed').map(task => {", source.indexOf('const input: CompletionReplyInput'))
  const expression = source.slice(start, source.indexOf('\n          pending:', start)).trim().replace(/,$/, '')
  const project = new Function('tasks', 'runtime', `return ${expression}`) as (this: { resultText: (runtime: unknown, ref: string) => string }, tasks: PlannedTask[], runtime: unknown) => CompletionReplyInput['completed']
  const texts = new Map([['result-draft-a', 'A初稿：美国。'], ['result-service-b', 'B独立说明：负责计费。'], ['result-final-a', 'A终稿：德国。']])
  const completed = project.call({ resultText: (_runtime, ref) => texts.get(ref) ?? '' }, fitted.map(task => ({ ...task, status: 'passed' as const, attempts: 1, evidenceRefs: [], candidateRef: `result-${task.id}` })), {})
  const facts: CompletionReplyInput = { request: '保留B独立说明，并只交付A修订后的终稿', status: 'accepted', completed, pending: [], checks: [], files: [], internalIds: [] }
  const reply = await composeCompletionReply(facts, async () => result('A终稿：德国。'))
  expect(reply.text).toContain('负责计费')
  expect(reply.text).toContain('德国')
  const fallback = await composeCompletionReply(facts)
  expect(fallback.text).toContain('负责计费')
  let agentId = ''
  let captured: PlannedTask[] | undefined
  const program = buildTaskControllerProgram({ version: '54', system: 'test', toolNames: [], approvalMode: 'auto', maxTurns: 15 })
  const runtime = new PulseRuntime({ programs: [program], effectExecutor: async effect => {
    if (effect.key?.startsWith('plan')) return { value: { tasks: untyped } }
    const agent = runtime.state.agents.get(agentId)!
    captured ??= (agent.globalVersions.get(agent.latestGlobalVersion) as { taskController?: { tasks?: PlannedTask[] } }).taskController?.tasks
    throw Object.assign(new Error('REVIEW_STOP_AFTER_PLAN'), { retryable: false })
  } })
  const initialGlobal: JsonValue = { taskRecord: { schemaVersion: 1, runId: 'review7', objective: '起草A和B说明，再修订A，保留B独立说明', acceptanceCriteria: [{ id: 'a', description: 'A终稿' }, { id: 'b', description: 'B独立说明' }], status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] } }
  agentId = runtime.createAgent({ goal: '起草A和B说明，再修订A，保留B独立说明', program, initialGlobal }).agentId
  await runtime.start(agentId).outcome()
  expect(captured?.map(task => task.id)).toEqual(['draft-a', 'service-b', 'final-a'])
  expect(captured?.find(task => task.id === 'service-b')?.deliverableId).toBeUndefined()
  expect(() => validatePlan((captured ?? []).map(task => ({ ...task })), ['a', 'b'])).not.toThrow()
})


it('keeps approval denial and independent failure facts without intermediate verification prose', async () => {
  const reply = await composeCompletionReply(input({
    request: '验证恢复脚本并汇总结果', status: 'incomplete', files: [],
    completed: [{ goal: '解释当前恢复设计', text: 'EARLY_CANDIDATE_BODY: 后续工作尚未完成' }],
    pending: [{ description: '验证恢复脚本', reason: 'APPROVAL_DENIED: Owner denied exact operation' }],
    checks: [{ status: 'failed', description: 'Frozen assertions', reason: 'duplicate-summary: actual defect; unknown-price: failed' }],
  }))
  expect(reply.text).toContain('APPROVAL_DENIED')
  expect(reply.text).toContain('duplicate-summary: actual defect')
  expect(reply.text).toContain('unknown-price')
  expect(reply.text).not.toContain('EARLY_CANDIDATE_BODY')
})
