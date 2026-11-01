import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { ShellProcesses, summarizeShellProcess } from '../packages/server/src/shell-processes.js'

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_MODEL_OR_NETWORK_REQUEST')) })
const managers: ShellProcesses[] = [], directories: string[] = []
afterEach(async () => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await Promise.all(managers.splice(0).map(p => p.close())); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function fixture(source = "console.log('first'); setTimeout(() => console.log('last'), 150)") {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-process-')); directories.push(dir)
  const script = join(dir, 'fixture.cjs'); await writeFile(script, source)
  const manager = new ShellProcesses(join(dir, 'processes')); managers.push(manager)
  const context: ToolContext = { agentId: 'agent', laneId: 'lane', effectId: 'effect-start', toolCallId: 'call', attemptId: 'attempt', signal: new AbortController().signal, emit() {} }
  let starts = 0
  const runner = async (_input: unknown, ctx: ToolContext, output: (stream: 'stdout' | 'stderr', chunk: Buffer) => void): Promise<Record<string, unknown>> => {
    starts++
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', chunk => output('stdout', chunk)); child.stderr.on('data', chunk => output('stderr', chunk))
      const abort = () => child.kill('SIGTERM')
      ctx.signal.addEventListener('abort', abort, { once: true }); if (ctx.signal.aborted) abort()
      child.once('error', reject)
      child.once('close', code => { ctx.signal.removeEventListener('abort', abort); resolve({ code, stdout: '', stderr: '', aborted: ctx.signal.aborted, timedOut: false, truncated: false }) })
    })
  }
  return { dir, script, manager, context, runner, get starts() { return starts } }
}

it('streams paginated output and exposes an exit code only after the command exits', async () => {
  const f = await fixture(), started = await f.manager.start({ command: process.execPath, args: [f.script] }, f.context, f.runner)
  expect(started).toMatchObject({ status: 'running' }); expect(started).not.toHaveProperty('result')
  await expect.poll(async () => (await f.manager.poll(started.processId, f.context)).output).toContain('first')
  await expect.poll(async () => (await f.manager.poll(started.processId, f.context)).status).toBe('exited')
  const first = await f.manager.poll(started.processId, f.context, 0, 4), rest = await f.manager.poll(started.processId, f.context, first.nextOffset)
  expect(first.output + rest.output).toBe('first\nlast\n')
  expect(rest).toMatchObject({ code: 0, result: { code: 0 }, status: 'exited' })
  const restored = new ShellProcesses(f.manager.directory)
  expect(await restored.poll(started.processId, f.context)).toMatchObject({ status: 'exited', result: { code: 0 } })
})

it('keeps workspace writes blocked and refuses foreign-lane access while running', async () => {
  const f = await fixture("console.log('ready'); setInterval(() => {}, 1000)"), started = await f.manager.start({ command: process.execPath, args: [f.script] }, f.context, f.runner)
  await expect(f.manager.assertIdle()).rejects.toThrow('SHELL_PROCESS_ACTIVE')
  await expect(f.manager.poll(started.processId, { ...f.context, laneId: 'other' })).rejects.toThrow('RESULT_NOT_VISIBLE')
  await expect(f.manager.cancel(started.processId, { ...f.context, agentId: 'other' })).rejects.toThrow('RESULT_NOT_VISIBLE')
  expect(await f.manager.cancel(started.processId, f.context)).toMatchObject({ status: 'exited', result: { aborted: true } })
  await expect(f.manager.assertIdle()).resolves.toBeUndefined()
})

it('reuses a handle for the same effect but never restarts an unknown command after process replacement', async () => {
  const f = await fixture("setInterval(() => {}, 1000)"), command = { command: process.execPath, args: [f.script] }
  const started = await f.manager.start(command, f.context, f.runner)
  expect((await f.manager.start(command, f.context, f.runner)).processId).toBe(started.processId)
  expect(f.starts).toBe(1)
  const restored = new ShellProcesses(f.manager.directory)
  expect(await restored.poll(started.processId, f.context)).toMatchObject({ status: 'unknown' })
  expect(await restored.start(command, f.context, f.runner)).toMatchObject({ status: 'unknown' })
  expect(f.starts).toBe(1)
  await expect(restored.assertIdle()).rejects.toThrow('SHELL_PROCESS_STATE_UNKNOWN')
  await expect(restored.cancel(started.processId, f.context)).rejects.toThrow('SHELL_PROCESS_STATE_UNKNOWN')
  await expect(f.manager.start({ ...command, args: ['different'] }, f.context, f.runner)).rejects.toThrow('SHELL_PROCESS_OPERATION_CHANGED')
})

it('cancels owned children when the run closes and rejects forged handles', async () => {
  const f = await fixture("setInterval(() => {}, 1000)"), started = await f.manager.start({ command: process.execPath }, f.context, f.runner)
  await f.manager.close()
  expect(await f.manager.poll(started.processId, f.context)).toMatchObject({ status: 'exited', result: { aborted: true } })
  await expect(f.manager.poll('../outside', f.context)).rejects.toThrow('INVALID_SHELL_PROCESS_ID')
})

it('keeps long-output status and a lossless continuation cursor within the summary budget', () => {
  const text = '中文日志'.repeat(1000)
  const summary = summarizeShellProcess({ processId: 'handle', status: 'exited', code: 0, output: text, offset: 200, nextOffset: 12200, result: { stdout: 'large'.repeat(30000) }, truncated: false })
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4096)
  expect(summary).toMatchObject({ status: 'exited', code: 0, originalReceiptAvailable: true, truncated: true })
  expect(summary.nextOffset).toBe(200 + Buffer.byteLength(String(summary.output)))
  expect(String(summary.output)).not.toContain('�')
  expect(summarizeShellProcess({ processId: 'h', status: 'running' })).not.toHaveProperty('code')
})


it('does not expose an exit before its durable receipt is available to a cold reader', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const subject = f.manager as unknown as { persist(record: { status: string }): Promise<void> }
  const persist = subject.persist.bind(f.manager)
  subject.persist = async record => { if (record.status === 'exited') { entered(); await gate }; await persist(record) }
  try {
    const started = await f.manager.start({ command: process.execPath }, f.context, async () => ({ code: 0 }))
    await pending
    expect(await f.manager.poll(started.processId, f.context)).toMatchObject({ status: 'running' })
    expect(await new ShellProcesses(f.manager.directory).poll(started.processId, f.context)).toMatchObject({ status: 'unknown' })
    release()
    await expect.poll(async () => (await f.manager.poll(started.processId, f.context)).status).toBe('exited')
    expect(await new ShellProcesses(f.manager.directory).poll(started.processId, f.context)).toMatchObject({ status: 'exited', result: { code: 0 } })
  } finally { release() }
})
