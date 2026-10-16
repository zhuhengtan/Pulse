#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { load, save, hash } from './long-task-lib.mjs'

const output = resolve(process.argv[2] ?? '.pulse-dev/long-task-eval-20261015')
const destination = resolve(process.argv[3] ?? 'docs/reviews/pulse-long-task-evaluation-2026-10-14')
const frozen = load(join(output, 'frozen.json')), budget = load(join(output, 'budget.json'))
async function jsonl(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) } catch { return [] } }
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).filter(key => !['durationMs', 'latencyMs', 'elapsedMs', 'timestamp', 'slotWaitMs'].includes(key)).sort().map(key => [key, stable(value[key])])) : value
const summaries = [], lines = ['# 真实调用过程记录', '', '使用修复后的Pulse Host，保持初次冻结的历史维护场景输入。逐请求证据包含API状态、usage、可见输出及工具参数；不保存凭据或推理正文。', '', '阶段表只统计归属阶段的模型请求；独立审批也计入Host根账本。费用核算以外部attempts、HTTP usage和Host根账本三者对账为准，未知usage不当作0。', '']
for (const task of frozen.dataset.tasks) {
  const dir = join(output, task.id), files = await readdir(dir), attempts = await jsonl(join(dir, 'attempts.jsonl'))
  const responses = attempts.filter(row => row.type === 'response'), admitted = attempts.filter(row => row.type === 'attempt')
  let runtime, runDir, result = files.includes('result.json') ? load(join(dir, 'result.json')) : null
  try {
    const session = load(join(dir, 'session.json'))
    runDir = join(dir, 'data/conversations', session.conversationId, 'runs', session.runId)
    runtime = load(join(runDir, 'runtime.json')).state.state
  } catch { /* run may not have returned a handle yet */ }
  const effects = runtime?.effects?.map(([, value]) => value) ?? []
  const results = new Map(runtime?.results ?? [])
  const tools = effects.filter(effect => effect.kind === 'tool').map(effect => {
    const input = effect.input, value = results.get(effect.outcome?.resultRef)?.value
    return { id: effect.id, name: input.name, arguments: input.arguments, status: effect.outcome?.status ?? effect.state, error: effect.outcome?.error ?? null, resultRef: effect.outcome?.resultRef, semanticHash: hash(JSON.stringify(stable(value ?? effect.outcome ?? null))), resultSummary: value && typeof value === 'object' ? { path: value.path, code: value.code, hash: value.hash, truncated: value.truncated, nextOffset: value.nextOffset, error: value.error } : undefined }
  })
  const repeated = [], seen = new Map()
  for (const tool of tools) {
    const key = JSON.stringify(stable({ name: tool.name, arguments: tool.arguments, semanticHash: tool.semanticHash }))
    if (seen.has(key)) repeated.push({ first: seen.get(key), repeated: tool.id, name: tool.name, arguments: tool.arguments })
    else seen.set(key, tool.id)
  }
  const root = runtime?.agents?.find(([id]) => id === 'agent-1')?.[1]
  const global = root?.globalVersions?.find(([version]) => version === root.latestGlobalVersion)?.[1]
  const controller = global?.taskController
  const modelEffects = effects.filter(effect => effect.kind === 'llm').map(effect => ({ id: effect.id, key: effect.key, task: effect.input?.task, lane: effect.ownerLaneId, status: effect.outcome?.status ?? effect.state, error: effect.outcome?.error ?? null }))
  const failures = (runtime?.events ?? []).filter(event => /rejected|failed|intervention/.test(event.type)).map(event => ({ seq: event.seq, type: event.type, payload: event.payload }))
  const summary = { taskId: task.id, effort: task.effort, startedAt: files.includes('started.json') ? load(join(dir, 'started.json')).at : null, completedAt: result?.completedAt ?? null, outerAttempts: budget.samples[task.id], httpResponses: responses.length, httpStatuses: responses.map(row => row.status), reportedUsage: result?.usage ?? null, runtimeStatus: result?.outcome?.status ?? null, businessStatus: result?.taskOutcome?.status ?? null, modelEffects, tools, repeatedIdenticalOperations: repeated, controller: controller ? { revision: controller.revision, usedTurns: controller.usedTurns, modelCalls: controller.modelCalls, tasks: controller.tasks, priorTasks: controller.priorTasks, finalReview: controller.finalReview, planAttempts: controller.planAttempts, note: controller.note } : null, failures, interactions: await jsonl(join(dir, 'interactions.jsonl')), restore: files.includes('restore.json') ? load(join(dir, 'restore.json')) : null }
  save(join(dir, 'diagnostics.json'), summary); summaries.push(summary)
  lines.push(`## ${task.id} ${task.title} (${task.effort})`, '', `- 开始：${summary.startedAt ?? '尚未开始'}；结束：${summary.completedAt ?? '运行中或未开始'}。`, `- 实际请求预留${summary.outerAttempts}/${budget.sampleLimit}；已记录HTTP响应${responses.length}；状态${[...new Set(summary.httpStatuses)].join(', ') || '未知'}。`, `- Runtime：${summary.runtimeStatus ?? '运行中/未知'}；Pulse业务自评：${summary.businessStatus ?? '未知'}。`, `- 工具操作${tools.length}；完全相同工具/参数/语义结果再次出现${repeated.length}次。这是诊断计数，不自动等同于无效循环。`, '', '### 请求时间线', '', '| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |', '|---:|---|---:|---|---:|---|')
  for (const request of admitted) {
    const response = responses.find(row => row.sample === request.sample), usage = response?.usage
    lines.push(`| ${request.sample} | ${request.at} | ${response?.status ?? '等待/未知'} | ${response?.finish ?? '未知'} | ${response?.durationMs ?? '未知'} | ${usage?.prompt_tokens ?? '未知'} / ${usage?.completion_tokens ?? '未知'} / ${usage?.completion_tokens_details?.reasoning_tokens ?? '未知'} |`)
  }
  lines.push('', '### 执行阶段', '', '| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |', '|---|---|---:|---:|---:|')
  for (const stage of [...(controller?.tasks ?? []), ...(controller?.priorTasks ?? [])]) lines.push(`| ${stage.id} | ${stage.status}${controller?.priorTasks?.includes(stage) ? '（历史阶段）' : ''} | ${stage.attempts} | ${stage.modelCalls ?? '未知'} | ${stage.investigationRounds ?? '未知'} |`)
  const evidenceLinks = ['attempts.jsonl', 'events.jsonl', 'diagnostics.json'].map(name => files.includes(name) || name === 'diagnostics.json' ? `[${name}](${join(dir, name)})` : `${name}（未生成）`)
  lines.push('', `原始证据：${evidenceLinks.join('、')}${runDir ? `、[Runtime快照](${join(runDir, 'runtime.json')})` : ''}。`, '')
}
save(join(output, 'diagnostics.json'), summaries)
await writeFile(join(destination, 'process.md'), lines.join('\n'))
console.log(JSON.stringify(summaries.map(row => ({ id: row.taskId, calls: row.outerAttempts, runtime: row.runtimeStatus, business: row.businessStatus, tools: row.tools.length, repeated: row.repeatedIdenticalOperations.length, stages: row.controller?.tasks.map(stage => ({ id: stage.id, status: stage.status })) }))))
