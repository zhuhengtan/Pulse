import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createLocalHost, createBuiltinSkillCapabilityPack, createSkillCapabilityPack } from '../../packages/server/dist/index.js'
import { loadHostModelConfig, waitForEvaluatorApproval, replyToWaitingEvent } from '../../tests/real-task/runner.mjs'
import { withBatchBudget } from './autonomy-budget.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2), option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const batch = resolve(option('--batch', '.pulse-dev/autonomy-20261022/live'))
const id = option('--case', 'patch'), attemptId = option('--attempt', id + '-1')
const hash = text => createHash('sha256').update(text).digest('hex')
const cases = {
  patch: {
    prompt: '修复 src/price.mjs 的 total(items)：每个 item 的 quantity 必须为非负整数，price 必须为非负有限数，否则抛出 Error。按分汇总，返回数值美元，例如 3 个 19.99 应为 59.97。保留具名导出，不添加依赖。执行现有测试，报告验证结果。不要修改现有测试。',
    fixtures: {
      'src/price.mjs': 'export function total(items) { return items.reduce((n, i) => n + i.price, 0) }\n',
      'test/price.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from '../src/price.mjs'; test('total',()=>{assert.equal(total([{price:19.99,quantity:3}]),59.97); assert.equal(total([]),0); for(const i of [{price:-1,quantity:1},{price:1,quantity:1.5},{price:NaN,quantity:1},{price:1,quantity:-1}]) assert.throws(()=>total([i]));});\n",
    },
    verify: root => { execFileSync(process.execPath, ['--test', 'test/price.test.mjs'], { cwd: root, stdio: 'pipe' }); return { passed: true, checks: ['frozen behavioral tests'] } },
  },
  svg: {
    prompt: '创建 pelican-bicycle.svg：独立有效 SVG，画一只骑自行车的鹈鹕，含两个车轮、车架、鸟的身体和长喙，并让两个车轮通过 animateTransform 连续旋转。先用 xmllint --noout pelican-bicycle.svg 检查 XML，然后新建 scripts/verify-pelican-svg.mjs 校验 SVG 含上述元素和动画，再运行该脚本验证，最后交付文件及验证结论。不要安装依赖。',
    fixtures: {},
    verify: async root => { const svg = await readFile(join(root, 'pelican-bicycle.svg'), 'utf8'); execFileSync('xmllint', ['--noout', 'pelican-bicycle.svg'], { cwd: root, stdio: 'pipe' }); const animation = (svg.match(/<animateTransform\b/g) ?? []).length >= 2; const script = await readFile(join(root, 'scripts/verify-pelican-svg.mjs'), 'utf8'); return { passed: animation && script.length > 50 && /<svg\b/.test(svg), checks: ['XML parse', 'two animation elements', 'verifier present'], limitations: ['Visual pelican recognition and animation playback require separate rendering acceptance'] } },
  },
  'capability-block': {
    prompt: '请用浏览器打开 https://example.com 并读取真实页面标题。先检查当前浏览器能力是否已启用且可连接。如果当前环境没有这项能力，明确说明具体阻塞和所需配置，保留未完成状态，不要安装或启动外部浏览器，不要把抓取 HTML 当作真实浏览器验证。', fixtures: {},
    verify: (_root, events) => { const operations = events.filter(e => e.type === 'observation' && e.data?.kind !== 'tool_start' && e.data?.tool).map(e => e.data.tool); return { passed: operations.includes('capability.status') && !operations.includes('shell.exec'), checks: ['capability discovery used', 'no install or browser shell fallback'], expectedBlocked: true } },
  },
}
const datasetTask = JSON.parse(await readFile(join(repo,'evals/tasks.v1.json'),'utf8')).tasks.find(t=>t.id===id)
if(datasetTask) cases[id]={prompt:datasetTask.prompt,fixtures:datasetTask.fixtures??{},network:datasetTask.sideEffects?.network===true,verify:root=>JSON.parse(execFileSync(process.execPath,[join(repo,'scripts/eval/grade.mjs'),'--dataset',join(repo,'evals/tasks.v1.json'),'--task',id,'--workspace',root],{encoding:'utf8',timeout:60000}))}
if (!cases[id] || !/^[\w-]+$/.test(attemptId)) throw Error('UNKNOWN_CASE_OR_INVALID_ATTEMPT')
const spec = cases[id], out = join(batch, attemptId), workspace = join(out, 'workspace'), dataDir = join(out, 'data')
await mkdir(batch, { recursive: true })
await mkdir(out, { recursive: false })
await mkdir(workspace)
// Keep Git discovery inside the isolated fixture rather than its parent repository.
execFileSync('git', ['init', '-q'], { cwd: workspace })
for (const [name, content] of Object.entries(spec.fixtures)) { await mkdir(dirname(join(workspace, name)), { recursive: true }); await writeFile(join(workspace, name), content) }
// Freeze runtime source/build plus task and grader before any provider call.
const files = {}
async function snapshot(dir) { for (const e of await readdir(join(repo, dir), { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await snapshot(p); else if (/\.(?:ts|js|mjs|json)$/.test(p)) files[p] = hash(await readFile(join(repo, p))) } }
for (const p of ['runtime', 'server', 'tool-sdk', 'adapters']) for (const sub of ['src', 'dist']) await snapshot(`packages/${p}/${sub}`)
for(const p of ['evals/tasks.v1.json','scripts/eval/grade.mjs'])files[p]=hash(await readFile(join(repo,p)))
await writeFile(join(out, 'freeze.json'), JSON.stringify({ schemaVersion: 1, files, prompt: spec.prompt, fixtures: Object.fromEntries(Object.entries(spec.fixtures).map(([p,c])=>[p,hash(c)])), evaluator: hash(await readFile(fileURLToPath(import.meta.url))) }, null, 2))
await withBatchBudget(batch, attemptId, async maxCalls => {
  const config = await loadHostModelConfig()
  if (config.activeModel !== 'deepseek/deepseek-flash') throw Error('UNEXPECTED_MODEL')
  const host = createLocalHost({ cwd: workspace, dataDir, provider: config.provider, activeModel: config.activeModel, approvalMode: 'auto', ...(config.approvalReview ? { approvalReview: { ...config.approvalReview, manualOnRejection: true } } : {}), taskController: true, maxModelCalls: maxCalls, maxRuntimeMs: 600_000, allowNetwork:spec.network===true, capabilityPacks: [createBuiltinSkillCapabilityPack(), createSkillCapabilityPack({ trustedRoots: [] })], enabledCapabilityPacks: ['builtin-skills', 'skills'], jarvis: { enabled: false } })
  const events = [], approvals = [], startedAt = Date.now(); let handle, outcome, task, usage
  try {
    const conv = await host.createConversation({ cwd: workspace, title: attemptId, approvalPolicy: 'delegate' })
    handle = await host.sendMessage(conv.id, { text: spec.prompt })
    await writeFile(join(out, 'identity.json'), JSON.stringify({ conversationId: conv.id, runId: handle.id, workspace, dataDir }))
    for await (const event of handle.events) {
      events.push(event)
      if (event.type === 'observation' && (event.data.kind==='model'||event.data.tool)) console.log(JSON.stringify({ type: event.data.kind, tool: event.data.tool, status: event.data.status }))
      if (event.type === 'waiting' && event.data?.effectId) {
        const receipt = await waitForEvaluatorApproval(join(batch, 'approvals'), event, workspace)
        approvals.push(receipt); await replyToWaitingEvent(handle, event, receipt.reply)
      }
    }
    outcome = await handle.outcome(); task = await handle.taskOutcome(); usage = await handle.usage()
  } finally { await writeFile(join(out, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n')); await host.close() }
  let verification
  try { verification = await spec.verify(workspace, events) } catch (e) { verification = { passed: false, error: String(e.message).slice(0, 1000) } }
  const immutable = await Promise.all(Object.entries(spec.fixtures).filter(([p]) => p.startsWith('test/')).map(async ([p,c]) => hash(await readFile(join(workspace,p))) === hash(c)))
  const result = { id, attemptId, model: config.activeModel, modelCalls: usage.modelCalls, durationMs: Date.now() - startedAt, runtimeStatus: outcome.status, error: outcome.error, taskOutcome: task, finalAnswer: outcome.text, verification, immutableTests: immutable.every(Boolean), approvals: approvals.length, usage }
  result.passed = verification.passed && result.immutableTests && (verification.expectedBlocked ? task?.status !== 'accepted' : task?.status === 'accepted')
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ attemptId, passed: result.passed, calls: result.modelCalls, runtime: result.runtimeStatus, task: task?.status, verification }))
  return { modelCalls: result.modelCalls, passed: result.passed, result: join(out, 'result.json') }
}, datasetTask ? attemptId : undefined)
