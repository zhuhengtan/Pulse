import { planConfirmationOptions } from '../../packages/server/dist/plan-confirmation.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const hash = value => createHash('sha256').update(value).digest('hex')
export const load = path => JSON.parse(readFileSync(path, 'utf8'))
export function save(path, value) {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}
export function append(path, value) { appendFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 }) }

/** Absolute case deadline is retained across worker restarts and owner waits. */
export function remainingEvaluationMs(startedAt, limitMs, now = Date.now()) {
  if (limitMs === null) return Infinity
  const start = Date.parse(startedAt)
  if (!Number.isFinite(start) || !Number.isSafeInteger(limitMs) || limitMs <= 0 || !Number.isFinite(now)) throw new Error('EVAL_DEADLINE_INVALID')
  return Math.max(0, start + limitMs - now)
}

export function transportErrorCode(error) {
  const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
  let node = error
  for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth++, node = node.cause) {
    if (typeof node.code === 'string' && codes.has(node.code)) return node.code
    if (node.name === 'TimeoutError' || node.name === 'AbortError') return node.name
  }
  return 'TRANSPORT_ERROR'
}

/** Stop a batch when transport or accounting cannot support a safe next sample. */
export function evaluationBlockReason(result) {
  const code = result?.outcome?.error?.code ?? result?.error?.code ?? ''
  const text = [code, result?.outcome?.text ?? '', ...(result?.taskOutcome?.criteria ?? []).map(c => c.rationale ?? ''), ...(result?.blockedReasons ?? [])].join('\n')
  const provider = /PROVIDER_NETWORK_ERROR(?:[^\n]{0,100})|PROVIDER_HTTP_(?:401|403|429|5\d\d)/.exec(text)
  if (provider) return `provider_block: ${provider[0]}`
  if (result?.outerAttempts > 0 && (!result.usage || result.usage.budget?.unknown > 0 || ['inputTokens', 'outputTokens'].some(field => typeof result.usage[field] !== 'number' || result.usage.fieldCompleteness?.[field]?.status === 'partial' || result.usage.fieldCompleteness?.[field]?.status === 'unavailable'))) return 'unknown_usage_after_provider_attempt'
  return undefined
}

// The supervisor serializes workers. This ledger is outside every agent workspace.
// Admission persists before transport; a crash can overcount reservations, never reset them.
export function reserveAttempt(path, taskId) {
  const ledger = load(path)
  if (!(ledger.totalLimit === null || Number.isSafeInteger(ledger.totalLimit) && ledger.totalLimit >= 1) || !(ledger.sampleLimit === null || Number.isSafeInteger(ledger.sampleLimit) && ledger.sampleLimit >= 1 && ledger.sampleLimit <= 256) || (ledger.totalLimit !== null && ledger.sampleLimit !== null && ledger.totalLimit < ledger.sampleLimit) || !Number.isInteger(ledger.used) || ledger.used < 0 || !ledger.samples || typeof ledger.samples !== 'object') throw new Error('EVAL_LEDGER_CORRUPT')
  const used = ledger.samples[taskId]
  if (!Number.isInteger(used) || used < 0 || (ledger.sampleLimit !== null && used > ledger.sampleLimit) || Object.values(ledger.samples).some(count => !Number.isInteger(count) || count < 0 || (ledger.sampleLimit !== null && count > ledger.sampleLimit)) || ledger.used !== Object.values(ledger.samples).reduce((a, b) => a + b, 0)) throw new Error('EVAL_LEDGER_CORRUPT')
  if ((ledger.totalLimit !== null && ledger.used >= ledger.totalLimit) || (ledger.sampleLimit !== null && used >= ledger.sampleLimit)) throw Object.assign(new Error('Evaluation provider-attempt budget exhausted'), { code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED', retryable: false })
  ledger.used++; ledger.samples[taskId]++
  save(path, ledger)
  return { total: ledger.used, sample: ledger.samples[taskId] }
}

export async function manifest(root) {
  const result = {}
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.pulse', '.pulse-dev', 'dist', 'web-dist'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result[relative(root, path)] = hash(await readFile(path))
      else if ((await lstat(path)).isSymbolicLink()) result[relative(root, path)] = 'symlink'
    }
  }
  await visit(root)
  return result
}
export function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort()
}

export const officialNotes = `# DeepSeek official documentation snapshot
Retrieved 2026-10-15. These are paraphrased notes; consult source URLs for full context.

https://api-docs.deepseek.com/guides/thinking_mode/
Thinking defaults to high. low maps to low; medium and xhigh map to high. max is a separate effort. With tools present, earlier assistant reasoning_content must be sent back, including assistant turns without a tool call. Missing reasoning history can cause HTTP 400. Without tools, reasoning history is ignored. Temperature and presence/frequency penalties have no effect in thinking mode.

https://api-docs.deepseek.com/api/create-chat-completion/
Current model IDs include deepseek-flash and deepseek-v4-pro. reasoning_effort accepts none/low/high/max. max_tokens bounds generation and finish_reason length indicates truncation. JSON mode still needs explicit JSON instructions. Stream usage arrives on the final content chunk, rather than requiring a separate usage-only chunk. Do not assume omitted usage equals zero.
`

export const ownerFacts = '使用真实项目场景；离线模拟加6次DeepSeek真实样本，low和high各3次；每例最多16次实际模型调用，总共最多96次，审批、压缩、重试和恢复都计入；失败不自动重跑；串行，单例20分钟；输出逐例报告、能力矩阵、问题证据和P0/P1/P2优化方案；报告组织采用每例独立报告，另有汇总、矩阵和问题清单；不提交、推送、发布；保留全部现有修改；当前先形成计划，最终选择暂不执行。'

export function interviewAnswer(input, facts = ownerFacts) {
  const prompt = String(input.prompt ?? '')
  const options = (input.options ?? []).map(item => typeof item === 'string' ? { label: item, value: item } : item)
  const final = planConfirmationOptions({ options })
  if (final) return { final: true, value: { value: final.defer }, basis: 'confirmed defer implementation; native option value preserved' }
  if (options.length) {
    // Prefer the exact approved destination, never a broad "new file" match.
    const exact = options.filter(item => /pulse-long-task-evaluation-v2\.md/i.test(`${item.value} ${item.label}`) || item.value === 'new-name-v2')
    if (exact.length === 1 && /存在|同名|覆盖|文件名|路径|保存|exist|name|path/i.test(prompt)) return { value: { value: exact[0].value }, basis: `confirmed destination: ${exact[0].value} (${exact[0].label})` }
    const reports = options.filter(item => /(?:每例|逐例)(?:一份)?[^。；;\n]{0,30}(?:独立|单独)[^。；;\n]{0,15}报告.*(?:汇总|总报告|矩阵)/i.test(String(item.label)))
    if (reports.length === 1 && /报告|组织|布局|结构|report/i.test(prompt)) return { value: { value: reports[0].value }, basis: `confirmed per-case reports and summary: ${reports[0].value} (${reports[0].label})` }
    // A generic rename is safe only when there is exactly one such choice and
    // no specific approved destination was offered; ask the filename next.
    const rename = options.filter(item => /^(?:换个名字|另存为新文件|rename)$/i.test(String(item.label)))
    if (rename.length === 1 && /存在|同名|覆盖|exist/i.test(prompt)) return { value: { value: rename[0].value }, basis: `preserve original: ${rename[0].value} (${rename[0].label})` }
    return { unanswered: true, prompt, options }
  }
  if (/文件名|路径|保存|file.*name/i.test(prompt)) return { value: { text: '请保留旧文件，另存为 docs/plans/pulse-long-task-evaluation-v2.md。' }, basis: 'approved non-overwrite constraint' }
  if (/预算|样本|模型|限制|约束|边界|报告.*(?:组织|结构)|budget|sample|constraint/i.test(prompt)) return { value: { text: facts }, basis: 'confirmed user decisions only' }
  return { unanswered: true, prompt, options: [] }
}

/** Stable execution policy only. Historical progress belongs in timestamped evidence. */
export function evaluationSystemPrompt(options) {
  const { productCalls, evaluatorCalls = null } = options
  if (Object.keys(options).some(key => !['productCalls', 'evaluatorCalls'].includes(key))) throw new Error('EVAL_PROMPT_STATE_FORBIDDEN')
  if (!Number.isInteger(productCalls) || productCalls < 1 || productCalls > 256 || evaluatorCalls !== null && (!Number.isInteger(evaluatorCalls) || evaluatorCalls < 1 || evaluatorCalls > productCalls)) throw new Error('EVAL_PROMPT_BUDGET_INVALID')
  return `你在隔离的真实 Pulse 项目副本完成维护任务。忠实保留任务需求，提供实际产物与检查证据。所有嵌套检查只可使用本地模拟模型；不能联网启动其他模型、读取正式配置或凭据。当前 run 的所有模型调用（含规划、审批、验证）共用${productCalls}次产品上限（评测额外上限：${evaluatorCalls ?? '未设置'}）。审批由监督者逐项审查，未确认的操作不得执行。历史状态是带时间的参考；以当前文件版本和后续实际检查为准，不能把先前失败写成永久事实，也不能只凭监督文字声称验收通过。已通过且证据有效的工作保留，修改前只读必要源码。Node集成验证使用自包含 .test.mjs 文件及 node --test，真实入口配合假依赖调用日志证明执行，不把历史记录行数当调用次数，不自行假设输出字段。保留失败证据，未完成项如实报告。不要提交、推送或发布。`
}
