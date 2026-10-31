import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ release: '10.0.19045', load: vi.fn(), pty: { spawn: vi.fn() }, spawn: vi.fn() }))
vi.mock('node:os', () => ({ release: () => fixture.release }))
vi.mock('node:module', async () => {
  const actual = await vi.importActual<typeof import('node:module')>('node:module')
  return {
    ...actual,
    createRequire: (from: string) => {
      const real = actual.createRequire(from)
      // Only node-pty and the utils path derived from its mocked entry. A POSIX
      // dirname of the backslash fixture is ".", so that helper require is "utils.js".
      // windows-pty-protocol.cjs is not either of those and stays the real module.
      const nodePtyUtils = (request: string) => request === 'utils.js' || /(?:^|[/\\])node-pty[/\\]lib[/\\]utils\.js$/.test(request)
      const nodePty = (request: string) => request === 'node-pty' || /(?:^|[/\\])node-pty(?:[/\\]|$)/.test(request)
      return Object.assign((request: string) => nodePtyUtils(request) ? { loadNativeModule: fixture.load } : nodePty(request) ? fixture.pty : real(request), {
        resolve: (request: string) => nodePty(request) ? 'C:\\Pulse\\node_modules\\node-pty\\lib\\index.js' : real.resolve(request),
      })
    },
  }
})
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))
import { windowsPtyProtocol } from '@hunterzhu/pulse-adapters'
import { agentPtyShellOptions, assertAgentPtyAvailable } from '../packages/server/src/agent-pty.js'

const platform = process.platform
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.clearAllMocks(); fixture.release = '10.0.19045'; fixture.load.mockReset() })
function windows() { Object.defineProperty(process, 'platform', { value: 'win32' }) }
function child() {
  const value = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  fixture.spawn.mockImplementation(() => value)
  return value
}

it('loads the installed ConPTY native module without probing a Unix helper or falling back to winpty', () => {
  windows()
  expect(() => assertAgentPtyAvailable()).not.toThrow()
  expect(fixture.load).toHaveBeenCalledWith('conpty')
  expect(fixture.load).not.toHaveBeenCalledWith('pty')
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(fixture.pty.spawn).not.toHaveBeenCalled()
})

it('fails closed for old Windows or missing native ConPTY, without installing or starting anything', () => {
  windows(); fixture.release = '10.0.17763'
  expect(() => assertAgentPtyAvailable()).toThrow('AGENT_PTY_UNAVAILABLE')
  expect(fixture.load).not.toHaveBeenCalled()
  fixture.release = '10.0.22631'; fixture.load.mockImplementation(() => { throw new Error('missing native') })
  expect(() => assertAgentPtyAvailable()).toThrow('AGENT_PTY_UNAVAILABLE')
  expect(fixture.spawn).not.toHaveBeenCalled()
})

it('launches only the supplied SRT broker and delivers input only after the private ConPTY acknowledgement', async () => {
  expect(windowsPtyProtocol.createParser).toBeTypeOf('function')
  windows(); const process = child(), writes: Buffer[] = []
  process.stdin.on('data', data => writes.push(Buffer.from(data)))
  let input!: (data: string) => Promise<void>
  const visible: Buffer[] = []
  const options = agentPtyShellOptions(write => { input = write as (data: string) => Promise<void> })
  expect(options.windowsPty?.modulePath).toBe('C:\\Pulse\\node_modules\\node-pty\\lib\\index.js')
  const scope = options.windowsPty!.scope
  const argv = ['C:\\Pulse\\srt-win.exe', 'exec', '--env', 'SAFE=value', '--', 'C:\\Pulse\\node.exe', 'bridge.cjs', 'literal-payload']
  const env = { PATH: 'fixed', TEMP: 'isolated' }, cwd = 'C:\\work with spaces'
  const handle = options.spawnProcess(argv, { cwd, env })
  handle.stdout?.on('data', (chunk: Buffer) => visible.push(chunk))
  expect(fixture.spawn).toHaveBeenCalledWith(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: 'pipe' })
  expect(handle.stdin).toBeNull(); expect(handle.pid).toBe(123); expect(input).toBeUndefined()
  process.stdout.write('target-before-ready')
  process.stderr.write(windowsPtyProtocol.encodeFrame({ type: 'ready', scope }))
  expect(input).toBeTypeOf('function')
  expect(Buffer.concat(visible).toString()).toBe('target-before-ready')
  const frames: Array<{ type: string; id: string; data?: string; scope: string }> = []
  const parse = windowsPtyProtocol.createParser(frame => frames.push(frame))
  const pending = input('中文\r')
  let settled = false
  void pending.then(() => { settled = true })
  parse(Buffer.concat(writes))
  expect(frames[0]).toMatchObject({ type: 'input', data: '中文\r', scope })
  expect(settled).toBe(false)
  process.stderr.write(windowsPtyProtocol.encodeFrame({ type: 'ack', scope: '00'.repeat(16), id: frames[0]!.id }))
  await Promise.resolve()
  expect(settled).toBe(false)
  process.stderr.write(windowsPtyProtocol.encodeFrame({ type: 'ack', scope, id: frames[0]!.id }))
  await pending
  expect(process.stdin.writableEnded).toBe(false)
  process.exitCode = 0
  await expect(input('again')).rejects.toThrow('SHELL_STDIN_NOT_READY')
  expect(fixture.pty.spawn).not.toHaveBeenCalled()
  expect(Buffer.concat(visible).toString()).not.toContain('PTY1')
})

it('kills the live broker when the ConPTY ready callback throws, and skips taskkill after that broker has exited', () => {
  windows()
  const broker = child(), exited = child(), tree = Object.assign(new EventEmitter(), { unref: vi.fn() })
  exited.exitCode = 0
  fixture.spawn.mockImplementation((command: string) => command === 'taskkill.exe' ? tree : broker)
  const first = agentPtyShellOptions(() => { throw new Error('scripted ready failure') })
  const handle = first.spawnProcess(['C:\\Pulse\\srt-win.exe', 'exec', '--', 'inner'], { cwd: 'C:\\work', env: {} })
  const errors: Error[] = []
  handle.once('error', error => errors.push(error))
  broker.stderr.write(windowsPtyProtocol.encodeFrame({ type: 'ready', scope: first.windowsPty!.scope }))
  expect(errors.map(error => error.message)).toEqual(['scripted ready failure'])
  expect(fixture.spawn).toHaveBeenCalledWith('taskkill.exe', ['/PID', '123', '/T', '/F'], expect.objectContaining({ stdio: 'ignore', windowsHide: true }))
  fixture.spawn.mockClear()
  fixture.spawn.mockImplementation((command: string) => command === 'taskkill.exe' ? tree : exited)
  const second = agentPtyShellOptions(() => { throw new Error('scripted ready failure') })
  const later = second.spawnProcess(['C:\\Pulse\\srt-win.exe', 'exec', '--', 'inner'], { cwd: 'C:\\work', env: {} })
  later.once('error', () => {})
  exited.stderr.write(windowsPtyProtocol.encodeFrame({ type: 'ready', scope: second.windowsPty!.scope }))
  expect(fixture.spawn).not.toHaveBeenCalledWith('taskkill.exe', expect.anything(), expect.anything())
  expect(exited.kill).not.toHaveBeenCalled()
})

it('rejects an unacknowledged or closed input once and does not restart the broker', async () => {
  windows(); const process = child()
  let input!: (data: string) => Promise<void>
  const options = agentPtyShellOptions(write => { input = write as (data: string) => Promise<void> })
  const handle = options.spawnProcess(['srt.exe', 'exec', '--', 'inner'], { cwd: 'C:\\work', env: {} })
  const errors: Error[] = []
  handle.once('error', error => errors.push(error))
  process.stderr.write(windowsPtyProtocol.encodeFrame({ type: 'ready', scope: options.windowsPty!.scope }))
  process.stdin.destroy()
  await expect(input('line\r')).rejects.toThrow('SHELL_STDIN_NOT_READY')
  process.emit('error', new Error('scripted spawn failure'))
  expect(errors.map(error => error.message)).toEqual(['scripted spawn failure'])
  await expect(input('again\r')).rejects.toThrow('SHELL_STDIN_NOT_READY')
  expect(fixture.spawn).toHaveBeenCalledTimes(1)
})

it('reassembles an exit frame split on the PTY1 prefix and keeps a 32-bit failure code', () => {
  windows(); const process = child()
  const options = agentPtyShellOptions(() => {})
  const handle = options.spawnProcess(['srt.exe', 'exec', '--', 'inner'], { cwd: 'C:\\work', env: {} }) as { windowsPtyExit?: { framed: boolean; unknown: boolean; code?: number } }
  const frame = windowsPtyProtocol.encodeFrame({ type: 'exit', scope: options.windowsPty!.scope, code: 300 })
  expect(frame.subarray(0, 2).toString()).toBe('PT')
  process.stderr.write(frame.subarray(0, 2))
  expect(handle.windowsPtyExit).toMatchObject({ framed: false, unknown: false })
  process.stderr.write(frame.subarray(2))
  expect(handle.windowsPtyExit).toEqual({ framed: true, unknown: false, code: 300 })
  const status = 0xC0000005 | 0
  const signed = windowsPtyProtocol.encodeFrame({ type: 'exit', scope: options.windowsPty!.scope, code: status })
  process.stderr.write(signed)
  expect(status).toBeLessThan(0)
  expect(handle.windowsPtyExit).toEqual({ framed: true, unknown: false, code: status })
})
