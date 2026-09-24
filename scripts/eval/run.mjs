#!/usr/bin/env node
import { evaluationStatus } from './status.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const has = (name) => args.includes(name)
const datasetPath = resolve(option('--dataset', `${root}/evals/tasks.v1.json`))
const dataset = JSON.parse(await readFile(datasetPath, 'utf8'))
const validation = await new Promise((resolvePromise) => {
  const child = spawn(process.execPath, [join(root, 'scripts/eval/validate.mjs'), datasetPath, '--quiet'], { stdio: 'inherit' })
  child.on('exit', (code) => resolvePromise(code ?? 1))
})
if (validation !== 0) process.exit(validation)
const selected = option('--task', undefined)
const tasks = selected ? dataset.tasks.filter((task) => task.id === selected) : dataset.tasks
if (!tasks.length) { console.error(`Unknown task: ${selected}`); process.exit(2) }
if (has('--dry-run') || has('--validate-only')) {
  console.log(JSON.stringify({ mode: 'validate-only', qualityBaselineCreated: false, taskCount: tasks.length, tasks: tasks.map(({ id, category, goal, successCriteria, scoring, modelRequirements, sideEffects }) => ({ id, category, goal, successCriteria, scoring, modelRequirements, sideEffects })) }, null, 2))
  process.exit(0)
}
const archive = option('--archive', undefined)
const localCli = option('--cli', undefined)
const config = option('--config', process.env.PULSE_CONFIG)
const model = option('--model', undefined)
const outArg = option('--out', undefined)
if ((!archive && !localCli) || (archive && localCli) || !config || !model || !outArg || !has('--auto-approve')) {
  console.error('Real runs require exactly one of --archive <packed CLI .tar.gz> or --cli <local Pulse CLI entry>, plus --config <Pulse config> --model <display name> --out <new results directory> --auto-approve. This executes agent tool calls with auto approval inside per-task workspaces.')
  process.exit(2)
}
const trials = Number(option('--trials', '1'))
const maxCalls = Number(option('--max-turns', option('--max-calls', '24')))
const maxRunMs = Number(option('--max-run-ms', '600000'))
const maxOutputTokens = Number(option('--max-output-tokens', '8192'))
const maxCost = option('--max-cost', undefined) === undefined ? undefined : Number(option('--max-cost', undefined))
const maxTotalTokens = option('--max-total-tokens', undefined) === undefined ? undefined : Number(option('--max-total-tokens', undefined))
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 256) throw new Error('--max-calls must be 1..256')
if (!Number.isInteger(maxRunMs) || maxRunMs < 1000 || maxRunMs > 3600000) throw new Error('--max-run-ms must be 1000..3600000')
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) throw new Error('--max-output-tokens must be 1..32768')
if (maxTotalTokens === undefined) throw new Error('Real evaluations require --max-total-tokens as a conservative run budget')
const costCurrency = option('--cost-currency', 'USD')
if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0 || maxTotalTokens === undefined || !/^[A-Z]{3}$/.test(costCurrency))) throw new Error('--max-cost requires a positive value, --max-total-tokens, and an ISO currency code')
if (maxTotalTokens !== undefined && (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1)) throw new Error('--max-total-tokens must be a positive integer')
if (!Number.isInteger(trials) || trials < 1 || trials > 10) { console.error('--trials must be an integer from 1 to 10'); process.exit(2) }
const archivePath = archive ? resolve(archive) : null
const localCliPath = localCli ? resolve(localCli) : null
const outputRoot = resolve(outArg)
const configPath = resolve(config)
const configData = JSON.parse(await readFile(configPath, 'utf8'))
const modelEntry = Object.entries(configData.models ?? {}).find(([name, entry]) => name === model || entry.displayName === model)
if (!modelEntry) throw new Error(`Configured Pulse model not found: ${model}`)
const [modelName, modelRow] = modelEntry
const providerProfile = configData.providers?.[modelRow.provider]
if (!providerProfile) throw new Error(`Configured provider profile not found: ${modelRow.provider}`)
if (providerProfile.provider === 'mock') throw new Error('Real-provider evaluations cannot use the mock provider')
const apiKeyEnv = providerProfile.apiKeyEnv ?? (providerProfile.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
if (providerProfile.provider !== 'ollama' && !process.env[apiKeyEnv]) throw new Error(`Provider credential is unavailable in environment variable ${apiKeyEnv}`)
await mkdir(outputRoot, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; throw new Error(`Output directory already exists: ${outputRoot}`) })
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pulse-eval-'))
try {
  if (archivePath) {
    await new Promise((resolvePromise, reject) => {
      const child = spawn('tar', ['-xzf', archivePath, '-C', temporaryRoot], { stdio: 'inherit' })
      child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`archive extraction failed (${code})`)))
      child.on('error', reject)
    })
  }
  const bin = localCliPath ?? join(temporaryRoot, 'pulse/bin/pulse.js')
  const contextLimit = Number(modelRow.maxContextTokens ?? providerProfile.maxContextTokens ?? 32000)
  const modelIdentity = { displayName: modelRow.displayName ?? modelName, modelCode: modelRow.modelCode, provider: modelRow.provider }
  const runsPath = join(outputRoot, 'runs.jsonl')
  const reportsPath = join(outputRoot, 'report.json')
const records = []
const fullSuiteSelected = selected === undefined && tasks.length === 24 && trials >= 3
let consumedTokens = 0; let consumedCostUnknown = false; let budgetStopped = false
  for (const task of tasks) for (let trial = 1; trial <= trials; trial++) {
    if (budgetStopped) break
    const tokensForTask = maxTotalTokens === undefined ? undefined : Math.min(maxCalls, Math.floor((maxTotalTokens - consumedTokens) / (contextLimit + maxOutputTokens)))
    if (tokensForTask !== undefined && tokensForTask < 1) { budgetStopped = true; break }
    const taskRoot = join(outputRoot, 'workspaces', task.id, `trial-${trial}`)
    const dataDir = join(outputRoot, 'pulse-data', task.id, `trial-${trial}`)
    await mkdir(taskRoot, { recursive: true })
    for (const [relativePath, value] of Object.entries(task.fixtures ?? {})) {
      const target = resolve(taskRoot, relativePath)
      const fromTaskRoot = relative(taskRoot, target)
      if (fromTaskRoot === '' || fromTaskRoot === '..' || fromTaskRoot.startsWith(`..${sep}`) || isAbsolute(fromTaskRoot)) {
        throw new Error(`fixture path must resolve to a file inside its workspace: ${relativePath}`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, value, { flag: 'wx' })
    }
    const cliArgs = [bin, 'run', task.prompt, '--cwd', taskRoot, '--data-dir', dataDir, '--config', configPath, '--model', model, '--format', 'jsonl', '--approval-mode', 'auto', '--max-turns', String(tokensForTask ?? maxCalls), '--max-output-tokens', String(maxOutputTokens), ...(task.sideEffects.network ? ['--allow-network'] : ['--no-network'])]
    const started = performance.now()
    const captured = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, cliArgs, { cwd: taskRoot, env: { ...process.env, PULSE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''; let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref() }, maxRunMs)
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('exit', (code, signal) => { clearTimeout(timer); resolvePromise({ stdout, stderr, code: code ?? (signal ? 128 : 1), signal, timedOut }) })
    })
    const elapsedMs = Math.round(performance.now() - started)
    const events = []
    let finalResult = null
    let assistantText = ''
    let usage = null
    for (const line of captured.stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const item = JSON.parse(line)
        if (item.type === 'result') { finalResult = item; usage = item.usage ?? null }
        else {
          events.push(item.type ?? 'unknown')
          if (item.type === 'text') assistantText += String(item.data ?? '')
        }
      } catch { /* non-JSON stdout is retained only in the trace summary size */ }
    }
    const grade = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/eval/grade.mjs'), '--dataset', datasetPath, '--task', task.id, '--workspace', taskRoot], { stdio: ['ignore', 'pipe', 'inherit'] })
      let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += chunk })
      child.on('error', reject); child.on('exit', (code) => { if (code === 0) resolvePromise(JSON.parse(stdout)); else reject(new Error(`grader failed for ${task.id}`)) })
    })
    const record = {
      schemaVersion: 1,
      taskId: task.id,
      category: task.category,
      trial,
      model: modelIdentity,
      status: evaluationStatus(captured, finalResult),
      runtimeStatus: finalResult?.status ?? 'unknown',
      taskOutcome: finalResult?.taskOutcome ?? null,
      usage,
      exitCode: captured.code,
      elapsedMs,
      tokenUsage: usage ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, cachedInputTokens: usage.cachedInputTokens ?? null, completeness: usage.completeness ?? 'unavailable' } : null,
      cost: usage?.providerCosts?.length ? { source: 'provider', providerCosts: usage.providerCosts } : null,
      assistantText,
      traceSummary: { eventCounts: Object.fromEntries([...new Set(events)].map((event) => [event, events.filter((entry) => entry === event).length])), eventCount: events.length, hasGap: events.includes('gap'), hasWaiting: events.includes('waiting'), textChars: assistantText.length, completeTraceAvailable: false },
      error: finalResult?.error ?? (captured.stderr.trim() ? captured.stderr.trim().slice(-2000) : null),
      grading: { status: 'sandboxed-behavior-and-artifact-grader', score: grade.score, maxPoints: grade.maxPoints, passed: grade.passed, checks: grade.checks },
      workspace: taskRoot,
    }
    records.push(record)
    consumedTokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
    if (maxTotalTokens !== undefined && (typeof usage?.inputTokens !== 'number' || typeof usage?.outputTokens !== 'number')) budgetStopped = true
    if (maxCost !== undefined) {
      const taskCost = (usage?.providerCosts ?? []).reduce((sum, cost) => sum + (cost.currency === costCurrency ? cost.amount : 0), 0)
      if (!usage?.providerCosts?.length) consumedCostUnknown = true
      if (taskCost && records.reduce((sum, item) => sum + (item.usage?.providerCosts ?? []).filter(cost => cost.currency === costCurrency).reduce((costSum, cost) => costSum + cost.amount, 0), 0) > maxCost) budgetStopped = true
    }
    await writeFile(runsPath, `${JSON.stringify(record)}\n`, { flag: 'a' })
    console.log(`${task.id} trial ${trial}: ${record.status}, behavior/artifact score ${grade.score}/${grade.maxPoints}`)
  }
  const uniqueCosts = new Map()
  let actualTokenTotal = 0; let usageCompleteRuns = 0
  for (const record of records) {
    if (record.usage?.completeness === 'complete') usageCompleteRuns++
    actualTokenTotal += (record.usage?.inputTokens ?? 0) + (record.usage?.outputTokens ?? 0)
    for (const cost of record.usage?.providerCosts ?? []) uniqueCosts.set(cost.currency, (uniqueCosts.get(cost.currency) ?? 0) + cost.amount)
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    realProviderRun: providerProfile.provider !== 'mock',
    budget: { stoppedBeforeNextRun: budgetStopped, consumedCostUnknown, maxTurnsPerAttempt: maxCalls, providerCallLimitEnforced: false, tokenLimitEnforced: false, maxRunMs, maxOutputTokens, maxCost: maxCost ?? null, costCurrency, maxTotalTokens: maxTotalTokens ?? null, actualTokens: actualTokenTotal, actualCosts: Object.fromEntries(uniqueCosts), usageCompleteRuns, costLimitEnforced: false, note: 'Cost is checked between tasks and may exceed its ceiling within one task. Wall time and ReAct turns are bounded. --max-calls is a legacy alias for --max-turns, not a hard provider-call cap. Verification, replanning and safety review may make additional calls. Token reservation is an estimate, not a hard limit.' },
    qualityBaselineCreated: fullSuiteSelected && records.length === 24 * trials && !budgetStopped,
    baselineDefinition: 'A baseline sample is complete only when all 24 tasks have at least three trials. Completion means the measurement exists; it does not mean the agent passed.',
    dataset: datasetPath,
    cliSource: localCliPath ? { kind: 'local', entry: localCliPath } : { kind: 'archive', path: archivePath },
    model: modelIdentity,
    tasksRun: records.length,
    score: records.reduce((sum, item) => sum + item.grading.score, 0),
    maxScore: records.reduce((sum, item) => sum + item.grading.maxPoints, 0),
    requestedRuns: tasks.length * trials,
    budgetStopped,
    completedRuns: records.filter((item) => item.status === 'succeeded').length,
    records,
    limitations: ['Runtime and safety-review provider attempts expose usage; missing usage remains unknown. Null means unavailable, not zero.', 'The JSONL CLI stream is not a complete runtime trace; traceSummary includes only visible CLI events.', 'Static artifact scores are mechanical checks and do not replace human review of correctness, factuality, or source quality.'],
  }
  await writeFile(reportsPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Wrote ${runsPath} and ${reportsPath}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
