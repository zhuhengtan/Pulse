#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { load } from './long-task-lib.mjs'

const output = resolve(process.argv[2] ?? '.pulse-dev/long-task-eval-20261015')
const destination = resolve(process.argv[3] ?? 'docs/reviews/pulse-long-task-evaluation-2026-10-14')
await mkdir(destination, { recursive: true })
const frozen = load(join(output, 'frozen.json')), budget = load(join(output, 'budget.json'))
const rows = [], records = []
const budgetLabel = budget.sampleLimit === null ? '不设额外评测上限（产品上限仍保留）' : String(budget.sampleLimit)
const sampleMs = frozen.dataset.limits?.perSampleMs
const deadlineLabel = sampleMs === null ? '不设额外任务截止' : sampleMs === undefined ? '截止时限未记录' : String(sampleMs / 60000) + '分钟'
for (const task of frozen.dataset.tasks) {
  const folder = join(output, task.id), files = await readdir(folder)
  const result = files.includes('result.json') ? load(join(folder, 'result.json')) : null
  const review = files.includes('review.json') ? load(join(folder, 'review.json')) : null
  const grade = files.includes('grade.json') ? load(join(folder, 'grade.json')) : null
  const status = review?.status ?? (result ? 'partial' : 'not_run')
  const score = review?.score ?? null
  const reason = review?.summary ?? (result ? '已运行，尚待独立语义验收。' : budget.used > 0 ? '串行真实评估尚未完成本例，不能提前给出验收结论。' : '尚未执行真实样本，不生成能力评分。')
  const usage = result?.usage ?? null
  records.push({ taskId: task.id, status, score, usage, attempts: budget.samples[task.id], reviewed: !!review })
  rows.push(`| [${task.id}](${task.id}.md) | ${task.effort} | ${task.title} | ${status} | ${score ?? '—'} | ${budget.samples[task.id]} |`)
  const content = `# ${task.id}：${task.title}\n\n状态：**${status}**。${reason}\n\n## 场景与冻结要求\n\n类型：${task.category}。模型：deepseek/deepseek-flash，effort=${task.effort}。${budgetLabel}；${deadlineLabel}。\n\n${task.prompt}\n\n### 独立验收点\n\n${task.criteria.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n\n### 交付路径\n\n${task.deliverables.map(path => '- ' + path).join('\n')}\n\n## 实际结果\n\n- 外部请求预留：${budget.samples[task.id]}；额外上限${budgetLabel}。\n- Runtime：${result?.outcome?.status ?? (budget.samples[task.id] > 0 ? '中断/无终态' : '未运行')}。\n- Pulse业务自评：${result?.taskOutcome?.status ?? '未知/未运行'}。\n- 独立结论：${status}；评分${score === null ? '未评分' : score + '/100'}。\n- usage：${usage ? JSON.stringify(usage) : '不可用；未执行或请求被中断，不能以0 token表示质量样本。'}\n- 改动：${result?.changed?.length ? result.changed.join(', ') : '没有受测任务产物'}。\n\n${grade ? '### 外部探针\n\n' + grade.checks.map(check => `- ${check.passed ? '通过' : check.status === 'blocked_env' ? '环境阻塞，未执行' : '失败'}：${check.name}${check.detail ? '；' + check.detail.slice(0, 1200) : ''}`).join('\n') : '独立产物/行为探针尚未执行。'}\n\n${review?.details ?? ''}\n\n## 证据与限制\n\n现场目录：[${task.id}](${folder})。冻结规则和源码哈希见 [frozen.json](${join(output, 'frozen.json')})。本例失败不自动重跑；未执行样本不能用于判断 Pulse 真实任务能力。不同场景不能直接比较 low/high 因果差异。\n`
  await writeFile(join(destination, `${task.id}.md`), content)
}
const known = field => records.some(row => typeof row.usage?.[field] === 'number') ? records.reduce((sum, row) => sum + (row.usage?.[field] ?? 0), 0) : '未知'
const unknown = field => records.filter(row => row.attempts > 0 && typeof row.usage?.[field] !== 'number').length
const overview = `# Pulse 长任务执行能力评估\n\n生成时间：${new Date().toISOString()}。实际执行日2026-10-15，目录沿用批准计划中的日期。\n\n## 当前结论\n\n${records.every(row => row.status === 'not_run') ? '尚未执行真实样本，不生成真实任务能力或质量结论；离线结果只证明对应的模拟场景。' : '真实样本结果见下表；只有独立语义验收完成的样本才有最终评分。Runtime状态、Pulse自评与独立结果分别保留。'}\n\n## 场景矩阵\n\n| 场景 | effort | 实际维护需求 | 独立状态 | 分数 | 请求预留 |\n|---|---|---|---|---:|---:|\n${rows.join('\n')}\n\n## 费用与输入\n\n- 累计请求预留：${budget.used}；额外总上限${budget.totalLimit ?? '未设置'}。单例${budgetLabel}，${records.length}例串行；失败不加试。\n- 已知 input/output/reasoning tokens 合计：${known('inputTokens')} / ${known('outputTokens')} / ${known('reasoningTokens')}；对应已请求但消耗未知的样本数：${unknown('inputTokens')} / ${unknown('outputTokens')} / ${unknown('reasoningTokens')}。尚未运行不算0 token样本。\n- 没有冻结价格，没有可确认的完整账单金额。\n- 源码快照：${Object.keys(frozen.sourceManifest).length}个文件；基于${frozen.sourceRevision}及当前未提交改动。每例独立目录。\n- 运行记录只选取runId、状态、错误、usage和来源；去除原始用户任务/会话文本。排除了配置和测试证书/私钥。\n\n## 报告入口\n\n- [冻结评分与验收规则](rubric.md)\n- [离线校准与验证边界](offline.md)\n- [问题与优化顺序](optimizations.md)\n- [证据与复现命令](evidence.md)\n\n六个不同任务、每例一次，不能推出稳定成功率或low/high的因果优劣。请求期间驱动保持冻结；修复、环境阻塞与未执行项分别记录。不提交、推送或发布。\n`
await writeFile(join(destination, 'README.md'), overview)
console.log(JSON.stringify({ reports: destination, samples: records.length, calls: budget.used }))
