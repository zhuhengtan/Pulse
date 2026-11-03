import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { readUpdateResume, saveUpdateResume } from '../packages/server/src/updates/resume.js'
import { atomicJson, readState, statePath } from '../packages/server/src/updates/store.js'
import { serviceRuntime, updateFixture } from './update-fixtures.js'

it('checkpoints an approved-update interruption, restores only that run, and executes its pending write exactly once', async () => {
  const f = await updateFixture()
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    if (!String(input).startsWith('http://127.0.0.1:12345/')) return nativeFetch(input, init)
    const written = await readFile(join(f.root, 'retained.txt'), 'utf8').then(value => value === 'one write', () => false)
    const message = written ? { content: 'done' } : { content: '', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'retained.txt', content: 'one write' }) } }] }
    return Response.json({ choices: [{ message, finish_reason: written ? 'stop' : 'tool_calls' }] })
  })
  const options = { cwd: f.root, dataDir: f.dataDir, taskController: false, jarvis: { enabled: false }, approvalMode: 'ask' as const, provider: { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' } }
  const host = createLocalHost(options)
  const updates = { root: f.root, development: true, indexUrl: f.base + 'index.json', keys: f.keys }
  const server = new H5Server(host, { dataDir: f.dataDir, host: '127.0.0.1', port: 0, updates })
  let replacement: H5Server | undefined, nextHost: ReturnType<typeof createLocalHost> | undefined
  try {
    await f.add('9.9.9', 'backend', await serviceRuntime(join(f.root, 'candidate'), '9.9.9'));  f.index()
    const started = await server.start(); server.updates.stop()
    await server.updates.check(); await server.updates.download()
    const conversation = await host.createConversation()
    const handle = await host.sendMessage(conversation.id, { text: 'Write retained.txt after approval' })
    ;(server as any).attachRun(handle)
    await vi.waitFor(async () => expect((await handle.pendingInteractions()).length).toBe(1))
    const pending = await handle.pendingInteractions(), budget = await readFile(join(f.dataDir, 'conversations', conversation.id, 'runs', handle.id, 'model-budget.json'), 'utf8')
    const base = `http://127.0.0.1:${started.port}`
    const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const apply = await fetch(base + '/api/updates/apply', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) })
    expect(apply.status).toBe(200)
    await (server as any).tryApplyUpdate()
    const scheduled = await readState(f.root, f.dataDir)
    expect(scheduled.force).toBe(true)
    const { releaseId } = await import('../packages/server/src/updates/contracts.js')
    // An earlier handoff may have stopped before installation; retain newly
    // admitted work when retrying that same candidate.
    await saveUpdateResume(f.dataDir, { schema: 1, id: 'prior-handoff', fromVersion: server.updates.options.backendVersion, toVersion: '9.9.9', targetBackend: releaseId(scheduled.staged!.backend!.manifest), runs: [{ conversationId: conversation.id, runId: 'already-ended', status: 'pending' }] })
    await (server as any).checkpointUpdateRuns(scheduled)
    const journal = await readUpdateResume(f.dataDir)
    expect(journal?.runs).toEqual([{ conversationId: conversation.id, runId: 'already-ended', status: 'pending' }, { conversationId: conversation.id, runId: handle.id, status: 'pending' }])
    await server.stop(); await host.close({ preserveRuns: true })
    // Simulate the coordinator activating the already verified signed selection.
    scheduled.active = scheduled.staged!; delete scheduled.staged; scheduled.pending = false; delete scheduled.force; scheduled.phase = 'idle'
    await atomicJson(statePath(f.root, f.dataDir), scheduled)
    nextHost = createLocalHost(options)
    await nextHost.init()
    expect((await nextHost.getConversation(conversation.id)).summary.activeRunId).toBe(handle.id)
    replacement = new H5Server(nextHost, { dataDir: f.dataDir, host: '127.0.0.1', port: 0, updates: { ...updates, backendVersion: '9.9.9' } })
    await replacement.start(); replacement.updates.stop()
    expect((await readUpdateResume(f.dataDir))?.runs.map(run => run.status)).toEqual(['finished', 'resumed'])
    const resumed = (replacement as any).activeRuns.get(handle.id)
    expect(resumed).toBeTruthy()
    expect(await resumed.pendingInteractions()).toMatchObject([{ groupId: pending[0]!.groupId, items: [{ effectId: pending[0]!.items[0]!.effectId }] }])
    expect(await readFile(join(f.dataDir, 'conversations', conversation.id, 'runs', handle.id, 'model-budget.json'), 'utf8')).toBe(budget)
    await resumed.reply(pending[0]!.items[0]!.effectId, { approved: true })
    await resumed.outcome()
    expect(await readFile(join(f.root, 'retained.txt'), 'utf8')).toBe('one write')
    await (replacement as any).resumeUpdatedRuns()
    expect((replacement as any).activeRuns.size).toBeLessThanOrEqual(1)
    const snapshot = JSON.parse(await readFile(join(f.dataDir, 'conversations', conversation.id, 'runs', handle.id, 'runtime.json'), 'utf8')).state.state
    expect(snapshot.effects.filter(([, effect]: any) => effect.input?.name === 'fs.write')).toHaveLength(1)
  } finally { await replacement?.stop(); await nextHost?.close(); await server.stop(); await host.close(); await f.close(); await rm(f.root, { recursive: true, force: true }); vi.unstubAllGlobals() }
}, 30000)

it('freezes a running model/read effect without cancelling the agent or accepting late completions', async () => {
  const { PulseRuntime, defineLaneProgram } = await import('@hunterzhu/pulse-runtime')
  let running = false, aborted = false
  const program = defineLaneProgram({ id: 'restart-fixture', version: '1' }, b => {
    b.addStep('start', () => ({ actions: [{ type: 'submit_effects', effects: [{ key: 'read', kind: 'tool', concurrencyClass: 'tool', retrySafety: 'read_only', sideEffectPolicy: 'read', input: { name: 'read' } }], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'done' }))
    b.addStep('done', () => ({ actions: [{ type: 'complete', result: 'done' }], next: 'done' }))
  })
  const runtime = new PulseRuntime({ effectExecutor: async (_effect, signal) => { running = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })); return { value: 'late' } } })
  const { agentId } = runtime.createAgent('Read the original state', program)
  runtime.start(agentId)
  await vi.waitFor(() => expect(running).toBe(true))
  await runtime.checkpointForRestart(0)
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(aborted).toBe(true)
  expect(runtime.state.agents.get(agentId)?.state).toBe('running')
  expect([...runtime.state.effects.values()][0]?.outcome).toBeUndefined()
  const restored = new PulseRuntime({ persistence: runtime.exportPersistence(), programs: [program], effectExecutor: async () => ({ value: 'fresh read' }) })
  expect((await restored.start(agentId).outcome()).status).toBe('succeeded')
})

it('keeps incompatible or superseded interrupted work visible without starting it', async () => {
  const f = await updateFixture(), host = createLocalHost({ cwd: f.root, dataDir: f.dataDir, mockResponse: 'fixture', jarvis: { enabled: false } })
  const server = new H5Server(host, { dataDir: f.dataDir, host: '127.0.0.1', port: 0, updates: { root: f.root, development: true, backendVersion: '9.9.9' } })
  try {
    await server.start(); server.updates.stop()
    const conversation = await host.createConversation(), manifest = await (host as any).readManifest(conversation.id)
    manifest.activeRunId = 'missing-snapshot'; manifest.runs.push('missing-snapshot'); await (host as any).saveManifest(manifest)
    const metadata = await f.add('9.9.9', 'backend', {}), { releaseId } = await import('../packages/server/src/updates/contracts.js')
    const state = await readState(f.root, f.dataDir); state.active.backend = { directory: '/not-executed', manifest: metadata }
    await atomicJson(statePath(f.root, f.dataDir), state)
    const { saveUpdateResume } = await import('../packages/server/src/updates/resume.js')
    await saveUpdateResume(f.dataDir, { schema: 1, id: 'fixture', fromVersion: '0.11.2', toVersion: '9.9.9', targetBackend: releaseId(metadata), runs: [{ conversationId: conversation.id, runId: 'missing-snapshot', status: 'pending' }, { conversationId: conversation.id, runId: 'superseded', status: 'pending' }] })
    await (server as any).resumeUpdatedRuns()
    expect((await readUpdateResume(f.dataDir))?.runs).toMatchObject([{ status: 'blocked', error: 'RECOVERY_SNAPSHOT_MISSING' }, { status: 'finished' }])
    expect((server as any).activeRuns.size).toBe(0)
    expect((await host.getConversation(conversation.id)).summary.activeRunId).toBe('missing-snapshot')
  } finally { await server.stop(); await host.close(); await f.close(); await rm(f.root, { recursive: true, force: true }) }
})

it('joins an assistant launch before collecting update checkpoints and keeps later input queued', async () => {
  const f = await updateFixture(), host = createLocalHost({ cwd: f.root, dataDir: f.dataDir, mockResponse: 'fixture', jarvis: { enabled: false } })
  const server = new H5Server(host, { dataDir: f.dataDir, host: '127.0.0.1', port: 0, updates: { root: f.root, development: true, indexUrl: f.base + 'index.json', keys: f.keys } })
  let release!: () => void, end!: () => void
  const launching = new Promise<void>(resolve => { release = resolve }), streaming = new Promise<void>(resolve => { end = resolve })
  const checkpoint = vi.fn(async () => { end() })
  const send = vi.spyOn(host, 'sendMessage').mockImplementation(async (conversationId, options) => {
    await launching
    return { id: options.runId!, conversationId, checkpointForUpdate: checkpoint, isActive: () => true, events: (async function* () { await streaming })(), outcome: async () => ({ status: 'succeeded' }), cancel: async () => { end() } } as any
  })
  let saving: Promise<void> | undefined
  try {
    await f.add('9.9.9', 'backend', await serviceRuntime(join(f.root, 'launch-candidate'), '9.9.9')); f.index()
    const base = `http://127.0.0.1:${(await server.start()).port}`; server.updates.stop()
    await server.updates.check(); await server.updates.download()
    const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    for (const requestId of ['update-first', 'update-later']) {
      const response = await fetch(base + '/api/assistant/messages', { method: 'POST', headers: { Cookie: auth.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, text: 'fixture' }) })
      expect(response.status).toBe(202); await response.text()
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    ;(server as any).maintenance = true
    saving = (server as any).checkpointUpdateRuns(await readState(f.root, f.dataDir))
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(checkpoint).not.toHaveBeenCalled()
    release()
    await saving
    expect(checkpoint).toHaveBeenCalledOnce()
    expect((await readUpdateResume(f.dataDir))?.runs).toHaveLength(1)
    expect(send).toHaveBeenCalledOnce()
    expect((server as any).assistantInbox.list().find((message: any) => message.messageId === 'update-later').state).toBe('queued')
  } finally { release(); end(); await saving?.catch(() => undefined); await server.stop(); await host.close(); send.mockRestore(); await f.close(); await rm(f.root, { recursive: true, force: true }) }
})
