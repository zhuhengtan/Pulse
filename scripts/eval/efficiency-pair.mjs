// Serial, resumable comparison. No completed (including failed) trial is replayed.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireBatchLock } from './resume.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1]
for (const key of ['--out', '--config', '--baseline']) if (!args.includes(key)) throw new Error(`Required: ${key}`)
const out = resolve(option('--out')), config = resolve(option('--config')), baseline = resolve(option('--baseline'))
const candidate = args.includes('--candidate') ? resolve(option('--candidate')) : undefined
// Reject incomplete packages before creating a trial or charging its allowance.
for (const archive of [baseline, candidate].filter(Boolean)) {
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (listing.status !== 0 || !listing.stdout.split('\n').includes('pulse/bin/pulse.js')) throw new Error('EVAL_ARCHIVE_ENTRY_MISSING')
}
const sha = value => createHash('sha256').update(value).digest('hex')
await mkdir(out, { recursive: true })
const release = await acquireBatchLock(out, true)
try {
  const frozenPath = join(out, 'model-config.json')
  let frozen
  try { frozen = await readFile(frozenPath, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const original = JSON.parse(await readFile(config, 'utf8'))
    // Keep the model/approval settings but never involve personal memory in fixtures.
    frozen = JSON.stringify({ ...original, jarvis: { enabled: false }, taskControllerPolicy: 'legacy' })
    await writeFile(frozenPath, frozen, { flag: 'wx', mode: 0o600 })
  }
  const model = JSON.parse(frozen).activeModel
  if (!model) throw new Error('A configured activeModel is required')
  const identityPath = join(out, 'comparison.json')
  const identity = { version: 1, model, configHash: sha(frozen), baselineHash: sha(await readFile(baseline)), tasks: ['code-04', 'research-07', 'files-02'], callLimit: 192, callsPerTrial: 32, tokenStopThreshold: 500_000, timeoutMs: 600_000 }
  let saved
  try { saved = JSON.parse(await readFile(identityPath, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (saved && JSON.stringify(saved.identity) !== JSON.stringify(identity)) throw new Error('COMPARISON_IDENTITY_CHANGED')
  const candidateHash = candidate ? sha(await readFile(candidate)) : undefined
  if (saved?.candidateHash && candidateHash && saved.candidateHash !== candidateHash) throw new Error('COMPARISON_CANDIDATE_CHANGED')
  await writeFile(identityPath, JSON.stringify({ identity, ...(candidateHash || saved?.candidateHash ? { candidateHash: candidateHash ?? saved.candidateHash } : {}) }, null, 2))
  const rows = []
  let stopped = 'complete'
  outer: for (const task of identity.tasks) for (const variant of ['baseline', 'candidate']) {
    const directory = join(out, `${task}-${variant}`)
    let row
    try { const lines = (await readFile(join(directory, 'runs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean); if (lines.length !== 1) throw new Error('EXPECTED_ONE_TRIAL'); row = JSON.parse(lines[0]) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!row) {
      if (rows.some(r => !r.budgetVerified || r.usage?.modelCalls === undefined || r.usage?.inputTokens === undefined || r.usage?.outputTokens === undefined || r.usage?.completeness !== 'complete')) { stopped = 'usage_or_budget_unverified'; break outer }
      const tokens = rows.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0)
      const calls = rows.reduce((n, r) => n + r.usage.modelCalls, 0)
      if (tokens >= identity.tokenStopThreshold || calls + identity.callsPerTrial > identity.callLimit) { stopped = 'budget'; break outer }
      const archive = variant === 'baseline' ? baseline : candidate
      if (!archive) { stopped = 'candidate_not_prepared'; break outer }
      let resume = false
      try { await readFile(join(directory, 'batch.json')); resume = true } catch (e) { if (e.code !== 'ENOENT') throw e }
      // Each one-trial batch has a fixed identity. The aggregate threshold above
      // governs whether another trial may start; an in-flight trial may exceed it.
      const command = [join(root, 'scripts/eval/run.mjs'), '--archive', archive, '--config', frozenPath, '--model', model, '--task', task, '--out', directory, '--trials', '1', '--max-model-calls', '32', '--max-turns', '32', '--max-output-tokens', '8192', '--max-run-ms', '600000', '--max-total-tokens', '500000', '--token-budget-mode', 'between-trials', '--auto-approve', ...(resume ? ['--resume'] : [])]
      const exit = await new Promise((resolveExit, reject) => { const child = spawn(process.execPath, command, { cwd: root, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => resolveExit(code)) })
      try { row = JSON.parse((await readFile(join(directory, 'runs.jsonl'), 'utf8')).trim()) } catch { stopped = `trial_incomplete:${task}:${variant}:exit=${exit}`; break outer }
    }
    rows.push({ ...row, variant })
  }
  const summary = { stopped, realTrials: rows.length, modelCalls: rows.reduce((n, r) => n + (r.usage?.modelCalls ?? 0), 0), tokens: rows.reduce((n, r) => n + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0), rows: rows.map(r => ({ task: r.taskId, variant: r.variant, status: r.status, taskOutcome: r.taskOutcome, grading: r.grading, usage: r.usage, elapsedMs: r.elapsedMs, budgetVerified: r.budgetVerified, workspace: r.workspace })) }
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ stopped, realTrials: summary.realTrials, modelCalls: summary.modelCalls, tokens: summary.tokens }))
} finally { await release() }
