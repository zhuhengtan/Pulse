import { spawn } from 'node:child_process'
const child = spawn('pnpm', ['exec', 'tsc', '-b', '--pretty', 'false', '--watch'], { stdio: 'inherit', env: process.env })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1) })
