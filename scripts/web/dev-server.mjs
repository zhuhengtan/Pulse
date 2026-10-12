import { mkdir } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const dataDir = join(repo, '.pulse-dev', 'h5', 'data')
const entry = join(repo, 'packages', 'cli', 'dist', 'bin.js')
const port = process.env.PULSE_WEB_DEV_PORT ?? '7333'

if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('PULSE_WEB_DEV_PORT must be an integer from 1 to 65535.')
  process.exit(2)
}

// Keep dev chats and pairing isolated, but let the CLI resolve provider/model
// settings exactly as it does for regular `pulse` commands (PULSE_CONFIG,
// PULSE_HOME, then ~/.pulse).
const env = { ...process.env, PULSE_DATA_DIR: dataDir, PULSE_H5_HOST: '127.0.0.1' }
await mkdir(dataDir, { recursive: true })

const build = spawnSync(process.execPath, [join(repo, 'scripts', 'cli', 'build.mjs')], { cwd: repo, stdio: 'inherit', env })
if (build.status !== 0) process.exit(build.status ?? 1)

const child = spawn(process.execPath, [entry, 'h5', 'start', '--port', port], { cwd: repo, stdio: 'inherit', env })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1) })
