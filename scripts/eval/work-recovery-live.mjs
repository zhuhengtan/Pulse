import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLocalHost } from '../../packages/server/dist/index.js'
import { approvalReviewProfile } from '../../packages/server/dist/approval-review-profile.js'

// Explicit opt-in only: two independent workspaces, never the production store.
const argument = name => process.argv[process.argv.indexOf(name) + 1]
if (!process.argv.includes('--source') || !process.argv.includes('--output')) throw new Error('Usage: --source ABSOLUTE_WORKSPACE --output ISOLATED_OUTPUT')
const source = resolve(argument('--source')), output = resolve(argument('--output'))
if (source === output || output.startsWith(source + '/') || output.includes('/.pulse/')) throw new Error('ISOLATED_OUTPUT_REQUIRED')
const config = JSON.parse(await readFile(process.env.PULSE_CONFIG ?? join(process.env.HOME, '.pulse/config.json'), 'utf8'))
const profile = config.providers?.deepseek, selection = profile?.models?.['deepseek-flash']
const apiKey = process.env[profile?.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
if (!apiKey || !selection?.modelCode) throw new Error('DEEPSEEK_CREDENTIAL_OR_MODEL_UNAVAILABLE')
const provider = { provider: 'deepseek', defaultModel: selection.modelCode, apiKey, baseURL: profile.baseURL ?? 'https://api.deepseek.com', maxContextTokens: selection.maxContextTokens ?? 256000, maxOutputTokens: selection.maxOutputTokens ?? 16384, reasoningEffort: selection.reasoningEffort ?? profile.reasoningEffort ?? 'medium' }
const [reviewerCode, reviewerId] = (config.approvalReview?.model ?? '').split('/')
const reviewerSource = config.providers?.[reviewerCode], reviewerModel = reviewerSource?.models?.[reviewerId]
if (!reviewerModel?.modelCode || !['deepseek', 'ollama'].includes(reviewerSource?.provider)) throw new Error('LIVE_APPROVAL_REVIEWER_NOT_CONFIGURED')
const approvalReview = { provider: reviewerSource.provider, model: reviewerModel.modelCode, baseURL: reviewerSource.baseURL ?? (reviewerSource.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com'), apiKeyEnv: reviewerSource.apiKeyEnv ?? 'DEEPSEEK_API_KEY', timeoutMs: Math.max(30000, Math.min(60000, config.approvalReview.timeoutMs ?? 30000)) }
approvalReviewProfile(approvalReview) // Fail before spending either live sample.
const cases = [
  { id: 'senior-basics', artifact: '英语基础_65岁入门.pptx', checks: ['verify_ppt.py', 'check_fit.py', 'dump_ppt.py'], limit: 64,
    prompt: '请在当前隔离副本继续完成适合65岁老人学英语基础的PPT。复用已有12页大纲和生成器，不访问工作区外数据。先记录已有英语基础_65岁入门.pptx为产物；然后在生成器中把封面标题改成“零基础英语入门·课程练习版”，重新生成同名PPT。保持12页、中文辅助、正文≥28pt和标题≥40pt。最后实际执行verify_ppt.py、check_fit.py、dump_ppt.py，每条命令都显式传英语基础_65岁入门.pptx，必要时修复实际问题并重新检查。保留原始检查定义，不通过删检查或降低要求取得成功。交付最终PPT文件链接；本任务已经授权，在预算内自行完成。' },
  { id: 'introduction', artifact: '第一课_自我介绍.pptx', checks: ['check_pics.py', 'check_fit.py', 'verify_deck.py', 'check_overlap.py'], limit: 96,
    prompt: '请在当前隔离副本继续完成第一课《自我介绍》的27页配图PPT。已有大纲、绘图与生成脚本，保留50分钟时间轴、教学内容、模板风格和每页插图。先只读确认配图链路和页数，再完成必要修复和最后验收。运行check_pics.py、check_fit.py、check_overlap.py时都必须显式传第一课_自我介绍.pptx；verify_deck.py固定检查该文件。注意check_fit.py默认检查另一份12页PPT，不能把它的结果作为本任务验收。确有排版、越界或图文重叠失败时修复生成器并重新生成、重跑所有受影响检查。不要修改已有检查脚本、缩小原始要求或只隐藏失败。工作区外与正式会话数据不在本任务范围。最终记录和交付同名PPT及必要限制，不要只列Python脚本。已授权自行完成，不需要询问继续。' },
]
await mkdir(output, { recursive: false })
const entries = (await readdir(source, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.') && !entry.name.startsWith('~') && (/\.(?:py|pptx|md)$/.test(entry.name) || entry.isDirectory() && ['tests', 'docs'].includes(entry.name)))
const original = new Map()
for (const entry of entries.filter(entry => entry.isFile())) original.set(entry.name, createHash('sha256').update(await readFile(join(source, entry.name))).digest('hex'))
const summary = []
for (const test of cases) {
  const directory = join(output, test.id), workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  for (const entry of entries) await cp(join(source, entry.name), join(workspace, entry.name), { recursive: entry.isDirectory() })
  const host = createLocalHost({ cwd: workspace, dataDir: join(directory, 'data'), logDir: join(directory, 'logs'), provider, activeModel: 'deepseek/deepseek-flash', activeProviderCode: 'deepseek', providerProfiles: { deepseek: provider }, providerModels: { 'deepseek/deepseek-flash': { provider: 'deepseek', model: selection.modelCode, maxContextTokens: provider.maxContextTokens, maxOutputTokens: provider.maxOutputTokens } }, approvalReview, taskController: true, approvalMode: 'auto', allowNetwork: false, maxModelCalls: test.limit, maxRuntimeMs: 720000, jarvis: { enabled: false } })
  let run, attention
  try {
    const conversation = await host.createConversation(); run = await host.sendMessage(conversation.id, { text: test.prompt })
    for await (const event of run.events) {
      if (['tool', 'waiting', 'error', 'complete'].includes(event.type)) console.log(JSON.stringify({ case: test.id, type: event.type, seq: event.seq }))
      if (event.type === 'waiting') { const pending = await run.pendingInteractions(); attention = pending.flatMap(row => row.items ?? []).flatMap(item => item.input?.tools ?? []).map(tool => tool.reviewCode ?? 'HUMAN_INPUT_REQUIRED'); await run.cancel('LIVE_REQUIRES_HUMAN_INPUT'); break }
    }
    const outcome = await run.outcome(), acceptance = await run.taskOutcome(), checks = []
    for (const script of test.checks) {
      try {
        const result = await promisify(execFile)('python3', [script, test.artifact], { cwd: workspace, timeout: 30000, maxBuffer: 1024 * 1024 })
        checks.push({ script, target: test.artifact, code: 0, stdout: result.stdout })
      } catch (error) { checks.push({ script, target: test.artifact, code: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }) }
    }
    const result = { case: test.id, attention, conversationId: conversation.id, runId: run.id, execution: outcome.status, acceptance: acceptance?.status, calls: (await run.usage()).modelCalls, reply: outcome.text, checks, passed: acceptance?.status === 'accepted' && checks.every(check => check.code === 0) && outcome.text?.includes(test.artifact) }
    summary.push(result); console.log(JSON.stringify({ case: test.id, acceptance: result.acceptance, calls: result.calls, passed: result.passed }))
  } catch (error) { summary.push({ case: test.id, passed: false, error: error.code ?? error.name }); if (run) await run.cancel('LIVE_HARNESS_FAILED').catch(() => {}) }
  finally { await host.close(); await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2)) }
}
for (const [name, digest] of original) if (createHash('sha256').update(await readFile(join(source, name))).digest('hex') !== digest) throw new Error('SOURCE_WORKSPACE_CHANGED')
console.log(JSON.stringify({ output, cases: summary.length, passed: summary.filter(item => item.passed).length, sourceUnchanged: true }))
