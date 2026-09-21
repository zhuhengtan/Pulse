import { spawnSync } from 'node:child_process'
const result = spawnSync('pnpm', ['exec', 'tsc', '-b', '--pretty', 'false'], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
