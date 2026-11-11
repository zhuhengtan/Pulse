import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readyServiceProcesses, type ServiceEvidence } from '../packages/server/src/service-review-evidence.js'
import { ShellProcesses } from '../packages/server/src/shell-processes.js'
import type { ResultMeta } from '@hunterzhu/pulse-runtime'

const meta = (toolName: string): ResultMeta => ({ ref: 'r', privacy: 'public', sizeBytes: 1, hash: 'hash', producer: { kind: 'effect', id: 'e' }, derivedFrom: [], effectKind: 'tool', outcomeStatus: 'succeeded', toolName })
const started: ServiceEvidence = { ref: 'start', meta: { ...meta('shell.start'), toolArguments: { command: 'npm', args: ['run', 'dev'] } }, value: { processId: 'p', status: 'running', command: { lifetime: 'service' }, output: 'Ready at http://127.0.0.1:5176/' } }
const probe: ServiceEvidence = { ref: 'probe', meta: meta('web.fetch'), value: { url: 'http://127.0.0.1:5176/', fetchedAt: 'now', text: 'page' } }
it('requires explicit service intent and a native observation of the announced local endpoint', () => {
  expect([...readyServiceProcesses('启动本地开发服务', [started, probe])]).toEqual(['p'])
  expect([...readyServiceProcesses('Run tests for the server', [started, probe])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [started])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [{ ...started, value: { processId: 'p', status: 'running', output: 'Ready at http://127.0.0.1:5176/' } }, probe])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [probe, started])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [started, { ...probe, value: { url: 'http://127.0.0.1:5177/', fetchedAt: 'now', text: 'other server' } }])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [started, { ...probe, meta: { ...meta('web.fetch'), outcomeStatus: 'failed' } }])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [{ ...started, meta: { ...meta('shell.start'), toolArguments: { command: 'npm', args: ['run', 'test'] } } }, probe])]).toEqual([])
  expect([...readyServiceProcesses('Start the server', [started, probe, { ...started, ref: 'exit', value: { processId: 'p', status: 'unknown' } }])]).toEqual([])
})

it('exempts only a live owned service; cold unknown processes and unrelated work still block acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-service-evidence-')), manager = new ShellProcesses(root)
  const context = { agentId: 'a', laneId: 'l', effectId: 'start', toolCallId: 'start', attemptId: 'start', signal: new AbortController().signal, emit() {} }
  const runner = async (_command: unknown, ctx: typeof context) => new Promise<Record<string, unknown>>(resolve => ctx.signal.addEventListener('abort', () => resolve({ code: null, aborted: true }), { once: true }))
  try {
    const service = await manager.start({ command: 'npm', args: ['run', 'dev'], lifetime: 'service' }, context, runner)
    const ready = new Set([service.processId])
    await expect(manager.assertIdle()).rejects.toThrow('SHELL_PROCESS_ACTIVE')
    await expect(manager.assertIdle(ready)).resolves.toBeUndefined()
    await expect(new ShellProcesses(root).assertIdle(ready)).rejects.toThrow('SHELL_PROCESS_STATE_UNKNOWN')
    await expect(manager.assertIdle(new Set(['unrelated-process']))).rejects.toThrow('SHELL_PROCESS_ACTIVE')
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
})
