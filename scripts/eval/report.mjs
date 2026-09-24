#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const input = resolve(process.argv[2] ?? '')
if (input === resolve('.')) { console.error('Usage: node scripts/eval/report.mjs <runs.jsonl> [report.md]'); process.exit(2) }
const output = resolve(process.argv[3] ?? input.replace(/\.jsonl$/i, '.md'))
const records = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const groups = new Map()
let inputTokens = 0; let outputTokens = 0; let usageComplete = 0; let knownCostRuns = 0
const providerCosts = new Map()
for (const record of records) {
  const category = record.category ?? 'unknown'
  const group = groups.get(category) ?? { runs: 0, score: 0, max: 0, succeeded: 0, elapsed: 0, inputTokens: 0, outputTokens: 0 }
  group.runs++; group.score += record.grading?.score ?? 0; group.max += record.grading?.maxPoints ?? 0
  if (record.status === 'succeeded') group.succeeded++
  group.elapsed += record.elapsedMs ?? 0
  const usage = record.tokenUsage
  if (usage) {
    if (typeof usage.inputTokens === 'number') { inputTokens += usage.inputTokens; group.inputTokens += usage.inputTokens }
    if (typeof usage.outputTokens === 'number') { outputTokens += usage.outputTokens; group.outputTokens += usage.outputTokens }
    if (usage.completeness === 'complete') usageComplete++
  }
  if (Array.isArray(record.cost?.providerCosts) && record.cost.providerCosts.length) {
    knownCostRuns++
    for (const cost of record.cost.providerCosts) providerCosts.set(cost.currency, (providerCosts.get(cost.currency) ?? 0) + cost.amount)
  }
  groups.set(category, group)
}
const model = records[0]?.model
const lines = [
  '# Pulse Agent Evaluation Report', '',
  `- Runs: ${records.length}`,
  `- Model: ${model?.displayName ?? 'unknown'} (${model?.provider ?? 'unknown'} / ${model?.modelCode ?? 'unknown'})`,
  `- Token usage: ${inputTokens} input / ${outputTokens} output tokens recorded; complete usage on ${usageComplete}/${records.length} runs (missing values remain unknown).`,
  `- Provider-reported cost: ${providerCosts.size ? [...providerCosts].map(([currency, amount]) => `${amount} ${currency}`).join(', ') : `unknown on ${records.length - knownCostRuns}/${records.length} runs`}. No estimate is substituted.`,
  '- Scores combine sandboxed behavior probes and artifact/source-traceability checks; research accuracy still needs human review.', '',
  '| Category | Runs | CLI succeeded | Behavior/artifact score | Mean elapsed ms |',
  '| --- | ---: | ---: | ---: | ---: |',
]
for (const [category, group] of groups) lines.push(`| ${category} | ${group.runs} | ${group.succeeded}/${group.runs} | ${group.score}/${group.max} | ${Math.round(group.elapsed / group.runs)} |`)
lines.push('', '## Per-task results', '', '| Task | Trial | Status | Behavior/artifact score | Input / output tokens | Elapsed ms |', '| --- | ---: | --- | ---: | ---: | ---: |')
for (const record of records) lines.push(`| ${record.taskId} | ${record.trial ?? 1} | ${record.status} | ${record.grading?.score ?? 0}/${record.grading?.maxPoints ?? 0} | ${record.tokenUsage?.inputTokens ?? 'unknown'} / ${record.tokenUsage?.outputTokens ?? 'unknown'} | ${record.elapsedMs ?? 'unknown'} |`)
lines.push('', '## Review notes', '', 'Mechanical scores do not establish full semantic correctness or research factuality; review the recorded artifacts and evidence manually. Read each task workspace and its `runs.jsonl` record before treating a run as successful.', '')
await writeFile(output, lines.join('\n'))
console.log(`Wrote ${output}`)
