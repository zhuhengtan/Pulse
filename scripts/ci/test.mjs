import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { makeTestPlan } from './test-plan.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
// Stop on a confirmed failure instead of spending another native sandbox batch
// before reporting it. A passing candidate still executes the entire non-Live suite.
export const ciVitestArgs = ['run', '--exclude', 'tests/live/**', '--maxWorkers=2', '--minWorkers=1', '--bail=1']

export function ciVitestEntry(root = repo) {
  return {
    command: process.execPath,
    script: join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    args: ciVitestArgs,
  }
}

function launchedDirectly() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try { return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (launchedDirectly()) {
  const entry = ciVitestEntry()
  try { await access(entry.script) } catch {
    console.error(`VITEST_NOT_INSTALLED: ${entry.script}`)
    process.exit(1)
  }
  const directory = await mkdtemp(join(tmpdir(), 'pulse-check-'))
  const home = join(directory, 'home')
  const env = {
    ...process.env,
    PULSE_HOME: home,
    PULSE_CONFIG: join(home, 'config.json'),
    PULSE_DATA_DIR: join(home, 'data'),
    PULSE_CLI_ARTIFACTS_DIR: join(repo, 'artifacts/cli'),
    PULSE_INSPECTOR: '127.0.0.1:0',
    PULSE_INSPECT_BRK: '0',
  }
  try {
    if (!env.PULSE_CI_GUARD_OWNER) await rm(join(repo, '.pulse-dev/ci-network-attempts.jsonl'), { force: true })
    env.PULSE_CI_GUARD_OWNER = '1'
    env.PULSE_CI_NETWORK_LOG ??= join(directory, 'network-attempts.jsonl')
    env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(join(repo, 'scripts/ci/network-guard.mjs')).href
    const options = process.argv.slice(2)
    if (options.some(arg => !/^--shard=[1-4]$/.test(arg)) || options.length > 1) throw Error('INVALID_CI_TEST_ARGUMENTS')
    const shard = options.length ? Number(options[0].slice(8)) : undefined
    const plan = { ...await makeTestPlan(repo, shard), root: repo.replace(/[\\/]$/, '') }
    const planFile = join(directory, 'test-plan.json')
    await writeFile(planFile, JSON.stringify(plan)); env.PULSE_CI_TEST_PLAN = planFile
    const args = [...entry.args, '--reporter=default', '--reporter=' + join(repo, 'scripts/ci/test-reporter.mjs')]
    if (shard !== undefined) {
      const config = join(directory, 'vitest.config.mjs')
      await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(join(repo, 'vitest.config.ts')).href)};export default {...base,root:${JSON.stringify(repo)},test:{...base.test,include:${JSON.stringify(plan.files)},fileParallelism:false}}`)
      args.push('--config', config)
    }
    console.log('[ci:plan] ' + JSON.stringify({ shard: plan.shard, files: plan.files.length, totalFiles: plan.totalFiles, inventoryHash: plan.inventoryHash }))
    const result = spawnSync(entry.command, [entry.script, ...args], { cwd: repo, env, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
    for (const file of [env.PULSE_CI_NETWORK_LOG, join(repo, '.pulse-dev/ci-network-attempts.jsonl')]) {
      const attempts = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (attempts.trim()) { console.error('UNEXPECTED_CI_NETWORK_ATTEMPT:' + attempts); process.exitCode = 1 }
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
