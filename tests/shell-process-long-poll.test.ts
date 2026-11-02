import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { ShellProcesses } from '../packages/server/src/shell-processes.js'
const fixtures: Array<{ root: string; manager: ShellProcesses }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.manager.close(); await rm(f.root, { recursive: true, force: true }) } })
async function fixture(pty = false) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-live-poll-')), manager = new ShellProcesses(root)
  fixtures.push({ root, manager })
  const context = (effectId: string, signal = new AbortController().signal): ToolContext => ({ agentId: 'agent', laneId: 'lane', effectId, toolCallId: effectId, attemptId: effectId, signal, emit() {} })
  let output!: (stream: 'stdout' | 'stderr', data: Buffer) => void, ready!: (write: (data: string) => void) => void
  const started = await manager.start({ command: 'scripted', pty }, context('start'), async (_command, child, stream, input) => {
    output = stream; ready = input
    await new Promise<void>(resolve => { if (child.signal.aborted) resolve(); else child.signal.addEventListener('abort', () => resolve(), { once: true }) })
    return { code: null, aborted: true, timedOut: false }
  })
  return { root, manager, context, started, output, ready }
}
it('wakes for durable new output instead of waiting for exit or the full interval, and resumes from the byte cursor', async () => {
  const f = await fixture(), started = Date.now()
  const pending = f.manager.poll(f.started.processId, f.context('poll'), 0, 4096, 1000)
  await delay(30); f.output('stdout', Buffer.from('first\n'))
  const first = await pending
  expect(Date.now() - started).toBeLessThan(750)
  expect(first).toMatchObject({ status: 'running', output: 'first\n', nextOffset: 6 })
  const next = f.manager.poll(f.started.processId, f.context('next'), first.nextOffset, 4096, 1000)
  await delay(30); f.output('stderr', Buffer.from('second\n'))
  expect(await next).toMatchObject({ output: 'second\n', offset: 6, nextOffset: 13 })
  expect(await readFile(join(f.manager.directory, f.started.processId + '.log'), 'utf8')).toBe('first\nsecond\n')
})
it('wakes when stdin becomes ready, then waits normally after the input intent instead of spinning on old readiness', async () => {
  const f = await fixture(true), start = Date.now()
  const pending = f.manager.poll(f.started.processId, f.context('poll'), 0, 4096, 1000)
  await delay(30); f.ready(() => {})
  expect(await pending).toMatchObject({ status: 'running', stdinReady: true, output: '' })
  expect(Date.now() - start).toBeLessThan(750)
  expect((await f.manager.input(f.started.processId, 'local\n', f.context('input'))).status).toBe('delivered')
  const waiting = Date.now(), quiet = await f.manager.poll(f.started.processId, f.context('quiet'), 0, 4096, 100)
  expect(Date.now() - waiting).toBeGreaterThanOrEqual(70)
  expect(quiet).toMatchObject({ stdinReady: true, inputUncertain: false, output: '', nextOffset: 0 })
})
it('does not consume a split UTF-8 suffix and still cancels an owned wait without losing subsequent output', async () => {
  const f = await fixture(), bytes = Buffer.from('中文')
  const pending = f.manager.poll(f.started.processId, f.context('unicode'), 0, 4096, 1000)
  f.output('stdout', bytes.subarray(0, 1)); await delay(30)
  f.output('stdout', bytes.subarray(1))
  const result = await pending
  expect(result).toMatchObject({ output: '中文', nextOffset: bytes.length })
  expect(result.output).not.toContain('\ufffd')
  const controller = new AbortController()
  const cancelled = f.manager.poll(f.started.processId, f.context('cancelled-read', controller.signal), result.nextOffset, 4096, 1000)
  const rejected = expect(cancelled).rejects.toThrow()
  await delay(20); controller.abort(); await rejected
  f.output('stdout', Buffer.from('tail'))
  expect(await f.manager.poll(f.started.processId, f.context('later'), result.nextOffset, 4096, 1000)).toMatchObject({ output: 'tail', nextOffset: bytes.length + 4 })
})
