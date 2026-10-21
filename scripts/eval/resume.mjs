import { ConversationData } from '../../packages/data/dist/index.js'
import { readFile, writeFile, rename, open, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const terminal = new Set(['passed', 'partial', 'failed', 'blocked_env', 'succeeded', 'cancelled', 'timeout'])
export const trialKey = (taskId, trial) => `${taskId}:${trial}`
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

export function completedTrials(records) {
  const completed = new Map()
  for (const row of records) {
    if (!row || typeof row.taskId !== 'string' || !Number.isSafeInteger(row.trial) || row.trial < 1 || typeof row.status !== 'string') throw new Error('EVAL_RECORD_INVALID')
    if (!terminal.has(row.status) && !['running', 'pending', 'not_run'].includes(row.status)) throw new Error('EVAL_RECORD_STATUS_INVALID')
    if (row.usage != null) {
      for (const key of ['modelCalls', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']) if (row.usage[key] != null && (!Number.isSafeInteger(row.usage[key]) || row.usage[key] < 0)) throw new Error('EVAL_RECORD_USAGE_INVALID')
      if (row.usage.providerCosts != null && (!Array.isArray(row.usage.providerCosts) || row.usage.providerCosts.some(cost => typeof cost.currency !== 'string' || !Number.isFinite(cost.amount) || cost.amount < 0))) throw new Error('EVAL_RECORD_COST_INVALID')
    }
    if (!terminal.has(row.status)) continue
    const key = trialKey(row.taskId, row.trial), previous = completed.get(key)
    if (previous && fingerprint(previous) !== fingerprint(row)) throw new Error(`EVAL_RECORD_CONFLICT:${key}`)
    completed.set(key, row)
  }
  return [...completed.values()]
}
/** One terminal view feeds both resume admission and reports; raw JSONL stays intact. */
export function historicalAccounting(history, currency) {
  const records = completedTrials(history)
  return {
    records,
    tokens: records.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0), 0),
    unknownTokenRuns: records.filter(row => typeof row.usage?.inputTokens !== 'number' || typeof row.usage?.outputTokens !== 'number').length,
    costUnknown: records.some(row => !row.usage?.providerCosts?.some(cost => cost.currency === currency)),
    knownCost: records.reduce((sum, row) => sum + (row.usage?.providerCosts ?? []).filter(cost => cost.currency === currency).reduce((total, cost) => total + cost.amount, 0), 0),
  }
}
export function selectPendingTrials(tasks, trials, records) {
  if (!Number.isSafeInteger(trials) || trials < 1) throw new Error('EVAL_TRIALS_INVALID')
  const done = new Set(completedTrials(records).map(row => trialKey(row.taskId, row.trial)))
  return tasks.flatMap(task => Array.from({ length: trials }, (_, i) => ({ taskId: task.id, trial: i + 1 }))).filter(row => !done.has(trialKey(row.taskId, row.trial)))
}
export async function readRunRecords(path) {
  let raw
  try { raw = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const records = raw.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line) } catch { throw new Error(`EVAL_JSONL_CORRUPT:line ${index + 1}`) }
  })
  completedTrials(records) // Validate before making any persistent changes.
  return records
}
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')) }
export async function saveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('EVAL_LOCK_INVALID')
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; return true }
}
export async function acquireBatchLock(output, resume) {
  const path = join(output, '.runner.lock')
  let handle
  try { handle = await open(path, 'wx', 0o600) } catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw error
    const saved = await readJson(path)
    if (alive(saved.pid)) throw new Error('EVAL_BATCH_ALREADY_RUNNING')
    await unlink(path)
    handle = await open(path, 'wx', 0o600)
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }))
  return async () => { await handle.close(); await unlink(path) }
}

// Recover original Host identity, never start another run against a dirty trial.
export async function recoverTrial(dataDir, state) {
  if (state.childPid && alive(state.childPid)) throw new Error('EVAL_TRIAL_PROCESS_STILL_RUNNING')
  const conversations = join(dataDir, 'conversations')
  let entries
  try { entries = await readdir(conversations, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') throw new Error('EVAL_INTERRUPTED_TRIAL_REQUIRES_AUDIT'); throw error }
  const ids = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  if (ids.length !== 1) throw new Error('EVAL_INTERRUPTED_TRIAL_IDENTITY_AMBIGUOUS')
  const id = ids[0], data = new ConversationData(dataDir)
  let manifest
  try { manifest = await data.call('get', id) } finally { data.close() }
  const runId = manifest.activeRunId ?? manifest.runs?.at(-1)
  if (!/^run-[\w-]+$/.test(runId ?? '')) throw new Error('EVAL_INTERRUPTED_RUN_MISSING')
  if (state.runId && state.runId !== runId) throw new Error('EVAL_INTERRUPTED_RUN_CHANGED')
  const runDir = join(conversations, id, 'runs', runId)
  if (manifest.activeRunId) {
    const budget = await readJson(join(runDir, 'model-budget.json'))
    if (budget.schemaVersion !== 1 || budget.limit !== state.maxModelCalls || !Number.isSafeInteger(budget.used) || budget.used < 0 || budget.used > budget.limit) throw new Error('EVAL_INTERRUPTED_BUDGET_MISMATCH')
    return { conversationId: id, runId }
  }
  const saved = await readJson(join(runDir, 'outcome.json'))
  const usage = await readJson(join(runDir, 'usage.json')).catch(error => { if (error.code === 'ENOENT') return saved.usage ?? null; throw error })
  return { conversationId: id, runId, captured: { stdout: JSON.stringify({ ...saved, type: 'result', runId, usage }) + '\n', stderr: '', code: saved.status === 'succeeded' ? 0 : 1, timedOut: false } }
}

export async function verifyTrialBudget(dataDir, runId, limit, modelCalls) {
  if (!/^run-[\w-]+$/.test(runId ?? '') || !Number.isSafeInteger(modelCalls)) return false
  let entries
  try { entries = await readdir(join(dataDir, 'conversations'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  const directories = entries.filter(entry => entry.isDirectory())
  if (directories.length !== 1) return false
  const path = join(dataDir, 'conversations', directories[0].name, 'runs', runId, 'model-budget.json')
  const budget = await readJson(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  return budget?.schemaVersion === 1 && budget.limit === limit && budget.used === modelCalls && modelCalls >= 0 && modelCalls <= limit
}
