import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { windowsPtyCommand } from '../packages/adapters/src/tools/windows-pty.js'

const require = createRequire(import.meta.url)
const { startWindowsPty } = require('../packages/adapters/src/tools/windows-pty-bridge.cjs')
const { encodeFrame, createParser } = require('../packages/adapters/src/tools/windows-pty-protocol.cjs')
const broker = ['C:\\Pulse\\srt-win.exe', 'exec', '--quiet', '--deny-read', 'C:\\private', '--env', 'HTTPS_PROXY=local-only', '--', 'cmd.exe', '/d', '/c', 'pipe-wrapper']
const node = 'C:\\Pulse\\node.exe', bridge = 'C:\\Pulse\\tools\\windows-pty-bridge.cjs', modulePath = 'C:\\Pulse\\node-pty\\lib\\index.js'
const scope = 'cd'.repeat(16), inputId = '12'.repeat(16)

it('keeps all SRT policy flags and replaces only the pipe wrapper with a direct, encoded inner target', () => {
  const command = 'C:\\work space\\program.exe', args = ['中文', 'x & echo injected', '$(bad)', 'quote"', 'C:\\trailing slash\\', '--']
  const original = [...broker], result = windowsPtyCommand(broker, node, bridge, { modulePath, scope }, command, args)
  expect(result.slice(0, broker.indexOf('--') + 1)).toEqual(broker.slice(0, broker.indexOf('--') + 1))
  expect(result.slice(-3, -1)).toEqual([node, bridge])
  expect(JSON.parse(Buffer.from(result.at(-1)!, 'base64').toString())).toEqual({ modulePath, command, args, scope })
  expect(result).not.toContain('cmd.exe'); expect(broker).toEqual(original)
})

it('refuses missing broker targets, relative installed paths, NULs and native command-line overflow', () => {
  expect(() => windowsPtyCommand(['srt.exe', 'exec', '--'], node, bridge, { modulePath, scope }, node, [])).toThrow('INVALID_WINDOWS_SANDBOX_COMMAND')
  expect(() => windowsPtyCommand(broker, node, 'workspace/bridge.cjs', { modulePath, scope }, node, [])).toThrow('INVALID_WINDOWS_PTY_COMMAND')
  expect(() => windowsPtyCommand(broker, node, bridge, { modulePath, scope }, node, ['bad\0arg'])).toThrow('INVALID_WINDOWS_PTY_COMMAND')
  expect(() => windowsPtyCommand(broker, node, bridge, { modulePath, scope: 'short' }, node, [])).toThrow('INVALID_WINDOWS_PTY_COMMAND')
  expect(() => windowsPtyCommand(broker, node, bridge, { modulePath, scope }, node, ['x'.repeat(30_000)])).toThrow('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
})

function fixture() {
  let data!: (value: string) => void, exit!: (value: { exitCode: number | undefined | null }) => void
  const terminal: { write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; onData: (cb: typeof data) => void; onExit: (cb: typeof exit) => void; _agent?: { inSocket: { write: (chunk: string, encoding?: unknown, callback?: (error?: Error | null) => void) => boolean } } } = { write: vi.fn(), kill: vi.fn(), onData: (cb: typeof data) => { data = cb }, onExit: (cb: typeof exit) => { exit = cb } }
  const pty = { spawn: vi.fn(() => terminal) }, output: Buffer[] = [], control: Buffer[] = [], frames: Array<{ type: string; scope: string; id: string; data?: string; code?: number }> = []
  const parse = createParser((frame: { type: string; scope: string; id: string; data?: string; code?: number }) => frames.push(frame))
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), env: { PATH: 'safe', TEMP: 'isolated', NODE_OPTIONS: '--require forbidden' }, cwd: () => 'C:\\workspace', exit: vi.fn() }
  io.stdout.on('data', chunk => output.push(chunk))
  io.stderr.on('data', chunk => { control.push(chunk); parse(chunk) })
  startWindowsPty({ command: 'C:\\tool.exe', args: ['a & b', '中文'], scope }, pty, io)
  return { io, terminal, pty, output, frames, data: (value: string) => data(value), exit: (code: number | undefined | null) => exit({ exitCode: code }) }
}

it('creates the target ConPTY inside the sandbox with unmodified argv, and losslessly streams split UTF-8 input/output', async () => {
  const f = fixture()
  expect(f.pty.spawn).toHaveBeenCalledWith('C:\\tool.exe', ['a & b', '中文'], expect.objectContaining({ cwd: 'C:\\workspace', env: { PATH: 'safe', TEMP: 'isolated' }, useConpty: true, useConptyDll: false, conptyInheritCursor: false }))
  expect(f.frames).toContainEqual(expect.objectContaining({ type: 'ready', scope }))
  const frame = encodeFrame({ type: 'input', scope, id: inputId, data: '中文\r' })
  f.io.stdin.write(frame.subarray(0, 40)); f.io.stdin.write(frame.subarray(40))
  expect(f.terminal.write).toHaveBeenCalledWith('中文\r')
  expect(f.frames).toContainEqual(expect.objectContaining({ type: 'ack', scope, id: inputId }))
  f.io.stdin.write(encodeFrame({ type: 'input', scope: '00'.repeat(16), id: inputId, data: 'forged' }))
  expect(f.terminal.write).toHaveBeenCalledTimes(1)
  f.data('last中文\r\n'); f.exit(7)
  await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledWith(7))
  expect(Buffer.concat(f.output).toString()).toBe('last中文\r\n')
  expect(f.output.join('')).not.toContain('PTY1')
  f.io.stdin.write(encodeFrame({ type: 'input', scope, id: inputId, data: 'late' }))
  expect(f.terminal.write).toHaveBeenCalledTimes(1)
  expect(f.terminal.kill).not.toHaveBeenCalled()
})

it('acks only after the ConPTY input buffer accepts the write, and does not exit 0 when the native code is missing', async () => {
  const f = fixture()
  let accept: ((error?: Error | null) => void) | undefined
  f.terminal.write.mockImplementation((data: string) => { f.terminal._agent.inSocket.write(data) })
  f.terminal._agent = { inSocket: { write: (_chunk: string, _encoding: unknown, callback: (error?: Error | null) => void) => { accept = callback; return true } } }
  f.io.stdin.write(encodeFrame({ type: 'input', scope, id: inputId, data: 'wait' }))
  expect(f.terminal.write).toHaveBeenCalledWith('wait')
  expect(f.frames.some(frame => frame.type === 'ack')).toBe(false)
  accept?.()
  expect(f.frames).toContainEqual(expect.objectContaining({ type: 'ack', id: inputId }))
  f.exit(undefined)
  await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledWith(1))
  expect(f.io.exit).not.toHaveBeenCalledWith(0)
  expect(f.io.exit).not.toHaveBeenCalledWith(undefined)
  expect(f.frames).toContainEqual(expect.objectContaining({ type: 'exitUnknown', scope }))
})

it('keeps a partial PTY1 prefix across chunks, including every split of a multibyte payload', () => {
  const ready = encodeFrame({ type: 'ready', scope })
  const input = encodeFrame({ type: 'input', scope, id: inputId, data: '中文' })
  const ack = encodeFrame({ type: 'ack', scope, id: inputId })
  const feed = (chunks: Buffer[]) => {
    const frames: Array<{ type: string; data?: string }> = []
    const plain: Buffer[] = []
    const parse = createParser((frame: { type: string; data?: string }) => frames.push(frame))
    for (const chunk of chunks) { const text = parse(chunk); if (text.length) plain.push(text) }
    return { frames, plain: plain.length ? Buffer.concat(plain) : Buffer.alloc(0) }
  }
  const held = createParser(() => { throw new Error('prefix is not a frame') })
  expect(held(Buffer.from('PT'))).toEqual(Buffer.alloc(0))
  expect(held(Buffer.from('Z')).toString()).toBe('PTZ')
  for (const frame of [ready, ack, input]) {
    expect(frame.subarray(0, 2).toString()).toBe('PT')
    for (let cut = 0; cut <= frame.length; cut++) {
      const result = feed([frame.subarray(0, cut), frame.subarray(cut)])
      expect(result.frames).toHaveLength(1)
      expect(result.plain).toEqual(Buffer.alloc(0))
    }
    const bytes = [...frame].map(byte => Buffer.from([byte]))
    expect(feed(bytes).frames).toHaveLength(1)
  }
  expect(feed([ready.subarray(0, 2), ready.subarray(2)]).frames[0]).toMatchObject({ type: 'ready' })
  const mixed = Buffer.concat([Buffer.from('log-前'), input, Buffer.from('后-tail')])
  for (let cut = 0; cut <= mixed.length; cut++) {
    const result = feed([mixed.subarray(0, cut), mixed.subarray(cut)])
    expect(result.frames).toEqual([expect.objectContaining({ type: 'input', data: '中文' })])
    expect(result.plain.toString()).toBe('log-前后-tail')
  }
})

it('records Win32 32-bit failure exits and does not turn a missing code into success', async () => {
  const status = 0xC0000005 | 0
  expect(status).toBeLessThan(0)
  for (const code of [256, 300, status]) {
    const f = fixture()
    f.exit(code)
    await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledWith(code))
    expect(f.frames).toContainEqual(expect.objectContaining({ type: 'exit', code }))
    expect(f.frames.some(frame => frame.type === 'exitUnknown')).toBe(false)
    expect(f.io.exit).not.toHaveBeenCalledWith(code & 255)
  }
  for (const code of [undefined, null, Number.NaN]) {
    const f = fixture()
    f.exit(code as number | undefined)
    await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledWith(1))
    expect(f.io.exit).not.toHaveBeenCalledWith(0)
    expect(f.frames).toContainEqual(expect.objectContaining({ type: 'exitUnknown' }))
  }
})

it('ends the run-owned ConPTY on input transport EOF or failure, never launches a replacement', () => {
  const f = fixture()
  f.io.stdin.emit('end')
  expect(f.terminal.kill).toHaveBeenCalledOnce()
  f.exit(1)
  f.io.stdin.emit('end')
  expect(f.terminal.kill).toHaveBeenCalledOnce()
  expect(f.pty.spawn).toHaveBeenCalledOnce()
})
