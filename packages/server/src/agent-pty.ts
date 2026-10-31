import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { release } from 'node:os'
import { PassThrough } from 'node:stream'
import { windowsPtyProtocol, type ShellSpawn } from '@hunterzhu/pulse-adapters'

const require = createRequire(import.meta.url)
export type PtyInput = (data: string) => void | Promise<void>
const INPUT_ACK_MS = 15_000

/** Agent-owned PTY: exact SRT argv, never the H5 user's login shell/session. */
function loadPty(): typeof import('node-pty') {
  // Verify the helper selected by node-pty itself. Do not chmod or provision
  // anything in the installation just to enable an optional run capability.
  const entry = require.resolve('node-pty')
  const utils = require(join(dirname(entry), 'utils.js')) as { loadNativeModule(name: string): { dir: string } }
  if (process.platform === 'win32') {
    // node-pty otherwise silently selects winpty on older Windows. This surface
    // requires ConPTY (Windows 10 1903+) and never installs a fallback runtime.
    const [major, , build] = release().split('.').map(Number)
    if (!major || major < 10 || major === 10 && (!build || build < 18309)) throw new Error('CONPTY_REQUIRED')
    utils.loadNativeModule('conpty')
    return require('node-pty') as typeof import('node-pty')
  }
  const native = utils.loadNativeModule('pty')
  const helper = join(dirname(entry), native.dir, 'spawn-helper').replace('app.asar', 'app.asar.unpacked').replace('node_modules.asar', 'node_modules.asar.unpacked')
  accessSync(helper, constants.X_OK)
  return require('node-pty') as typeof import('node-pty')
}
export function assertAgentPtyAvailable(): void {
  try { loadPty() } catch (cause) { throw Object.assign(new Error('AGENT_PTY_UNAVAILABLE'), { code: 'AGENT_PTY_UNAVAILABLE', retryable: false, cause }) }
}
function agentPtySpawn(ready: (write: PtyInput) => void): ShellSpawn {
  assertAgentPtyAvailable()
  const pty = loadPty()
  return (argv, options) => {
    if (!argv[0]) throw new Error('AGENT_PTY_SANDBOX_ARGV_MISSING')
    const terminal = pty.spawn(argv[0], [...argv.slice(1)], { cwd: options.cwd, env: options.env as Record<string, string>, name: 'xterm-256color', cols: 100, rows: 30 })
    const events = new EventEmitter(), output = new EventEmitter()
    terminal.onData(data => output.emit('data', Buffer.from(data)))
    terminal.onExit(event => events.emit('close', event.exitCode))
    try { ready(data => terminal.write(data)) }
    catch (error) {
      try { terminal.kill() } catch { /* The terminal is already gone. */ }
      throw error
    }
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

function killWindowsBroker(child: { pid?: number | undefined; exitCode?: number | null; signalCode?: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean }): void {
  const pid = child.pid
  if (!pid || child.exitCode != null || child.signalCode != null) return
  const tree = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  tree.once('error', () => { if (child.pid === pid && child.exitCode == null && child.signalCode == null) child.kill() })
  tree.unref()
}

function windowsBrokerTransport(scope: string, ready: (write: PtyInput) => void): ShellSpawn {
  return (argv, options) => {
    if (!argv[0]) throw new Error('AGENT_PTY_SANDBOX_ARGV_MISSING')
    // Still launch the exact verified SRT broker, without a host shell. Its
    // existing Job and runShell's taskkill /T own the whole descendant tree.
    const child = spawn(argv[0], [...argv.slice(1)], { ...options, shell: false, windowsHide: true, stdio: 'pipe' })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    const events = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const windowsPtyExit: { framed: boolean; unknown: boolean; code?: number } = { framed: false, unknown: false }
    const buffered: Buffer[] = []
    const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
    let published = false
    const failPending = (error: Error): void => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
      pending.clear()
    }
    const publish = (): void => {
      if (published) return
      published = true
      const send: PtyInput = (data) => new Promise((resolve, reject) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed || !child.stdin.writable) { reject(new Error('SHELL_STDIN_NOT_READY')); return }
        const id = randomBytes(16).toString('hex')
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('SHELL_STDIN_UNCONFIRMED')) }, INPUT_ACK_MS)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(windowsPtyProtocol.encodeFrame({ type: 'input', scope, id, data }))
      })
      try { ready(send) }
      catch (error) {
        killWindowsBroker(child)
        events.emit('error', error instanceof Error ? error : new Error('SHELL_STDIN_NOT_READY'))
        return
      }
      for (const chunk of buffered.splice(0)) stdout.write(chunk)
    }
    const parse = windowsPtyProtocol.createParser((message) => {
      if (message.scope !== scope) return
      if (message.type === 'ready') publish()
      else if (message.type === 'ack' || message.type === 'nack') {
        const item = pending.get(message.id)
        if (!item) return
        clearTimeout(item.timer)
        pending.delete(message.id)
        if (message.type === 'ack') item.resolve()
        else item.reject(new Error('SHELL_STDIN_UNCONFIRMED'))
      } else if (message.type === 'exit' && windowsPtyProtocol.isWindowsExitCode(message.code)) {
        windowsPtyExit.framed = true
        windowsPtyExit.unknown = false
        windowsPtyExit.code = message.code
      } else if (message.type === 'exitUnknown' || message.type === 'exit') {
        windowsPtyExit.framed = true
        windowsPtyExit.unknown = true
      }
    })
    child.stdout?.on('data', (chunk: Buffer) => { if (published) stdout.write(chunk); else buffered.push(Buffer.from(chunk)) })
    child.stderr?.on('data', (chunk: Buffer) => { const plain = parse(chunk); if (plain.length) stderr.write(plain) })
    child.once('close', (code) => { failPending(new Error('SHELL_STDIN_NOT_READY')); stdout.end(); stderr.end(); events.emit('close', code) })
    child.once('error', (error) => events.emit('error', error))
    return {
      pid: child.pid,
      get exitCode() { return child.exitCode },
      get signalCode() { return child.signalCode },
      stdout, stderr, stdin: null, windowsPtyExit,
      once: events.once.bind(events),
      kill: child.kill.bind(child),
    }
  }
}

/** Windows' SRT runner uses pipes and CREATE_NO_WINDOW. The ConPTY must be
 * created INSIDE that runner's restricted token/job, not around its broker. */
export function agentPtyShellOptions(ready: (write: PtyInput) => void): { spawnProcess: ShellSpawn; windowsPty?: { modulePath: string; scope: string } } {
  if (process.platform !== 'win32') return { spawnProcess: agentPtySpawn(ready) }
  assertAgentPtyAvailable()
  const scope = randomBytes(16).toString('hex')
  return { windowsPty: { modulePath: require.resolve('node-pty'), scope }, spawnProcess: windowsBrokerTransport(scope, ready) }
}
