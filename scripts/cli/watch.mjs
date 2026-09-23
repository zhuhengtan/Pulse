import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
const child = spawn(process.execPath, [compiler, '-b', '--pretty', 'false', '--watch'], { cwd: repo, stdio: 'inherit', env: process.env })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1) })
