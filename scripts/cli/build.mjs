import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
const result = spawnSync(process.execPath, [compiler, '-b', '--pretty', 'false'], { cwd: repo, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
