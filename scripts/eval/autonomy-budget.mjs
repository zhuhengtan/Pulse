import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Reservation survives evaluator crashes. Unknown usage is never reclaimed.
export async function withBatchBudget(directory, id, execute, taskKey = id.replace(/-\d+$/, '')) {
  await mkdir(directory, { recursive: true })
  const lockPath = join(directory, 'budget.lock'), lock = await open(lockPath, 'wx')
  const path = join(directory, 'budget.json')
  const save = async value => { await writeFile(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(path + '.tmp', path) }
  try {
    let ledger
    try { ledger = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; ledger = { schemaVersion: 1, limit: 800, perTask: 64, attempts: [] } }
    const unlimited = ledger.schemaVersion === 2 && ledger.limit === null && ledger.perTask === null && ledger.authorization?.kind === 'explicit-user-unlimited'
    if (unlimited) {
      if (!ledger.allowedTaskKeys?.includes(taskKey)) throw Error('CASE_NOT_IN_AUTHORIZED_REGRESSION_MANIFEST')
      if (ledger.attempts.some(a => a.id === id)) throw Error('ATTEMPT_ALREADY_RECORDED')
      const attempt = { id, taskKey, state: 'reserved', charged: 0, usageKnown: false, startedAt: new Date().toISOString(), runtimeRunCeiling: 256 }
      ledger.attempts.push(attempt); await save(ledger)
      // This is Pulse's existing per-run technical boundary, not a cumulative
      // evaluation allowance. All attempts and continuations remain counted.
      const result = await execute(256)
      if (!Number.isInteger(result.modelCalls) || result.modelCalls < 0) throw Error('UNRECONCILED_MODEL_USAGE')
      Object.assign(attempt, { charged: result.modelCalls, usageKnown: true, state: 'recorded', finishedAt: new Date().toISOString(), result })
      await save(ledger); return result
    }
    if (![800, 1000].includes(ledger.limit) || ledger.perTask !== 64 || ledger.attempts.some(a => !Number.isInteger(a.charged) || a.charged < 0 || a.charged > 64)) throw Error('INVALID_BATCH_LEDGER')
    if (!ledger.attempts.every(a => typeof a.id === 'string' && ['reserved', 'recorded', 'unreconciled'].includes(a.state)) || new Set(ledger.attempts.map(a => a.id)).size !== ledger.attempts.length || Object.values(ledger.inheritedTaskCalls ?? {}).some(n => !Number.isInteger(n) || n < 0 || n > 64)) throw Error('INVALID_BATCH_LEDGER')
    // A policy reservation is not evidence of a historical execution cap.
    // Keep the original ledger intact and refuse additional model requests.
    if (ledger.attempts.some(a => a.state === 'unreconciled' && !(a.result?.upperBound === true && a.result?.evidence))) throw Error('BATCH_USAGE_UNBOUNDED: reconcile historical usage before additional model calls')
    if (ledger.attempts.some(a => a.id === id)) throw Error('ATTEMPT_ALREADY_RECORDED')
    const used = ledger.attempts.reduce((n, a) => n + a.charged, 0)
    const taskUsed = (ledger.inheritedTaskCalls?.[taskKey] ?? 0) + ledger.attempts.filter(a => (a.taskKey ?? a.id.replace(/-\d+$/, '')) === taskKey).reduce((n, a) => n + a.charged, 0)
    const maxCalls = Math.min(64 - taskUsed, ledger.limit - used)
    if (maxCalls < 4) throw Error('BATCH_BUDGET_EXHAUSTED')
    const attempt = { id, taskKey, maxCalls, charged: maxCalls, state: 'reserved', startedAt: new Date().toISOString() }
    ledger.attempts.push(attempt); await save(ledger)
    const result = await execute(maxCalls)
    if (!Number.isInteger(result.modelCalls) || result.modelCalls < 0 || result.modelCalls > maxCalls) throw Error('UNRECONCILED_MODEL_USAGE')
    Object.assign(attempt, { charged: result.modelCalls, state: 'recorded', finishedAt: new Date().toISOString(), result })
    await save(ledger)
    return result
  } finally { await lock.close(); await unlink(lockPath) }
}
