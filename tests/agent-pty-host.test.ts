import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, resolveShellIdentity } from '@hunterzhu/pulse-adapters'
import { LocalHost } from '../packages/server/src/index.js'
import { closeShellProcesses } from '../packages/server/src/shell-processes.js'
import { assertExplicitToolRestriction } from '../packages/server/src/task-controller/explicit-restrictions.js'

afterEach(() => vi.restoreAllMocks())
it('uses the real Host, approval loop and native PTY without borrowing a host argv grant for stdin', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-pty-host-'))), script = join(root, 'interactive.cjs')
  await writeFile(script, "console.log(process.stdin.isTTY?'tty-ready':'not-tty');require('readline').createInterface({input:process.stdin}).once('line',line=>{require('fs').writeFileSync('received.txt',line);console.log('received:'+line);process.exit(0)})")
  const identity = await resolveShellIdentity('node', [script], root)
  let work = 0, inputProposed = false
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_MODEL_OR_NETWORK_REQUEST'))
  vi.spyOn(MockAdapter.prototype, 'executeAttempt').mockImplementation(async params => {
    if (params.outputSchema) return { text: JSON.stringify({ status: 'unverifiable', criteria: [{ criterionId: 'criterion-1', status: 'unverifiable', evidenceRefs: [], rationale: 'Protocol fixture, no business acceptance claim.' }] }), toolCalls: [], finishReason: 'stop' }
    work++
    if (work > 15) throw new Error('SCRIPTED_PROVIDER_UNEXPECTED_LOOP')
    const values: Array<Record<string, any>> = []
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(inspect); return }
      if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>
        if (typeof row.processId === 'string') values.push(row)
        Object.values(row).forEach(inspect)
      }
    }
    params.request.blocks.filter(block => block.kind === 'results').forEach(block => inspect(block.content))
    for (const item of params.request.contextSpec.providerHistory ?? []) {
      if (item.role === 'tool') { try { inspect(JSON.parse(item.content)) } catch { /* Text-only tool receipt. */ } }
    }
    const handle = values.find(value => typeof value.processId === 'string')?.processId as string | undefined
    const call = (name: string, input: Record<string, unknown>) => ({ text: '', toolCalls: [{ toolCallId: `scripted-${work}`, name, input }], finishReason: 'tool_calls' as const })
    if (!handle) return call('shell.start', { command: 'node', args: [script], pty: true, timeoutMs: 10000 })
    if (values.some(value => value.status === 'exited')) return { text: 'Local interactive fixture finished.', toolCalls: [], finishReason: 'stop' }
    if (!inputProposed && values.some(value => value.stdinReady === true)) { inputProposed = true; return call('shell.stdin', { processId: handle, data: process.platform === 'win32' ? 'one-line\r' : 'one-line\n' }) }
    // Windows cold SRT startup can take minutes. One poll may wait the tool maximum
    // instead of issuing a new model turn every 200ms. The turn ceiling stays 15.
    const offset = Math.max(0, ...values.filter(value => value.processId === handle && Number.isSafeInteger(value.nextOffset)).map(value => value.nextOffset as number))
    return call('shell.poll', { processId: handle, offset, waitMs: process.platform === 'win32' ? 30_000 : 200, limit: 4096 })
  })
  const host = new LocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' }, taskController: false, taskControllerPolicy: 'legacy', jarvis: { enabled: false }, approvalMode: 'ask', execPolicy: { rules: [{ pattern: [identity.path, script], decision: 'allow' }] } })
  let runDirectory: string | undefined
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: 'Use the local interactive fixture once and send one-line.' })
    const approvals: string[] = [], events: unknown[] = []
    const observedRuntime = [...(host as any).active.values()].find((value: any) => value.runId === run.id)?.runtime
    for await (const event of run.events) {
      events.push(event)
      if (event.type !== 'waiting') continue
      const effectId = (event.data as { effectId?: string }).effectId
      const active = [...(host as any).active.values()][0]
      const pending = effectId ? active?.runtime.state.effects.get(effectId) : undefined
      if (!pending || pending.outcome) continue
      runDirectory = join(root, 'data', 'conversations', conversation.id, 'runs', active.runId)
      const calls = pending.input?.tools ?? []
      approvals.push(...calls.map((call: any) => call.toolName ?? call.name))
      expect(calls.every((call: any) => ['shell.stdin', 'shell.poll'].includes(call.toolName ?? call.name))).toBe(true)
      expect(pending.input.execPolicy).toBeUndefined()
      expect(await (host as any).execPolicy.automatic(pending.input, root, conversation.id, active.runId)).toBe('none')
      await run.reply(effectId!, { approved: true })
    }
    const outcome = await run.outcome()
    if (outcome.error) console.error('Host PTY fixture:', JSON.stringify({ error: outcome.error, work, inputProposed, effects: [...(observedRuntime?.state.effects.values() ?? [])].map((effect: any) => ({ id: effect.id, kind: effect.kind, tool: effect.input?.name, waitMs: effect.input?.arguments?.waitMs, attemptTimeoutMs: effect.attemptTimeoutMs, status: effect.outcome?.status, error: effect.outcome?.error?.code })) }))
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe('succeeded')
    expect(approvals.filter(name => name !== 'shell.poll')).toEqual(['shell.stdin'])
    expect(await readFile(join(root, 'received.txt'), 'utf8')).toBe('one-line')
    expect(work).toBeLessThan(10)
    expect(inputProposed).toBe(true)
    expect(JSON.parse(await readFile(join(runDirectory!, 'input.json'), 'utf8')).shellSurfaceVersion).toBe(1)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally { if (runDirectory) await closeShellProcesses(runDirectory); await host.close(); await rm(root, { recursive: true, force: true }) }
}, process.platform === 'win32' ? 300000 : 20000)

it('keeps old tool surfaces unchanged and does not allow interactive input to bypass explicit command restrictions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-pty-surface-'))
  const host = new LocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' }, taskController: false, approvalMode: 'ask', jarvis: { enabled: false } })
  try {
    const conversation = await host.createConversation()
    const open = async (id: string, input: object, continuous = false) => {
      const dir = join(root, 'data', 'conversations', conversation.id, 'runs', id)
      await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'input.json'), JSON.stringify(input))
      return (host as any).runtimeFor(conversation.id, id, root, 'local fixture', '', { ...(host as any).options, taskController: continuous, taskControllerPolicy: continuous ? 'continuous' : 'legacy' })
    }
    const old = await open('old', { fileSurfaceVersion: 2 })
    expect(old.registry.get('shell.start')).toBeUndefined()
    const priorContinuous = await open('prior-continuous', { fileSurfaceVersion: 2 }, true)
    expect(priorContinuous.registry.get('shell.start').manifest.inputSchema.properties).not.toHaveProperty('pty')
    expect(priorContinuous.registry.get('shell.stdin')).toBeUndefined()
    const current = await open('current', { fileSurfaceVersion: 3, shellSurfaceVersion: 1 })
    expect(current.registry.get('shell.start').validateInput({ command: 'node' }).pty).toBe(false)
    expect(current.registry.get('shell.stdin').manifest).toMatchObject({ sideEffectPolicy: 'external', retrySafety: 'unsafe' })
    for (const request of ['Do not run any commands.', 'Do not execute scripts.', 'Do not install packages.']) expect(() => assertExplicitToolRestriction(request, 'shell.stdin', { processId: 'local', data: 'input' })).toThrow('USER_TOOL_RESTRICTION')
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
