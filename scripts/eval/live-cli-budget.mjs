import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withBatchBudget } from './autonomy-budget.mjs'

async function counters(directory, values = new Map()) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return values; throw e }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await counters(path, values)
    else if (entry.isFile() && entry.name === 'model-budget.json') {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (value.schemaVersion !== 1 || !Number.isInteger(value.used) || value.used < 0) throw Error('UNRECONCILED_MODEL_USAGE')
      values.set(path, value.used)
    }
  }
  return values
}

/** Legacy live tests must share the same durable batch and logical-workspace cap. */
export async function withLiveCliBudget(configPath, batchDirectory, id, execute) {
  if (!batchDirectory) throw Error('PULSE_LIVE_BATCH_DIR_REQUIRED: explicitly select the retained batch ledger')
  const original = JSON.parse(await readFile(configPath, 'utf8'))
  if (typeof original.dataDir !== 'string') throw Error('LIVE_DATA_DIRECTORY_REQUIRED')
  const directory = resolve(original.dataDir), taskKey = `legacy-workspace:${directory}`
  let output
  await withBatchBudget(batchDirectory, id, async maxCalls => {
    const before = await counters(directory)
    await writeFile(configPath, JSON.stringify({ ...original, maxModelCalls: maxCalls }, null, 2), { mode: 0o600 })
    try { output = await execute() } finally {
      const current = JSON.parse(await readFile(configPath, 'utf8'))
      if (current.maxModelCalls !== maxCalls) throw Error('LIVE_BUDGET_CHANGED_EXTERNALLY')
      if (original.maxModelCalls === undefined) delete current.maxModelCalls; else current.maxModelCalls = original.maxModelCalls
      await writeFile(configPath, JSON.stringify(current, null, 2), { mode: 0o600 })
    }
    const after = await counters(directory)
    if ([...before].some(([path, used]) => !after.has(path) || after.get(path) < used)) throw Error('UNRECONCILED_MODEL_USAGE')
    const modelCalls = [...after].reduce((total, [path, used]) => total + used - (before.get(path) ?? 0), 0)
    return { modelCalls, exitCode: output?.code ?? null, dataDir: directory }
  }, taskKey)
  return output
}
