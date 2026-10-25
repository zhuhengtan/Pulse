import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UpdateManager } from './manager.js'
import { readState } from './store.js'

/** This file and its bundled Node live in an immutable base runtime. */
export async function launchManaged(root: string, base: string, args: string[]): Promise<number> {
  const at = args.indexOf('--data-dir'), directory = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : process.env.PULSE_DATA_DIR ?? join(root, 'data'))
  let runtime = base
  const state = await readState(root, directory)
  const active = state.phase === 'applying' ? state.previous?.backend : state.active.backend
  const version = (JSON.parse(await readFile(join(base, 'app/node_modules/@hunterzhu/pulse-cli/package.json'), 'utf8')) as { version: string }).version
  const manager = new UpdateManager({ root, dataDir: directory, backendVersion: version })
  const recoveryCommand = args[0] === 'update' || args[0] === 'h5'
  if (active && !recoveryCommand) { await manager.verifyInstalled(active); runtime = active.directory }
  const manifest = JSON.parse(await readFile(join(runtime, 'desktop-runtime.json'), 'utf8')) as { buildId: string; browserExecutable?: string }
  return new Promise((resolveExit, reject) => {
    const child = spawn(join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'), [join(runtime, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), ...args], { stdio: 'inherit', env: { ...process.env, PULSE_HOME: root, PULSE_MANAGED: '1', PULSE_RUNTIME_DIR: runtime, PULSE_BOOTSTRAP_RUNTIME: base, PULSE_RUNTIME_ID: createHash('sha256').update(manifest.buildId + runtime).digest('hex'), ...(manifest.browserExecutable ? { PULSE_BROWSER_EXECUTABLE: join(runtime, manifest.browserExecutable) } : {}) } })
    process.once('SIGTERM', () => child.kill('SIGTERM')); process.once('SIGINT', () => child.kill('SIGINT'))
    child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1))
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, base, ...args] = process.argv.slice(2)
  if (!root || !base) throw new Error('MANAGED_LAUNCHER_INVALID')
  process.exitCode = await launchManaged(root, base, args)
}
