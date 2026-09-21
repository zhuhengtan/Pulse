import { spawnSync, spawn } from 'node:child_process'
const build = spawnSync(process.execPath, [new URL('./build.mjs', import.meta.url).pathname], { stdio: 'inherit', env: { ...process.env, PULSE_DATA_DIR: process.env.PULSE_DATA_DIR ?? new URL('../../.pulse-dev/data', import.meta.url).pathname } })
if (build.status !== 0) process.exit(build.status ?? 1)
const child = spawn(process.execPath, [new URL('../../packages/cli/dist/bin.js', import.meta.url).pathname, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, PULSE_DATA_DIR: process.env.PULSE_DATA_DIR ?? new URL('../../.pulse-dev/data', import.meta.url).pathname } })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1) })
