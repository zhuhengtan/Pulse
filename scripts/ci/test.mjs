import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
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
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    'exec', 'vitest', 'run', '--exclude', 'tests/live/**', '--maxWorkers=2', '--minWorkers=1',
  ], { cwd: repo, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
