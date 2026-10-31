import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
export const ciVitestArgs = ['run', '--exclude', 'tests/live/**', '--maxWorkers=2', '--minWorkers=1']

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
    const result = spawnSync(entry.command, [entry.script, ...entry.args], { cwd: repo, env, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
