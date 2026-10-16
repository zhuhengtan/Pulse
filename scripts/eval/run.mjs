#!/usr/bin/env node
import { evaluationStatus } from './status.mjs'
import { resolveEvaluationModel, buildEvaluationArgs, parseEvaluationBudgets } from './config-budget.mjs'
import { selectPendingTrials, completedTrials, historicalAccounting, readRunRecords, readJson, saveJson, fingerprint, trialKey, acquireBatchLock, recoverTrial, verifyTrialBudget } from './resume.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'

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
if (tasks.some(task => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(task.id))) throw new Error('EVAL_TASK_ID_INVALID')
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
const { maxModelCalls: maxCalls, maxTurns } = parseEvaluationBudgets(args)
const maxRunMs = Number(option('--max-run-ms', '600000'))
const maxOutputTokens = Number(option('--max-output-tokens', '8192'))
const maxCost = option('--max-cost', undefined) === undefined ? undefined : Number(option('--max-cost', undefined))
const maxTotalTokens = option('--max-total-tokens', undefined) === undefined ? undefined : Number(option('--max-total-tokens', undefined))
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
const selection = resolveEvaluationModel(configData, model)
const modelName = selection.reference, modelRow = selection.model, providerProfile = selection.profile
const contextLimit = Number(modelRow.maxContextTokens ?? providerProfile.maxContextTokens ?? 32000)
if (!Number.isSafeInteger(contextLimit) || contextLimit < 1) throw new Error('EVAL_CONTEXT_LIMIT_INVALID')
if (providerProfile.provider === 'mock') throw new Error('Real-provider evaluations cannot use the mock provider')
const apiKeyEnv = providerProfile.apiKeyEnv ?? (providerProfile.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : providerProfile.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY')
if (providerProfile.provider !== 'ollama' && !process.env[apiKeyEnv]) throw new Error(`Provider credential is unavailable in environment variable ${apiKeyEnv}`)
if (!has('--resume')) await mkdir(outputRoot, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; throw new Error(`Output directory already exists: ${outputRoot}; use --resume to retain prior trials`) })
const batchPath = join(outputRoot, 'batch.json'), runsPath = join(outputRoot, 'runs.jsonl')
const batchIdentity = { schemaVersion: 1, dataset: fingerprint(dataset), tasks: tasks.map(task => task.id), trials, model: { reference: modelName, modelCode: selection.modelCode, provider: selection.providerCode, configuration: fingerprint({ profile: providerProfile, model: modelRow }) }, cli: { kind: archivePath ? 'archive' : 'local', hash: createHash('sha256').update(await readFile(archivePath ?? localCliPath)).digest('hex') }, maxCalls, maxTurns, maxRunMs, maxOutputTokens, maxCost: maxCost ?? null, maxTotalTokens, costCurrency }
const previousRecords = has('--resume') ? await readRunRecords(runsPath) : []
let batch = has('--resume') ? await readJson(batchPath) : { identity: batchIdentity, trials: {} }
if (fingerprint(batch.identity) !== fingerprint(batchIdentity)) throw new Error('EVAL_BATCH_IDENTITY_MISMATCH')
if (!batch.trials || typeof batch.trials !== 'object' || Object.values(batch.trials).some(state => !state || !['running', 'recorded'].includes(state.status) || !Number.isSafeInteger(state.maxModelCalls) || state.maxModelCalls < 1 || state.maxModelCalls > maxCalls || state.reservedTokens !== state.maxModelCalls * (contextLimit + maxOutputTokens) || !Number.isSafeInteger(state.startedAt))) throw new Error('EVAL_BATCH_JOURNAL_CORRUPT')
const selectedIds = new Set(tasks.map(task => task.id))
if (previousRecords.some(row => !selectedIds.has(row.taskId) || row.trial > trials)) throw new Error('EVAL_RECORD_OUTSIDE_BATCH')
const releaseLock = await acquireBatchLock(outputRoot, has('--resume'))
if (!has('--resume')) await saveJson(batchPath, batch)
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
  const modelIdentity = { displayName: modelRow.displayName ?? modelName, reference: modelName, modelCode: modelRow.modelCode, provider: selection.providerCode }
  const reportsPath = join(outputRoot, 'report.json')
const inherited = historicalAccounting(previousRecords, costCurrency)
const records = inherited.records
const fullSuiteSelected = selected === undefined && tasks.length === 24 && trials >= 3
let consumedTokens = inherited.tokens
let consumedCostUnknown = inherited.costUnknown
let budgetStopped = consumedTokens >= maxTotalTokens || inherited.unknownTokenRuns > 0 || (maxCost !== undefined && (consumedCostUnknown || inherited.knownCost >= maxCost))
  for (const pending of selectPendingTrials(tasks, trials, previousRecords)) {
    const task = tasks.find(task => task.id === pending.taskId), trial = pending.trial, key = trialKey(task.id, trial)
    if (budgetStopped) break
    const prior = batch.trials[key]
    const reservedElsewhere = Object.entries(batch.trials).filter(([otherKey, state]) => otherKey !== key && state.status === 'running' && !records.some(row => trialKey(row.taskId, row.trial) === otherKey)).reduce((sum, [, state]) => sum + state.reservedTokens, 0)
    const tokensForTask = prior?.maxModelCalls ?? Math.min(maxCalls, Math.floor((maxTotalTokens - consumedTokens - reservedElsewhere) / (contextLimit + maxOutputTokens)))
    if (prior && consumedTokens + reservedElsewhere + prior.reservedTokens > maxTotalTokens) { budgetStopped = true; break }
    if (tokensForTask !== undefined && tokensForTask < 1) { budgetStopped = true; break }
    const taskRoot = join(outputRoot, 'workspaces', task.id, `trial-${trial}`)
    const dataDir = join(outputRoot, 'pulse-data', task.id, `trial-${trial}`)
    if (!prior) {
    await mkdir(dirname(taskRoot), { recursive: true })
    await mkdir(taskRoot)
    for (const [relativePath, value] of Object.entries(task.fixtures ?? {})) {
      const target = resolve(taskRoot, relativePath)
      const fromTaskRoot = relative(taskRoot, target)
      if (fromTaskRoot === '' || fromTaskRoot === '..' || fromTaskRoot.startsWith(`..${sep}`) || isAbsolute(fromTaskRoot)) {
        throw new Error(`fixture path must resolve to a file inside its workspace: ${relativePath}`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, value, { flag: 'wx' })
    }
    batch.trials[key] = { status: 'running', startedAt: Date.now(), maxModelCalls: tokensForTask, reservedTokens: tokensForTask * (contextLimit + maxOutputTokens) }
    await saveJson(batchPath, batch)
    }
    const capturePath = join(outputRoot, 'captures', `${task.id}-trial-${trial}.json`)
    let captured = await readJson(capturePath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    let invocation = ['run', task.prompt]
    if (prior && !captured) {
      const recovered = await recoverTrial(dataDir, prior)
      if (recovered.captured) captured = recovered.captured
      else invocation = ['resume', recovered.conversationId]
      batch.trials[key].runId = recovered.runId
    }
    if (!captured && Date.now() - batch.trials[key].startedAt >= maxRunMs) throw new Error('EVAL_TRIAL_DEADLINE_EXPIRED')
    const cliArgs = [bin, ...invocation, '--cwd', taskRoot, '--data-dir', dataDir, '--config', configPath, '--model', modelName, '--format', 'jsonl', '--approval-mode', 'auto', ...buildEvaluationArgs({ maxModelCalls: tokensForTask, maxTurns }), '--max-output-tokens', String(maxOutputTokens), ...(task.sideEffects.network ? ['--allow-network'] : ['--no-network'])]
    const started = performance.now()
    if (!captured) captured = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, cliArgs, { cwd: taskRoot, env: { ...process.env, PULSE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
      batch.trials[key].childPid = child.pid
      const journaled = saveJson(batchPath, batch)
      let stdout = ''; let stderr = ''; let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref() }, Math.max(1, maxRunMs - (Date.now() - batch.trials[key].startedAt)))
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('exit', (code, signal) => { clearTimeout(timer); journaled.then(() => resolvePromise({ stdout, stderr, code: code ?? (signal ? 128 : 1), signal, timedOut }), reject) })
    })
    await mkdir(dirname(capturePath), { recursive: true })
    captured.elapsedMs ??= Date.now() - batch.trials[key].startedAt
    await saveJson(capturePath, captured)
    const elapsedMs = captured.elapsedMs ?? Math.max(Math.round(performance.now() - started), Date.now() - batch.trials[key].startedAt)
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
    if (typeof usage?.modelCalls === 'number' && usage.modelCalls > tokensForTask) throw new Error('EVAL_PROVIDER_BUDGET_VIOLATED')
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
      requestedModelCalls: tokensForTask,
      budgetVerified: await verifyTrialBudget(dataDir, finalResult?.runId, tokensForTask, usage?.modelCalls),
    }
    completedTrials([record])
    records.push(record)
    consumedTokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
    if (maxTotalTokens !== undefined && (typeof usage?.inputTokens !== 'number' || typeof usage?.outputTokens !== 'number')) budgetStopped = true
    if (!usage?.providerCosts?.some(cost => cost.currency === costCurrency)) consumedCostUnknown = true
    if (maxCost !== undefined) {
      if (!usage?.providerCosts?.some(cost => cost.currency === costCurrency)) { consumedCostUnknown = true; budgetStopped = true }
      if (records.reduce((sum, item) => sum + (item.usage?.providerCosts ?? []).filter(cost => cost.currency === costCurrency).reduce((costSum, cost) => costSum + cost.amount, 0), 0) >= maxCost) budgetStopped = true
    }
    await writeFile(runsPath, `${JSON.stringify(record)}\n`, { flag: 'a' })
    batch.trials[key].status = 'recorded'
    await saveJson(batchPath, batch)
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
    budget: { stoppedBeforeNextRun: budgetStopped, consumedCostUnknown, maxModelCallsPerTrial: maxCalls, maxTurnsPerAttempt: maxTurns, providerCallLimitRequested: true, providerCallLimitEnforced: records.length > 0 && records.every(row => row.budgetVerified === true), tokenLimitEnforced: false, maxRunMs, maxOutputTokens, maxCost: maxCost ?? null, costCurrency, maxTotalTokens: maxTotalTokens ?? null, actualTokens: actualTokenTotal, unknownTokenRuns: records.filter(row => typeof row.usage?.inputTokens !== 'number' || typeof row.usage?.outputTokens !== 'number').length, actualCosts: Object.fromEntries(uniqueCosts), usageCompleteRuns, costLimitEnforced: false, note: 'max-model-calls (legacy alias max-calls) bounds cumulative attempts per work run; max-turns remains independent. Enforcement is confirmed only when every saved Host ledger matches the requested limit and reported usage; missing ledgers are unverified. Interrupted trials resume the same Host run and original budget. Token reservation is conservative, not an exact token ceiling. Unknown usage stops further trials; an explicit cost ceiling also stops on unknown prices. Cost is checked between trials and can exceed its ceiling within a trial.' },
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
  await releaseLock()
}
