import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const dataDir = join(repo, '.pulse-dev', 'data')
const build = spawnSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url))], { cwd: repo, stdio: 'inherit', env: { ...process.env, PULSE_DATA_DIR: process.env.PULSE_DATA_DIR ?? dataDir } })
if (build.status !== 0) process.exit(build.status ?? 1)
const child = spawn(process.execPath, [fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url)), ...process.argv.slice(2)], { cwd: repo, stdio: 'inherit', env: { ...process.env, PULSE_DATA_DIR: process.env.PULSE_DATA_DIR ?? dataDir } })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1) })
