import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { resolveShellIdentity, runShell } from '@hunterzhu/pulse-adapters'
import { agentPtyShellOptions } from '../packages/server/src/agent-pty.js'
import { ShellProcesses, blockAcceptanceIfShellBusy, shellProcesses } from '../packages/server/src/shell-processes.js'

const directories: string[] = [], managers: ShellProcesses[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks() })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'pulse-agent-pty-')); directories.push(path); return path }
const context = (effectId: string): ToolContext => ({ effectId, agentId: 'agent', laneId: 'lane', toolCallId: effectId, attemptId: effectId + '-attempt', signal: new AbortController().signal, emit() {} })
async function liveFixture(writer: (data: string, root: string) => void | Promise<void>) {
  const root = await directory(), manager = new ShellProcesses(join(root, 'processes')); managers.push(manager)
  let finish!: () => void
  const started = await manager.start({ command: 'scripted-local-fixture', pty: true }, context('start'), async (_command, ctx, output, ready) => {
    ready(data => writer(data, root))
    output('stdout', Buffer.from('ready\n'))
    await new Promise<void>(resolve => { finish = resolve; ctx.signal.addEventListener('abort', () => resolve(), { once: true }) })
    return { code: 0, aborted: ctx.signal.aborted, stdout: '', stderr: '', truncated: false, timedOut: false }
  })
  return { root, manager, started, finish: () => finish() }
}

it('syncs input intent before delivery, joins duplicates, preserves the acknowledgement after restart and enforces ownership', async () => {
  const writes: string[] = []
  const f = await liveFixture((data, root) => {
    const name = `stdin-${createHash('sha256').update('input-1').digest('hex')}.json`
    expect(JSON.parse(readFileSync(join(root, 'processes', name), 'utf8'))).toMatchObject({ status: 'pending', bytes: Buffer.byteLength(data) })
    writes.push(data)
  })
  const input = context('input-1'), data = 'local fixture input\n'
  const receipts = await Promise.all([f.manager.input(f.started.processId, data, input), f.manager.input(f.started.processId, data, input)])
  expect(writes).toEqual([data]); expect(receipts[0]).toEqual(receipts[1]); expect(receipts[0]!.status).toBe('delivered')
  await expect(f.manager.input(f.started.processId, data + 'changed', input)).rejects.toThrow('SHELL_STDIN_OPERATION_CHANGED')
  await expect(f.manager.input(f.started.processId, data, { ...context('foreign'), laneId: 'other' })).rejects.toThrow('RESULT_NOT_VISIBLE')
  const restored = new ShellProcesses(f.manager.directory)
  expect((await restored.input(f.started.processId, data, input)).status).toBe('delivered')
  expect(writes).toHaveLength(1)
  const receipt = await restored.inputReceipt(f.started.processId, input.effectId, input)
  expect(JSON.stringify(receipt)).not.toContain(data.trim())
  await expect(restored.input(f.started.processId, 'new', context('new-input'))).rejects.toThrow('SHELL_PROCESS_STATE_UNKNOWN')
  f.finish()
  await expect.poll(async () => (await f.manager.poll(f.started.processId, input)).status).toBe('exited')
  await expect(f.manager.assertIdle()).resolves.toBeUndefined()
})

it('keeps a delayed acknowledgement pending and sends that effect only once', async () => {
  const writes: string[] = []
  let release!: () => void
  const f = await liveFixture((data) => new Promise<void>(resolve => { writes.push(data); release = resolve }))
  const input = context('input-1'), data = 'local fixture input\n'
  const first = f.manager.input(f.started.processId, data, input)
  const second = f.manager.input(f.started.processId, data, input)
  const name = `stdin-${createHash('sha256').update('input-1').digest('hex')}.json`
  await vi.waitFor(() => {
    expect(writes).toEqual([data])
    expect(JSON.parse(readFileSync(join(f.root, 'processes', name), 'utf8')).status).toBe('pending')
  })
  release()
  const receipts = await Promise.all([first, second])
  expect(receipts[0]?.status).toBe('delivered')
  expect(receipts[0]).toEqual(receipts[1])
  expect(writes).toEqual([data])
})

it('blocks acceptance when a PTY exit code is unknown instead of recording success', async () => {
  const root = await directory(), manager = shellProcesses(root); managers.push(manager)
  const started = await manager.start({ command: 'node', args: [], pty: true }, context('start'), async () => { throw Object.assign(new Error('AGENT_PTY_EXIT_UNKNOWN'), { code: 'AGENT_PTY_EXIT_UNKNOWN' }) })
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(manager.directory, `${started.processId}.json`), 'utf8')).status).toBe('unknown'))
  await expect(blockAcceptanceIfShellBusy('57', root)).rejects.toThrow('SHELL_PROCESS_ACTIVE')
  const restored = new ShellProcesses(manager.directory)
  await expect(restored.assertIdle()).rejects.toThrow('SHELL_PROCESS_STATE_UNKNOWN')
  const polled = await restored.poll(started.processId, context('start'))
  expect(polled.status).toBe('unknown')
  expect(polled.result).toBeUndefined()
})

it('never resends an uncertain input even under a new effect, and never turns a process exit into input acceptance', async () => {
  let attempts = 0
  const f = await liveFixture(() => { attempts++; throw new Error('scripted acknowledgement failure') })
  expect((await f.manager.input(f.started.processId, 'local\n', context('input'))).status).toBe('unknown')
  expect((await f.manager.poll(f.started.processId, context('poll'))).inputUncertain).toBe(true)
  await expect(f.manager.input(f.started.processId, 'local\n', context('another-input'))).rejects.toThrow('SHELL_STDIN_DELIVERY_UNKNOWN')
  expect(attempts).toBe(1)
  const restored = new ShellProcesses(f.manager.directory)
  expect((await restored.input(f.started.processId, 'local\n', context('input'))).status).toBe('unknown')
  await f.manager.cancel(f.started.processId, context('cancel'))
  await expect(f.manager.assertIdle()).rejects.toThrow('SHELL_STDIN_STATE_UNKNOWN')
})

it('bounds UTF-8 input and keeps new legacy runs blocked by live/unknown processes without upgrading old snapshots', async () => {
  const f = await liveFixture(() => {})
  await expect(f.manager.input(f.started.processId, '汉'.repeat(3000), context('oversize'))).rejects.toThrow('SHELL_STDIN_RANGE_INVALID')
  await expect(f.manager.input(f.started.processId, '\ud800', context('invalid'))).rejects.toThrow('SHELL_STDIN_RANGE_INVALID')
  const run = await directory()
  await writeFile(join(run, 'input.json'), JSON.stringify({ shellSurfaceVersion: 1 }))
  const { shellProcesses } = await import('../packages/server/src/shell-processes.js')
  const owned = shellProcesses(run); managers.push(owned)
  await owned.start({ command: 'scripted' }, context('run-start'), async (_cmd, ctx) => { await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true })); return { code: null } })
  await expect(blockAcceptanceIfShellBusy('56', run)).rejects.toThrow('SHELL_PROCESS_ACTIVE')
  await writeFile(join(run, 'input.json'), '{}')
  await expect(blockAcceptanceIfShellBusy('56', run)).resolves.toBeUndefined()
})

it('launches a real PTY through the exact SRT wrapper, preserves the identity check, and accepts one bounded line', async () => {
  const root = await directory(), script = join(root, 'interactive.cjs')
  await writeFile(script, "console.log(process.stdin.isTTY ? 'tty-ready' : 'not-tty');require('readline').createInterface({input:process.stdin}).once('line',line=>{console.log('received:'+line);process.exit(0)})")
  const identity = await resolveShellIdentity('node', [script], root)
  let write!: (data: string) => void, sent = false, checked = 0, argv: readonly string[] = []
  const ptyOptions = agentPtyShellOptions(input => { write = input })
  const result = await runShell('node', [script], { ...ptyOptions, cwd: root, timeoutMs: 10000, allowedDomains: [], expectedIdentity: identity, beforeLaunch: async () => { checked++; return identity },
    spawnProcess: (wrapped, options) => { argv = [...wrapped]; expect(options.env.NODE_OPTIONS).toBeUndefined(); return ptyOptions.spawnProcess(wrapped, options) },
    onOutput: (_stream, chunk) => { if (!sent && chunk.toString().includes('tty-ready')) { sent = true; write(process.platform === 'win32' ? 'local-line\r' : 'local-line\n') } },
  })
  expect(checked).toBe(1); expect(sent).toBe(true)
  expect(argv.length).toBeGreaterThan(2); expect(argv[0]).not.toBe(identity.executable)
  expect(result).toMatchObject({ code: 0, aborted: false, timedOut: false })
  expect(result.stdout).toContain('tty-ready'); expect(result.stdout).toContain('received:local-line')
}, process.platform === 'win32' ? 300000 : 20000)

it.skipIf(process.platform === 'win32')('blocks outbound connect inside the real PTY sandbox with the Node preload removed', async () => {
  const root = await directory(), script = join(root, 'network.cjs')
  // Reserved TEST-NET destination, no external service/model is contacted.
  await writeFile(script, "const s=require('net').connect(443,'198.51.100.1');s.on('connect',()=>{console.log('UNEXPECTED_CONNECTED');process.exit(2)});s.on('error',e=>{console.log('blocked:'+e.code);process.exit(0)})")
  const result = await runShell('node', [script], { cwd: root, timeoutMs: 5000, allowedDomains: [], ...agentPtyShellOptions(() => {}) })
  expect(result.code).toBe(0); expect(result.timedOut).toBe(false)
  expect(result.stdout).toMatch(/blocked:(?:EPERM|EACCES|OFFLINE_NETWORK_BLOCKED)/)
  expect(result.stdout).not.toContain('UNEXPECTED_CONNECTED')
}, 15000)
