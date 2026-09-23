import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
try { await access(entry) } catch { console.error('CLI build is missing. Run pnpm cli:build first.'); process.exit(2) }
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1) })
