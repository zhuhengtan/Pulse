import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent, createRuntimeState, EffectOutbox, exportRuntimePersistence, MutationLog, type EffectRecord } from '@hunterzhu/pulse-runtime'
import { ConversationData } from '../packages/data/src/index.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { MockAdapter } from '@hunterzhu/pulse-adapters'
import { acceptanceCriteriaFromObjective, isTaskContinuation } from '../packages/server/src/task.js'
import { readConversationFixture, writeConversationFixture } from './conversation-fixtures.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

const hosts: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(hosts.splice(0).map(host => host.close().catch(() => undefined)))
})

async function temporary(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function watch(run: { events: AsyncIterable<{ type: string; data?: unknown }> }): { events: Array<{ type: string; data?: unknown }>; done: Promise<void>; error: () => unknown } {
  const events: Array<{ type: string; data?: unknown }> = []
  let failure: unknown
  const done = (async () => {
    try { for await (const event of run.events) events.push(event) }
    catch (error) { failure = error }
  })()
  return { events, done, error: () => failure }
}
async function until(events: Array<{ type: string; data?: unknown }>, predicate: (event: { type: string; data?: unknown }) => boolean): Promise<void> {
  const started = Date.now()
  while (!events.some(predicate)) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for events: ${events.map(event => event.type).join(',')}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

it('uses the captured execution directory for shell approval and keeps a missing directory diagnosable', async () => {
  const launcher = await temporary('pulse-f1-launcher-')
  const workspace = await temporary('pulse-f1-workspace-')
  await mkdir(join(workspace, 'packages', 'web'), { recursive: true })
  const host = createLocalHost({ cwd: launcher, dataDir: join(launcher, 'data'), taskController: false, approvalMode: 'ask', jarvis: { enabled: false }, mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'], cwd: 'packages/web' } }] })
  hosts.push(host)
  const conversation = await host.createConversation({ title: 'identity' })
  await host.setConversationExecutionWorkspace(conversation.id, workspace, workspace)
  const run = await host.sendMessage(conversation.id, { text: 'run the web tests' })
  const watched = watch(run)
  await until(watched.events, event => event.type === 'waiting' || event.type === 'error' || event.type === 'complete')
  expect(watched.error()).toBeUndefined()
  expect(watched.events.some(event => event.type === 'error' && String(event.data).includes('ENOENT'))).toBe(false)
  const waiting = watched.events.find(event => event.type === 'waiting') as { data?: { input?: { execPolicyError?: string } } } | undefined
  expect(waiting?.data?.input?.execPolicyError).toBeUndefined()
  await run.cancel()
  await watched.done

  const missing = createLocalHost({ cwd: launcher, dataDir: join(launcher, 'missing-data'), taskController: false, approvalMode: 'ask', jarvis: { enabled: false }, mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'], cwd: 'missing/child' } }] })
  hosts.push(missing)
  const second = await missing.createConversation({ title: 'missing' })
  await missing.setConversationExecutionWorkspace(second.id, workspace, workspace)
  const blocked = await missing.sendMessage(second.id, { text: 'run where the directory is gone' })
  const blockedWatch = watch(blocked)
  await until(blockedWatch.events, event => event.type === 'waiting' || event.type === 'error' || event.type === 'complete')
  const diagnostic = blockedWatch.events.find(event => event.type === 'waiting') as { data?: { input?: { execPolicyError?: string } } } | undefined
  expect(diagnostic?.data?.input?.execPolicyError).toContain('ENOENT')
  await blocked.cancel()
  await blockedWatch.done
  expect(blockedWatch.error()).toBeUndefined()
  expect((await missing.getConversation(second.id)).summary.activeRunId).toBeUndefined()

  const outside = createLocalHost({ cwd: launcher, dataDir: join(launcher, 'outside-data'), taskController: false, approvalMode: 'ask', jarvis: { enabled: false }, mockResponse: '路径已拒绝。', mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'], cwd: '../outside' } }] })
  hosts.push(outside)
  const third = await outside.createConversation({ title: 'outside' })
  await outside.setConversationExecutionWorkspace(third.id, workspace, workspace)
  const escaped = await outside.sendMessage(third.id, { text: 'do not leave the workspace' })
  const escapedWatch = watch(escaped)
  await Promise.race([escapedWatch.done, new Promise(resolve => setTimeout(resolve, 4000))])
  expect(escapedWatch.error()).toBeUndefined()
  expect(escapedWatch.events.some(event => event.type === 'error' && String(event.data).includes('ENOENT'))).toBe(false)
  await escaped.cancel().catch(() => undefined)
  await escapedWatch.done
})

it('settles a stopped host run without Jarvis and without dropping the busy marker', async () => {
  const directory = await temporary('pulse-f2-close-')
  const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), taskController: false, approvalMode: 'ask', jarvis: { enabled: false }, mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'] } }] })
  const conversation = await host.createConversation({ title: 'close' })
  const run = await host.sendMessage(conversation.id, { text: 'wait for approval' })
  const watched = watch(run)
  await until(watched.events, event => event.type === 'waiting')
  await host.close()
  const data = new ConversationData(join(directory, 'data'))
  try {
    const manifest = await data.call<{ activeRunId?: string; runs: string[] }>('get', conversation.id)
    expect(manifest.activeRunId).toBeUndefined()
    const outcome = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', manifest.runs.at(-1)!, 'outcome.json'), 'utf8')) as { status: string }
    expect(outcome.status).toBe('cancelled')
  } finally { await data.close() }
})

it('keeps a settled shell.start blocked while its persisted process is unknown and releases a known exit', async () => {
  const directory = await temporary('pulse-f22-shell-')
  const sandboxTiming = process.env.PULSE_SANDBOX_TIMING
  // Capture native phase latency only for this fixture, not JSON CLI children.
  if (process.platform === 'win32') process.env.PULSE_SANDBOX_TIMING = '1'
  // Separate model turns keep the asynchronous process owned until actual exit.
  // Model completion alone is not evidence that a cold Windows shell has exited.
  // Native Windows evidence includes PowerShell's first-use module preparation:
  // a 5s request really timed out despite node --version eventually exiting 0.
  // This success-path fixture requests 20s there; production deadlines and the
  // separate real 25ms timeout regression remain unchanged.
  const commandTimeoutMs = process.platform === 'win32' ? 20_000 : 5_000
  const model = vi.spyOn(MockAdapter.prototype, 'executeAttempt')
    .mockResolvedValueOnce({ text: '', toolCalls: [{ toolCallId: 'start', name: 'shell.start', input: { command: 'node', args: ['--version'], timeoutMs: commandTimeoutMs } }], finishReason: 'tool_calls' })
    .mockResolvedValueOnce({ text: '', toolCalls: [{ toolCallId: 'wait-exit', name: 'ask.choice', input: { prompt: 'Wait for the fixture process to exit.', decisionId: 'fixture-exit', options: [{ label: 'Continue', value: 'continue' }] } }], finishReason: 'tool_calls' })
    .mockResolvedValue({ text: 'Local fixture launched.', toolCalls: [], finishReason: 'stop' })
  try {
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), taskController: false, approvalMode: 'ask', jarvis: { enabled: false } })
    hosts.push(host)
    const conversation = await host.createConversation({ title: 'shell' })
    const run = await host.sendMessage(conversation.id, { text: 'launch a local process' })
    for await (const event of run.events) {
      if (event.type !== 'waiting') continue
      const effectId = String((event.data as { effectId?: string }).effectId)
      const group = (await run.pendingInteractions()).find(item => item.items.some(input => input.effectId === effectId))
      expect(group).toBeDefined()
      if (group?.kind === 'approval') await run.reply(effectId, { approved: true })
      else {
        const started = Date.now(), timeout = process.platform === 'win32' ? 275_000 : 10_000
        for (;;) {
          const child = (await host.listRunProcesses(conversation.id, run.id))[0]
          if (child?.status === 'exited') {
            // This fixture runs only a local node --version. Preserve bounded
            // output and the deadline flags instead of losing the first native
            // error behind the list API's intentionally abbreviated result.
            const output = await host.readRunProcess(conversation.id, run.id, child.processId)
            const diagnostic = JSON.stringify({ result: child.result, output: output.output })
            if (child.result?.code !== 0) console.error('Fixture shell exit:', diagnostic)
            expect(child.result, diagnostic).toMatchObject({ code: 0, aborted: false, timedOut: false })
            break
          }
          expect(child?.status, child?.error).toBe('running')
          if (Date.now() - started > timeout) throw new Error('Fixture shell did not reach a durable exit')
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        await run.reply(effectId, { value: 'continue' })
      }
    }
    expect((await run.outcome()).status).toBe('succeeded')
    const manifest = await (host as unknown as { readManifest(id: string): Promise<{ runs: string[]; activeRunId?: string }> }).readManifest(conversation.id)
    const runId = manifest.runs.at(-1)!
    const processDir = join(directory, 'data', 'conversations', conversation.id, 'runs', runId, 'shell-processes')
    const receiptName = (await readdir(processDir)).find(name => /^[a-f0-9]{64}\.json$/.test(name))
    expect(receiptName).toBeTruthy()
    const receiptPath = join(processDir, receiptName!)
    const budgetPath = join(directory, 'data', 'conversations', conversation.id, 'runs', runId, 'model-budget.json')
    const runtimePath = join(directory, 'data', 'conversations', conversation.id, 'runs', runId, 'runtime.json')
    expect((await host.listRunProcesses(conversation.id, runId))[0]?.status).toBe('exited')
    const budgetBefore = await readFile(budgetPath).catch(() => Buffer.alloc(0))
    const runtimeBefore = await readFile(runtimePath)
    const exitedReceipt = await readFile(receiptPath)
    manifest.activeRunId = runId
    await (host as unknown as { saveManifest(manifest: { runs: string[]; activeRunId?: string }): Promise<void> }).saveManifest(manifest)
    await expect(host.reconcileInactiveRun(conversation.id, runId)).resolves.toMatchObject({ cleared: true, status: 'succeeded' })
    expect((await host.getConversation(conversation.id)).summary.activeRunId).toBeUndefined()
    expect(await readFile(budgetPath).catch(() => Buffer.alloc(0))).toEqual(budgetBefore)
    expect(await readFile(runtimePath)).toEqual(runtimeBefore)
    expect(await readFile(receiptPath)).toEqual(exitedReceipt)

    const unknown = JSON.parse(exitedReceipt.toString('utf8')) as { status: string; result?: unknown; error?: unknown }
    unknown.status = 'running'
    delete unknown.result
    delete unknown.error
    await writeFile(receiptPath, JSON.stringify(unknown))
    expect((await host.listRunProcesses(conversation.id, runId))[0]?.status).toBe('unknown')
    const blockedBudget = await readFile(budgetPath).catch(() => Buffer.alloc(0))
    const blockedRuntime = await readFile(runtimePath)
    const blockedReceipt = await readFile(receiptPath)
    const restored = await (host as unknown as { readManifest(id: string): Promise<{ runs: string[]; activeRunId?: string }> }).readManifest(conversation.id)
    restored.activeRunId = runId
    await (host as unknown as { saveManifest(manifest: { runs: string[]; activeRunId?: string }): Promise<void> }).saveManifest(restored)
    await expect(host.reconcileInactiveRun(conversation.id, runId)).rejects.toThrow(/RECOVERY_SIDE_EFFECT_UNKNOWN|SHELL_PROCESS_STATE_UNKNOWN|SHELL_PROCESS_RUNNING/)
    expect((await (host as unknown as { readManifest(id: string): Promise<{ activeRunId?: string }> }).readManifest(conversation.id)).activeRunId).toBe(runId)
    expect(await host.inactiveReleaseBlocker(conversation.id, runId)).toBe('RECOVERY_SIDE_EFFECT_UNKNOWN')
    expect(await readFile(budgetPath).catch(() => Buffer.alloc(0))).toEqual(blockedBudget)
    expect(await readFile(runtimePath)).toEqual(blockedRuntime)
    expect(await readFile(receiptPath)).toEqual(blockedReceipt)
  } finally {
    model.mockRestore()
    if (sandboxTiming === undefined) delete process.env.PULSE_SANDBOX_TIMING
    else process.env.PULSE_SANDBOX_TIMING = sandboxTiming
  }
}, process.platform === 'win32' ? 300_000 : 20_000)

it('does not release a stopped host while a persisted shell is still unknown', async () => {
  const directory = await temporary('pulse-f22-close-')
  const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), taskController: false, approvalMode: 'ask', jarvis: { enabled: false }, mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'] } }] })
  const conversation = await host.createConversation({ title: 'close-shell' })
  const run = await host.sendMessage(conversation.id, { text: 'wait for approval' })
  const watched = watch(run)
  await until(watched.events, event => event.type === 'waiting')
  const runId = (await host.getConversation(conversation.id)).summary.activeRunId
  expect(runId).toBeTruthy()
  const processId = 'ab'.repeat(32)
  const receiptPath = join(directory, 'data', 'conversations', conversation.id, 'runs', runId!, 'shell-processes', `${processId}.json`)
  await mkdir(join(receiptPath, '..'), { recursive: true })
  const receipt = JSON.stringify({ processId, agentId: 'agent-1', laneId: 'lane-1', status: 'running', command: { command: 'node', args: ['--version'] } })
  await writeFile(receiptPath, receipt)
  await host.close()
  const data = new ConversationData(join(directory, 'data'))
  try {
    const manifest = await data.call<{ activeRunId?: string }>('get', conversation.id)
    expect(manifest.activeRunId).toBe(runId)
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
  } finally { await data.close() }
})

it('keeps busy when normal finish sees an unresolved shell and still releases a safe cancel', async () => {
  const blocked = await temporary('pulse-f23-finish-')
  const blockedHost = createLocalHost({ cwd: blocked, dataDir: join(blocked, 'data'), provider: { provider: 'mock' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'] } }] })
  const blockedConversation = await blockedHost.createConversation({ title: 'finish-blocked' })
  const blockedRun = await blockedHost.sendMessage(blockedConversation.id, { text: 'Wait for approval.' })
  const blockedIterator = blockedRun.events[Symbol.asyncIterator]()
  let blockedWaiting = false
  for (let n = 0; n < 100 && !blockedWaiting; n++) {
    const event = await blockedIterator.next()
    if (event.done) break
    blockedWaiting = event.value.type === 'waiting'
  }
  expect(blockedWaiting).toBe(true)
  const processId = 'cd'.repeat(32)
  const receiptPath = join(blocked, 'data', 'conversations', blockedConversation.id, 'runs', blockedRun.id, 'shell-processes', `${processId}.json`)
  await mkdir(join(receiptPath, '..'), { recursive: true })
  const receipt = JSON.stringify({ processId, agentId: 'agent-1', laneId: 'lane-1', status: 'running', command: { command: 'node', args: ['--version'] } })
  await writeFile(receiptPath, receipt)
  await blockedRun.cancel()
  await blockedRun.outcome()
  expect((await blockedHost.getConversation(blockedConversation.id)).summary.activeRunId).toBe(blockedRun.id)
  expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
  await blockedHost.close()
  const blockedData = new ConversationData(join(blocked, 'data'))
  try {
    expect((await blockedData.call<{ activeRunId?: string }>('get', blockedConversation.id)).activeRunId).toBe(blockedRun.id)
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
  } finally { await blockedData.close() }

  const released = await temporary('pulse-f23-finish-clear-')
  const releasedHost = createLocalHost({ cwd: released, dataDir: join(released, 'data'), provider: { provider: 'mock' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', mockToolCalls: [{ name: 'shell.exec', input: { command: 'node', args: ['--version'] } }] })
  hosts.push(releasedHost)
  const releasedConversation = await releasedHost.createConversation({ title: 'finish-clear' })
  const releasedRun = await releasedHost.sendMessage(releasedConversation.id, { text: 'Wait for approval.' })
  const releasedIterator = releasedRun.events[Symbol.asyncIterator]()
  let releasedWaiting = false
  for (let n = 0; n < 100 && !releasedWaiting; n++) {
    const event = await releasedIterator.next()
    if (event.done) break
    releasedWaiting = event.value.type === 'waiting'
  }
  expect(releasedWaiting).toBe(true)
  await releasedRun.cancel()
  await releasedRun.outcome()
  expect((await releasedHost.getConversation(releasedConversation.id)).summary.activeRunId).toBeUndefined()
})

function controllerSnapshot(goal: string, effect: EffectRecord): string {
  const state = createRuntimeState()
  const { agent, root } = createAgent(state, goal, { programId: 'pulse.assistant', programVersion: '56', step: 'work', locals: {} })
  agent.state = 'cancelled'
  root.ownedEffectIds.add(effect.id)
  effect.agentId = agent.id
  effect.ownerLaneId = root.id
  state.effects.set(effect.id, effect)
  if (effect.outcome?.resultRef) {
    state.results.set(effect.outcome.resultRef, { id: effect.outcome.resultRef, producer: { kind: 'effect', id: effect.id }, privacy: 'public', derivedFrom: [], value: { path: 'greeting.txt', changed: true, text: 'hello' } })
  }
  return JSON.stringify(exportRuntimePersistence(state, new MutationLog(), new EffectOutbox()))
}

async function orphanRun(directory: string, effect: EffectRecord): Promise<{ host: ReturnType<typeof createLocalHost>; conversationId: string; runId: string; budget: string; snapshot: string }> {
  const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), jarvis: { enabled: false }, mockResponse: '已承接。' })
  hosts.push(host)
  const conversation = await host.createConversation({ title: 'orphan' })
  const runId = 'run-controller-56'
  const runDirectory = join(directory, 'data', 'conversations', conversation.id, 'runs', runId)
  await mkdir(runDirectory, { recursive: true })
  const goal = 'Create greeting.txt containing hello.'
  await writeFile(join(directory, 'greeting.txt'), 'hello')
  await writeFile(join(runDirectory, 'input.json'), JSON.stringify({ schemaVersion: 1, conversationId: conversation.id, runId, goal, capabilitySurface: 1, controllerVersion: '56', cwd: directory }))
  const budget = JSON.stringify({ schemaVersion: 1, limit: 256, used: 39 })
  await writeFile(join(runDirectory, 'model-budget.json'), budget)
  const snapshot = controllerSnapshot(goal, effect)
  await writeFile(join(runDirectory, 'runtime.json'), snapshot)
  const manifestPath = join(directory, 'data', 'conversations', conversation.id, 'manifest.json')
  const manifest = JSON.parse(await readConversationFixture(manifestPath, 'utf8')) as { activeRunId?: string; runs: string[] }
  manifest.activeRunId = runId
  manifest.runs = [runId]
  await writeConversationFixture(manifestPath, JSON.stringify(manifest))
  return { host, conversationId: conversation.id, runId, budget, snapshot }
}

it('releases a terminal controller 56 marker and blocks unknown or pending work', async () => {
  const safeDirectory = await temporary('pulse-f2-safe-')
  const safe = await orphanRun(safeDirectory, { id: 'effect-write', agentId: '', ownerLaneId: '', key: 'write', kind: 'tool', concurrencyClass: 'tool', input: { name: 'fs.write', arguments: { path: 'greeting.txt', content: 'hello' } }, state: 'succeeded', attemptId: 'attempt-1', attemptNo: 1, executionState: 'succeeded', sideEffectState: 'known', outcome: { status: 'succeeded', resultRef: 'result-1' } })
  const released = await safe.host.reconcileInactiveRun(safe.conversationId, safe.runId)
  expect(released).toMatchObject({ cleared: true, status: 'cancelled' })
  expect((await safe.host.getConversation(safe.conversationId)).summary.activeRunId).toBeUndefined()
  const runDirectory = join(safeDirectory, 'data', 'conversations', safe.conversationId, 'runs', safe.runId)
  expect(await readFile(join(runDirectory, 'runtime.json'), 'utf8')).toBe(safe.snapshot)
  expect(await readFile(join(runDirectory, 'model-budget.json'), 'utf8')).toBe(safe.budget)
  expect(JSON.parse(await readFile(join(runDirectory, 'outcome.json'), 'utf8'))).toMatchObject({ status: 'cancelled', error: { code: 'ORPHAN_ACTIVE_RELEASED' } })
  const continued = await safe.host.sendMessage(safe.conversationId, { text: '继续' })
  const continuedWatch = watch(continued)
  await until(continuedWatch.events, event => event.type === 'complete')
  const continuedManifest = JSON.parse(await readConversationFixture(join(safeDirectory, 'data', 'conversations', safe.conversationId, 'manifest.json'), 'utf8')) as { runs: string[] }
  const continuedRunId = continuedManifest.runs.at(-1)!
  expect(continuedRunId).not.toBe(safe.runId)
  const continuedRecord = JSON.parse(await readFile(join(safeDirectory, 'data', 'conversations', safe.conversationId, 'runs', continuedRunId, 'task-record.json'), 'utf8')) as { objective: string; continuedFromRunId?: string }
  expect(continuedRecord.objective).toBe('Create greeting.txt containing hello.')
  expect(continuedRecord.continuedFromRunId).toBe(safe.runId)
  await continuedWatch.done
  expect(await readFile(join(runDirectory, 'model-budget.json'), 'utf8')).toBe(safe.budget)
  expect(await readFile(join(runDirectory, 'runtime.json'), 'utf8')).toBe(safe.snapshot)
  expect(await readFile(join(safeDirectory, 'greeting.txt'), 'utf8')).toBe('hello')

  const unknownDirectory = await temporary('pulse-f2-unknown-')
  const unknown = await orphanRun(unknownDirectory, { id: 'effect-shell', agentId: '', ownerLaneId: '', key: 'shell', kind: 'tool', concurrencyClass: 'tool', input: { name: 'shell.exec', arguments: { command: 'npm', args: ['test'] } }, state: 'running', attemptId: 'attempt-1', attemptNo: 1, executionState: 'remote_unknown', sideEffectState: 'unknown' })
  await expect(unknown.host.reconcileInactiveRun(unknown.conversationId, unknown.runId)).rejects.toThrow('RECOVERY_SIDE_EFFECT_UNKNOWN')
  expect((await unknown.host.getConversation(unknown.conversationId)).summary.activeRunId).toBe(unknown.runId)
  await expect(unknown.host.sendMessage(unknown.conversationId, { text: '继续' })).rejects.toThrow('CONVERSATION_BUSY')
  expect(await readFile(join(unknownDirectory, 'data', 'conversations', unknown.conversationId, 'runs', unknown.runId, 'model-budget.json'), 'utf8')).toBe(unknown.budget)

  const pendingDirectory = await temporary('pulse-f2-pending-')
  const pending = await orphanRun(pendingDirectory, { id: 'effect-human', agentId: '', ownerLaneId: '', key: 'approval', kind: 'human', concurrencyClass: 'none', input: { kind: 'approval' }, state: 'queued', attemptId: 'attempt-1', attemptNo: 1, executionState: 'local', sideEffectState: 'none' })
  await expect(pending.host.reconcileInactiveRun(pending.conversationId, pending.runId)).rejects.toThrow('RUN_AWAITING_APPROVAL')
  expect((await pending.host.getConversation(pending.conversationId)).summary.activeRunId).toBe(pending.runId)
})

async function seedMisclassifiedRetries(directory: string): Promise<{ host: ReturnType<typeof createLocalHost>; conversationId: string; goal: string; criteria: ReturnType<typeof acceptanceCriteriaFromObjective>; files: Map<string, string> }> {
  const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), jarvis: { enabled: false }, mockResponse: '已承接。' })
  hosts.push(host)
  const conversation = await host.createConversation({ title: 'retry-chain' })
  const goal = 'Create greeting.txt containing hello.'
  const criteria = acceptanceCriteriaFromObjective(goal)
  await writeFile(join(directory, 'greeting.txt'), 'hello')
  const runs = ['run-original-goal', 'run-retry-used-38', 'run-retry-used-39'] as const
  const files = new Map<string, string>()
  for (const runId of runs) {
    const runDirectory = join(directory, 'data', 'conversations', conversation.id, 'runs', runId)
    await mkdir(runDirectory, { recursive: true })
    const objective = runId === 'run-original-goal' ? goal : '重试'
    const record = JSON.stringify({ schemaVersion: 1, runId, objective, acceptanceCriteria: runId === 'run-original-goal' ? criteria : [{ id: 'criterion-1', description: '重试' }], status: 'incomplete', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] })
    const budget = JSON.stringify(runId === 'run-retry-used-39'
      ? { schemaVersion: 1, limit: 256, used: 39, inheritedFrom: join(runDirectory, '..', 'run-retry-used-38', 'model-budget.json') }
      : { schemaVersion: 1, limit: 256, used: runId === 'run-retry-used-38' ? 38 : 1 })
    const input = JSON.stringify({ schemaVersion: 1, conversationId: conversation.id, runId, goal: objective, capabilitySurface: 1, controllerVersion: '56', cwd: directory })
    await writeFile(join(runDirectory, 'task-record.json'), record)
    await writeFile(join(runDirectory, 'model-budget.json'), budget)
    await writeFile(join(runDirectory, 'input.json'), input)
    files.set(join(runDirectory, 'task-record.json'), record)
    files.set(join(runDirectory, 'model-budget.json'), budget)
    files.set(join(runDirectory, 'input.json'), input)
  }
  const manifestPath = join(directory, 'data', 'conversations', conversation.id, 'manifest.json')
  const manifest = JSON.parse(await readConversationFixture(manifestPath, 'utf8')) as { activeRunId?: string; runs: string[] }
  delete manifest.activeRunId
  manifest.runs = [...runs]
  await writeConversationFixture(manifestPath, JSON.stringify(manifest))
  return { host, conversationId: conversation.id, goal, criteria, files }
}

it('continues 重试 and 没做完啊 from the original contract without resetting the latest budget', async () => {
  expect(isTaskContinuation('重试')).toBe(true)
  expect(isTaskContinuation('没做完啊')).toBe(true)
  expect(isTaskContinuation('不要重试')).toBe(false)
  expect(isTaskContinuation('新任务')).toBe(false)
  for (const text of ['没做完啊', '重试'] as const) {
    const directory = await temporary(`pulse-f2-continue-${text}-`)
    const seeded = await seedMisclassifiedRetries(directory)
    const run = await seeded.host.sendMessage(seeded.conversationId, { text })
    const watched = watch(run)
    await until(watched.events, event => event.type === 'complete')
    await watched.done
    const manifest = JSON.parse(await readConversationFixture(join(directory, 'data', 'conversations', seeded.conversationId, 'manifest.json'), 'utf8')) as { runs: string[] }
    const continuedRunId = manifest.runs.at(-1)!
    expect(continuedRunId).not.toBe('run-retry-used-39')
    const record = JSON.parse(await readFile(join(directory, 'data', 'conversations', seeded.conversationId, 'runs', continuedRunId, 'task-record.json'), 'utf8')) as { objective: string; continuedFromRunId?: string; acceptanceCriteria: Array<{ description: string }> }
    expect(record.objective).toBe(seeded.goal)
    expect(record.continuedFromRunId).toBe('run-original-goal')
    expect(record.acceptanceCriteria.map(criterion => criterion.description)).toEqual(seeded.criteria.map(criterion => criterion.description))
    const budget = JSON.parse(await readFile(join(directory, 'data', 'conversations', seeded.conversationId, 'runs', continuedRunId, 'model-budget.json'), 'utf8')) as { limit: number; used: number; inheritedFrom?: string }
    expect(budget.limit).toBe(217)
    expect(budget.inheritedFrom).toContain('run-retry-used-39')
    expect(budget.inheritedFrom).not.toContain('run-original-goal')
    expect(budget.inheritedFrom).not.toContain('run-retry-used-38')
    for (const [path, body] of seeded.files) expect(await readFile(path, 'utf8')).toBe(body)
    expect(await readFile(join(directory, 'greeting.txt'), 'utf8')).toBe('hello')
  }
  const rejected = await temporary('pulse-f2-do-not-retry-')
  const seeded = await seedMisclassifiedRetries(rejected)
  const fresh = await seeded.host.sendMessage(seeded.conversationId, { text: '不要重试' })
  const watched = watch(fresh)
  await until(watched.events, event => event.type === 'complete')
  await watched.done
  const manifest = JSON.parse(await readConversationFixture(join(rejected, 'data', 'conversations', seeded.conversationId, 'manifest.json'), 'utf8')) as { runs: string[] }
  const freshRunId = manifest.runs.at(-1)!
  const record = JSON.parse(await readFile(join(rejected, 'data', 'conversations', seeded.conversationId, 'runs', freshRunId, 'task-record.json'), 'utf8')) as { objective: string; continuedFromRunId?: string }
  const budget = JSON.parse(await readFile(join(rejected, 'data', 'conversations', seeded.conversationId, 'runs', freshRunId, 'model-budget.json'), 'utf8')) as { limit: number; inheritedFrom?: string }
  expect(record.objective).toBe('不要重试')
  expect(record.continuedFromRunId).toBeUndefined()
  expect(budget.limit).toBe(256)
  expect(budget.inheritedFrom).toBeUndefined()
  for (const [path, body] of seeded.files) expect(await readFile(path, 'utf8')).toBe(body)
})

function sse(content: string, reasoning?: string, finish = 'stop'): Response {
  const rows = [
    ...(reasoning ? [JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] })] : []),
    JSON.stringify({ choices: [{ index: 0, delta: { content } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  ]
  return new Response(`${rows.map(row => `data: ${row}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
function chat(message: unknown): Response {
  const payload = typeof message === 'string' ? { content: message } : message
  const finish = payload && typeof payload === 'object' && 'tool_calls' in (payload as object) ? 'tool_calls' : 'stop'
  return new Response(JSON.stringify({ choices: [{ message: payload, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
}
function writeCall(): Response {
  return chat({ content: '', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello' }) } }] })
}

it('rejects whitespace and private reasoning, then accepts one visible correction', async () => {
  const cwd = await temporary('pulse-f4-visible-')
  const objective = 'Create greeting.txt containing hello.'
  const ids = acceptanceCriteriaFromObjective(objective).map(criterion => criterion.id)
  let writes = 0
  let stageReviews = 0
  const seen: string[] = []
  const verifyRequests: Array<{ tools?: unknown; response_format?: { type?: string }; messages: Array<{ role?: string; content?: unknown }> }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    const text = currentRequestText(request.messages)
    const raw = JSON.stringify(request)
    const kind = raw.includes('needs_work') ? 'verify' : text.includes('Create an executable plan') ? 'plan' : text.includes('Execute only the active taskController stage') || text.includes('Execute only this independent') ? 'work' : text.includes('progress checkpoint') || (raw.includes('"ready"') && raw.includes('"continue"')) ? 'progress' : text.includes('Independently verify every ORIGINAL') ? 'final-review' : text.includes('final user-facing reply') ? 'reply' : 'other'
    seen.push(kind)
    if (kind === 'verify') seen[seen.length - 1] = `${kind} refs=${suppliedRequestResults(request.messages).map((item: { id: string }) => item.id).join(',') || 'none'} errors=${raw.includes('validationErrors')} leaked=${raw.includes('from-private-reasoning') || raw.includes('result-999999')}`
    if (kind === 'reply') return chat('Saved.')
    if (kind === 'plan') return chat(JSON.stringify({ tasks: [{ id: 'create', kind: 'edit', goal: objective, check: 'File saved', dependsOn: [], criterionIds: ids }] }))
    if (kind === 'progress') return chat(JSON.stringify({ status: 'ready', evidenceRefs: suppliedRequestResults(request.messages).map((item: { id: string }) => item.id).slice(0, 8), note: 'enough' }))
    if (kind === 'verify') {
      stageReviews++
      verifyRequests.push(request)
      const evidence = suppliedRequestResults(request.messages)
      const fileRefs = evidence.filter((item: { value?: unknown }) => JSON.stringify(item.value ?? '').includes('greeting.txt')).map((item: { id: string }) => item.id)
      const refs = (fileRefs.length ? fileRefs : evidence.map((item: { id: string }) => item.id)).slice(0, 8)
      if (stageReviews === 1) return sse(' \n ', JSON.stringify({ status: 'passed', evidenceRefs: ['result-999999'], note: 'from-private-reasoning' }))
      return sse(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'Saved file' }))
    }
    if (kind === 'final-review') return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'passed', evidenceRefs: suppliedRequestResults(request.messages).map((item: { id: string }) => item.id), rationale: 'Actual saved file' })) }))
    if (kind === 'work') { if (writes === 0) { writes = 1; return writeCall() } return chat('Saved.') }
    return chat('Saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'deepseek', defaultModel: 'deepseek-flash', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'test' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  hosts.push(host)
  const conversation = await host.createConversation()
  const run = await host.sendMessage(conversation.id, { text: objective })
  const outcome = await run.outcome()
  expect(outcome.status, `${outcome.text}\n${seen.join('\n---\n')}`).toBe('succeeded')
  expect(await run.taskOutcome(), seen.join('\n---\n')).toMatchObject({ status: 'accepted' })
  expect(stageReviews, seen.join('\n---\n')).toBe(2)
  expect(writes).toBe(1)
  expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe('hello')
  expect(verifyRequests).toHaveLength(2)
  for (const request of verifyRequests) {
    expect(request.tools ?? []).toEqual([])
    expect(request.response_format).toMatchObject({ type: 'json_object' })
    const system = request.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n')
    expect(system).toContain('isolated verifier')
    expect(system).not.toContain('careful general-purpose task assistant')
    expect(JSON.stringify(request.messages)).not.toContain('from-private-reasoning')
    expect(JSON.stringify(request.messages)).not.toContain('Return a nonempty plain-text summary only')
  }
  expect(JSON.stringify(verifyRequests[1]?.messages)).toContain('validationErrors')
})

it('stops after one illegal correction without another edit', async () => {
  const cwd = await temporary('pulse-f4-reject-')
  const objective = 'Create greeting.txt containing hello.'
  const ids = acceptanceCriteriaFromObjective(objective).map(criterion => criterion.id)
  let writes = 0
  let stageReviews = 0
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    const text = currentRequestText(request.messages)
    const raw = JSON.stringify(request)
    const kind = raw.includes('needs_work') ? 'verify' : text.includes('Create an executable plan') ? 'plan' : text.includes('Execute only the active taskController stage') || text.includes('Execute only this independent') ? 'work' : text.includes('progress checkpoint') || (raw.includes('"ready"') && raw.includes('"continue"')) ? 'progress' : text.includes('Independently verify every ORIGINAL') ? 'final-review' : text.includes('final user-facing reply') ? 'reply' : 'other'
    seen.push(kind)
    if (kind === 'reply') return chat('Stopped.')
    if (kind === 'plan') return chat(JSON.stringify({ tasks: [{ id: 'create', kind: 'edit', goal: objective, check: 'File saved', dependsOn: [], criterionIds: ids }] }))
    if (kind === 'progress') return chat(JSON.stringify({ status: 'ready', evidenceRefs: suppliedRequestResults(request.messages).map((item: { id: string }) => item.id).slice(0, 8), note: 'enough' }))
    if (kind === 'verify') {
      stageReviews++
      if (stageReviews === 1) return sse(' \n ', JSON.stringify({ status: 'passed', evidenceRefs: ['result-999999'], note: 'from-private-reasoning' }))
      if (stageReviews === 2) return sse('{"status":"passed","unexpected":true}')
      return sse('{"status":"pas', undefined, 'length')
    }
    if (kind === 'final-review') return chat(JSON.stringify({ criteria: ids.map(id => ({ criterionId: id, status: 'not_met', evidenceRefs: [], rationale: 'Stage did not pass' })) }))
    if (kind === 'work') { if (writes === 0) { writes = 1; return writeCall() } return chat('Saved.') }
    return chat('Saved.')
  }))
  const host = createLocalHost({ cwd, dataDir: join(cwd, 'data'), provider: { provider: 'deepseek', defaultModel: 'deepseek-flash', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'test' }, taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 16 })
  hosts.push(host)
  const conversation = await host.createConversation()
  const run = await host.sendMessage(conversation.id, { text: objective })
  const outcome = await run.outcome()
  const taskOutcome = await run.taskOutcome()
  expect(stageReviews, seen.join('\n---\n')).toBe(2)
  expect(writes).toBe(1)
  expect(taskOutcome?.status).not.toBe('accepted')
  expect(outcome.status === 'succeeded' || outcome.status === 'failed' || outcome.status === 'cancelled').toBe(true)
  expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe('hello')
})
