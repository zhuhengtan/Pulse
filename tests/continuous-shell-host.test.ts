import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { LocalHost } from '@hunterzhu/pulse-server'
import { runShell } from '../packages/adapters/src/tools/shell.js'
import { closeShellProcesses } from '../packages/server/src/shell-processes.js'

vi.mock('../packages/adapters/src/tools/shell.js', async original => ({ ...await original<typeof import('../packages/adapters/src/tools/shell.js')>(), runShell: vi.fn() }))
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_NETWORK')) })
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('connects start/poll to the sandbox runner and blocks another write until settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-shell-host-'))
  vi.stubEnv('PULSE_HOME', join(root, 'home')); vi.stubEnv('PULSE_CONFIG', join(root, 'home', 'config.json'))
  let finishShell!: () => void
  vi.mocked(runShell).mockImplementation(async (_command, _args, options) => {
    options?.onOutput?.('stdout', Buffer.from('started\n'))
    await new Promise<void>(resolve => { finishShell = resolve; options?.signal?.addEventListener('abort', () => resolve(), { once: true }) })
    options?.onOutput?.('stdout', Buffer.from('done\n'))
    return { code: 0, stdout: 'started\ndone\n', stderr: '', timedOut: false, aborted: false, truncated: false }
  })
  const host = new LocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' }, approvalMode: 'auto', taskController: true, taskControllerPolicy: 'continuous', jarvis: { enabled: false } })
  const runId = 'offline-process-test'
  let runDirectory = ''
  try {
    await host.init(); const conversation = await host.createConversation()
    runDirectory = join(root, 'data', 'conversations', conversation.id, 'runs', runId)
    const { runtime, registry } = await (host as any).runtimeFor(conversation.id, runId, root, 'Inspect a local process', '', (host as any).options)
    expect(registry.list().map((t: any) => t.name)).toEqual(expect.arrayContaining(['shell.start', 'shell.poll', 'shell.cancel']))
    const tool = (key: string, name: string, args: any) => ({ key, toolCallId: key, kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { name, arguments: args, toolCallId: key } })
    const program = defineLaneProgram({ id: 'offline-shell', version: '57' }, b => {
      b.addStep('start', () => ({ actions: [{ type: 'submit_effects', effects: [tool('start-process', 'shell.start', { command: 'fixture-command', args: [] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'poll' }))
      b.addStep('poll', ctx => {
        const deps = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies) : []
        const ref = deps.flatMap(d => d.state === 'settled' && d.outcome.resultRef ? [d.outcome.resultRef] : [])[0]!
        const started = ctx.results.read(ref) as any
        return { actions: [{ type: 'submit_effects', effects: [tool('blocked-write', 'fs.write', { path: 'racing.txt', content: 'must not write' }), tool('poll-process', 'shell.poll', { processId: started.processId, waitMs: 30000 })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish', locals: { processId: started.processId, output: '', blocked: false, polls: 1 } }
      })
      b.addStep('finish', ctx => {
        const deps = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution.dependencies) : []
        const settled = deps.flatMap(d => d.state === 'settled' ? [{ error: d.outcome.error?.code ?? null, value: d.outcome.resultRef ? ctx.results.read(d.outcome.resultRef) : null }] : [])
        const prior = ctx.lane.resume.locals as { processId: string; output: string; blocked: boolean; polls: number }
        const process = settled.find(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'processId' in row.value)?.value as any
        const blocked = prior.blocked || settled.some(row => row.error === 'SHELL_PROCESS_ACTIVE')
        const output = prior.output + (process?.output ?? '')
        if (process?.status === 'exited') return { actions: [{ type: 'complete', result: { blocked, process: { ...process, output }, polls: prior.polls } }], next: 'finish' }
        if (!process || prior.polls >= 5) throw new Error('SCRIPTED_POLL_DID_NOT_SETTLE')
        // Output may wake a poll before exit. Keep the handle and byte cursor;
        // never resubmit the shell or assume a running receipt is completion.
        return { actions: [{ type: 'submit_effects', effects: [tool(`poll-${prior.polls + 1}`, 'shell.poll', { processId: prior.processId, offset: process.nextOffset, waitMs: 30000 })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish', locals: { processId: prior.processId, output, blocked, polls: prior.polls + 1 } }
      })
    })
    const session = runtime.start(runtime.createAgent('Run local fixture', program).agentId)
    const completed = session.outcome()
    await expect.poll(() => [...runtime.state.effects.values()].some((e: any) => e.outcome?.error?.code === 'SHELL_PROCESS_ACTIVE')).toBe(true)
    await expect.poll(() => [...runtime.state.effects.values()].some((e: any) => e.input?.name === 'shell.poll' && e.outcome?.resultRef && (runtime.state.results.get(e.outcome.resultRef)?.value as any)?.status === 'running')).toBe(true)
    finishShell()
    const outcome = await completed
    expect(outcome.status).toBe('succeeded')
    const result = runtime.state.results.get(outcome.resultRef!)?.value as any
    expect(result.blocked, JSON.stringify(result)).toBe(true)
    expect(result.process).toMatchObject({ status: 'exited', code: 0, output: 'started\ndone\n' })
    expect(result.polls).toBeGreaterThan(1)
    expect(vi.mocked(runShell)).toHaveBeenCalledTimes(1)
    await expect(readFile(join(root, 'racing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { finishShell?.(); if (runDirectory) await closeShellProcesses(runDirectory); await host.close(); await rm(root, { recursive: true, force: true }) }
})
