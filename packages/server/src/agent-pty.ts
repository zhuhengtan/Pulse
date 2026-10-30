import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ShellSpawn } from '@hunterzhu/pulse-adapters'

const require = createRequire(import.meta.url)
export type PtyInput = (data: string) => void

/** Agent-owned PTY: exact SRT argv, never the H5 user's login shell/session. */
function loadPty(): typeof import('node-pty') {
  if (process.platform === 'win32') throw Object.assign(new Error('AGENT_PTY_UNAVAILABLE'), { code: 'AGENT_PTY_UNAVAILABLE' })
  // Verify the helper selected by node-pty itself. Do not chmod or provision
  // anything in the installation just to enable an optional run capability.
  const entry = require.resolve('node-pty')
  const utils = require(join(dirname(entry), 'utils.js')) as { loadNativeModule(name: string): { dir: string } }
  const native = utils.loadNativeModule('pty')
  const helper = join(dirname(entry), native.dir, 'spawn-helper').replace('app.asar', 'app.asar.unpacked').replace('node_modules.asar', 'node_modules.asar.unpacked')
  accessSync(helper, constants.X_OK)
  return require('node-pty') as typeof import('node-pty')
}
export function assertAgentPtyAvailable(): void {
  try { loadPty() } catch (cause) { throw Object.assign(new Error('AGENT_PTY_UNAVAILABLE'), { code: 'AGENT_PTY_UNAVAILABLE', retryable: false, cause }) }
}
export function agentPtySpawn(ready: (write: PtyInput) => void): ShellSpawn {
  assertAgentPtyAvailable()
  const pty = loadPty()
  return (argv, options) => {
    if (!argv[0]) throw new Error('AGENT_PTY_SANDBOX_ARGV_MISSING')
    const terminal = pty.spawn(argv[0], [...argv.slice(1)], { cwd: options.cwd, env: options.env as Record<string, string>, name: 'xterm-256color', cols: 100, rows: 30 })
    const events = new EventEmitter(), output = new EventEmitter()
    terminal.onData(data => output.emit('data', Buffer.from(data)))
    terminal.onExit(event => events.emit('close', event.exitCode))
    ready(data => terminal.write(data))
    return {
      pid: terminal.pid,
      stdout: output,
      stderr: null,
      stdin: null,
      once: events.once.bind(events),
      kill(signal) { try { terminal.kill(signal); return true } catch { return false } },
    }
  }
}
