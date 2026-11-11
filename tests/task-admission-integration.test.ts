import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalHost, type RunHandle, type UserMessageInput } from '../packages/server/src/index.js'
import { HostTaskAdmissionStore } from '../packages/server/src/task-admission.js'
import { asChatWorkAgent } from '../packages/server/src/work-control.js'
import type { TaskAdmissionPermit } from '../packages/server/src/task-admission-run.js'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const roots: string[] = [], hosts: LocalHost[] = [], stores: HostTaskAdmissionStore[] = []
const outcomes: Array<ReturnType<typeof deferred<Awaited<ReturnType<RunHandle['outcome']>>>>> = []
const handles: RunHandle[] = []
afterEach(async () => {
  // Cancel queues before resolving running work, so cleanup cannot launch new work.
  await Promise.allSettled(handles.splice(0).map(run => run.cancel()))
  for (const result of outcomes.splice(0)) result.resolve({ status: 'cancelled', reason: 'TEST_CLEANUP' })
  await Promise.allSettled(hosts.splice(0).map(host => host.close()))
  await delay(120)
  for (const store of stores.splice(0)) { try { store.close() } catch {} }
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(maxRunning = 2) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-admission-integration-')); roots.push(root)
  const directory = join(root, 'host-admission')
  const options = { cwd: root, taskAdmissionDirectory: directory, taskAdmission: { maxRunning }, jarvis: { enabled: false } }
  const a = new LocalHost({ ...options, dataDir: join(root, 'a') }), b = new LocalHost({ ...options, dataDir: join(root, 'b') }); hosts.push(a, b)
  const store = new HostTaskAdmissionStore({ directory, maxRunning }); stores.push(store)
  return { root, directory, a, b, store }
}
function fake(id: string, conversationId: string) {
  const result = deferred<Awaited<ReturnType<RunHandle['outcome']>>>(); outcomes.push(result)
  const run: RunHandle = {
    id, conversationId, events: (async function* () {})(), outcome: () => result.promise,
    usage: vi.fn(), taskOutcome: async () => undefined, cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => { result.resolve({ status: 'cancelled', reason: 'SERVER_STOPPED' }) }),
    pendingInteractions: async () => [], reviewApproval: async () => ({ status: 'manual' }), reply: async () => {}, replyBatch: async () => {}, submitHumanInput: async () => {},
  }
  return { run, finish: result.resolve }
}
async function submit(host: LocalHost, store: HostTaskAdmissionStore, launch = vi.fn(), requestId?: string) {
  const conversation = await host.createConversation()
  let actual: ReturnType<typeof fake> | undefined
  const start = async (_input: UserMessageInput, permit: TaskAdmissionPermit) => {
    launch(); store.markRunning(permit.jobId, permit.ownerToken, { pid: process.pid })
    actual = fake(permit.runId, conversation.id); return actual.run
  }
  const input = { text: 'offline controlled task', ...(requestId ? { requestId } : {}) }
  const run = await host.scheduleTask(conversation.id, input, start); handles.push(run)
  return { run, conversation, input, start, actual: () => actual! }
}

describe('LocalHost host-wide admission integration (no model or worker)', () => {
  it('shares two running slots across separate data directories and queues six of eight tasks', async () => {
    const { a, b, store } = await fixture(); const launch = vi.fn()
    const submitted = []
    for (let i = 0; i < 8; i++) submitted.push(await submit(i % 2 ? b : a, store, launch))
    await delay(220)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(a.taskAdmissionSnapshot()).toMatchObject({ occupied: 2, queued: 6 })
    expect(b.taskAdmissionSnapshot()).toMatchObject({ occupied: 2, queued: 6 })
    expect(submitted.filter(item => item.run.admission?.().phase === 'queued')).toHaveLength(6)
  })
  it('never launches a cancelled queued request even when capacity becomes available', async () => {
    const { a, store } = await fixture(1)
    const first = await submit(a, store), launch = vi.fn(), queued = await submit(a, store, launch)
    await queued.run.cancel(); expect(await queued.run.outcome()).toMatchObject({ status: 'cancelled' })
    first.actual().finish({ status: 'succeeded' }); await first.run.outcome(); await delay(220)
    expect(launch).not.toHaveBeenCalled(); expect(store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
  })
  it('deduplicates request IDs without launching or recording a second task', async () => {
    const { a, store } = await fixture(); const launch = vi.fn()
    const one = await submit(a, store, launch, 'same-request')
    expect(await a.scheduleTask(one.conversation.id, one.input, one.start)).toBe(one.run)
    expect(launch).toHaveBeenCalledTimes(1); expect(store.list()).toHaveLength(1)
    await expect(a.scheduleTask(one.conversation.id, { ...one.input, text: 'different' }, one.start)).rejects.toThrow('REQUEST_ID_REUSED')
  })
  it('holds running cancellation capacity until the actual outcome settles', async () => {
    const { a, store } = await fixture(1); const first = await submit(a, store), launch = vi.fn()
    await submit(a, store, launch); await first.run.cancel(); await delay(220)
    expect(first.actual().run.cancel).toHaveBeenCalledTimes(1); expect(launch).not.toHaveBeenCalled()
    expect(store.snapshot()).toMatchObject({ occupied: 1, queued: 1 })
    expect(store.list().find(record => record.metadata?.runId === first.run.id)?.status).toBe('cancelling')
    first.actual().finish({ status: 'cancelled', reason: 'STOP_CONFIRMED' }); await first.run.outcome()
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
  })
  it('quarantines an unknown startup outcome without freeing capacity', async () => {
    const { a, store } = await fixture(1); const conversation = await a.createConversation()
    await expect(a.scheduleTask(conversation.id, { text: 'start', requestId: 'unknown' }, async () => { throw new Error('fork response lost') })).rejects.toThrow('fork response lost')
    const launch = vi.fn(); await submit(a, store, launch); await delay(220)
    expect(store.list().some(record => record.status === 'quarantined')).toBe(true)
    expect(store.snapshot()).toMatchObject({ occupied: 1, queued: 1 }); expect(launch).not.toHaveBeenCalled()
  })
  it('reopens persisted state and quarantines disappeared owners without retrying queued work', async () => {
    const { a, directory, store } = await fixture(1)
    for (const jobId of ['active', 'queued']) store.enqueue({ jobId, ownerToken: 'vanished', projectKey: 'p', conversationKey: jobId, metadata: { ownerPid: 2147483647 } })
    store.claim('active', 'vanished'); store.markRunning('active', 'vanished', { pid: 2147483647 }); store.close()
    const reopened = new HostTaskAdmissionStore({ directory, maxRunning: 1 }); stores.push(reopened)
    expect(reopened.get('active')?.status).toBe('running'); expect(reopened.get('queued')?.status).toBe('queued')
    expect(a.taskAdmissionSnapshot()).toMatchObject({ occupied: 1, queued: 0 })
    expect(reopened.get('active')?.status).toBe('quarantined'); expect(reopened.get('queued')?.status).toBe('interrupted')
    const launch = vi.fn(); await submit(a, reopened, launch); await delay(220)
    expect(launch).not.toHaveBeenCalled(); expect(reopened.get('queued')?.status).toBe('interrupted')
  })
  it('routes main chat outside saturated background slots without invoking a model', async () => {
    const { a, store } = await fixture(1); await submit(a, store)
    const chat = await a.createConversation(), control = fake('chat-run', chat.id)
    const admitted = vi.spyOn(a as unknown as { sendMessageAdmitted(id: string, input: UserMessageInput): Promise<RunHandle> }, 'sendMessageAdmitted').mockResolvedValue(control.run)
    expect(await a.sendMessage(chat.id, { text: 'main chat', assistantChat: true })).toBe(control.run)
    expect(admitted).toHaveBeenCalledTimes(1); expect(store.snapshot()).toMatchObject({ occupied: 1, queued: 0 })
  })
  it('does not dispatch a request whose message append overlaps shutdown', async () => {
    const { a, store } = await fixture(1)
    await submit(a, store)
    const conversation = await a.createConversation()
    const entered = deferred<void>(), unblock = deferred<void>(), launch = vi.fn()
    const internal = a as unknown as { appendMessage(id: string, message: unknown): Promise<void> }
    const append = internal.appendMessage.bind(a)
    vi.spyOn(internal, 'appendMessage').mockImplementation(async (id, message) => {
      entered.resolve(); await unblock.promise; await append(id, message)
    })
    const scheduled = a.scheduleTask(conversation.id, { text: 'shutdown race', requestId: 'race' }, async (_input, permit) => {
      launch(); return fake(permit.runId, conversation.id).run
    })
    const rejected = expect(scheduled).rejects.toThrow('HOST_TASK_ADMISSION_CLOSED')
    await entered.promise
    const closed = a.close()
    unblock.resolve()
    await rejected; await closed; await delay(150)
    expect(launch).not.toHaveBeenCalled()
    expect(store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
    expect(store.list()[0]?.status).toBe('cancelled')
  })

  it('does not release capacity while startup cancellation awaits a worker outcome', async () => {
    const { a, store } = await fixture(1)
    const first = await submit(a, store), conversation = await a.createConversation()
    const entered = deferred<void>(), unblock = deferred<void>()
    let worker: ReturnType<typeof fake> | undefined
    const queued = await a.scheduleTask(conversation.id, { text: 'delayed startup' }, async (_input, permit) => {
      worker = fake(permit.runId, conversation.id); entered.resolve(); await unblock.promise; return worker.run
    }); handles.push(queued)
    first.actual().finish({ status: 'succeeded' }); await first.run.outcome(); await entered.promise
    const launch = vi.fn(); await submit(a, store, launch)
    const cancelled = queued.cancel(); unblock.resolve(); await cancelled; await delay(150)
    expect(store.snapshot()).toMatchObject({ occupied: 1, queued: 1 }); expect(launch).not.toHaveBeenCalled()
    expect(worker!.run.cancel).toHaveBeenCalled()
    worker!.finish({ status: 'cancelled', reason: 'STOP_CONFIRMED' }); await queued.outcome()
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
  })

  it('removes an unlaunched queue item after its message write fails', async () => {
    const { a, store } = await fixture(1)
    const first = await submit(a, store), conversation = await a.createConversation(), launch = vi.fn()
    const internal = a as unknown as { appendMessage(id: string, message: unknown): Promise<void> }
    vi.spyOn(internal, 'appendMessage').mockRejectedValueOnce(new Error('SIMULATED_STORAGE_FAILURE'))
    await expect(a.scheduleTask(conversation.id, { text: 'not accepted', requestId: 'failed-append' }, async () => { launch(); throw new Error('MUST_NOT_LAUNCH') })).rejects.toThrow('SIMULATED_STORAGE_FAILURE')
    expect(store.snapshot().queued).toBe(0)
    expect(launch).not.toHaveBeenCalled()
    const later = vi.fn(); await submit(a, store, later)
    first.actual().finish({ status: 'succeeded' }); await first.run.outcome()
    await vi.waitFor(() => expect(later).toHaveBeenCalledTimes(1))
  })

  it('cancels assistant-owned queued work during system shutdown without granting user control', async () => {
    const { a, store } = await fixture(1); await submit(a, store)
    const assistant = await a.createConversation(), work = await a.createConversation({ origin: 'assistant' })
    await a.conversationData.call('initializeWorkControl', work.id, assistant.id)
    const launch = vi.fn()
    const queued = await asChatWorkAgent(a.conversationData, work.id, () => a.scheduleTask(work.id, { text: 'assistant-owned queued task' }, async (_input, permit) => { launch(); return fake(permit.runId, work.id).run }))
    handles.push(queued)
    await expect(queued.cancel()).rejects.toThrow('WORK_CONTROL_REQUIRED')
    await a.close()
    expect(await queued.outcome()).toMatchObject({ status: 'cancelled' })
    expect(launch).not.toHaveBeenCalled()
    expect(store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
  })

  it('does not dispatch queued work during host shutdown', async () => {
    const { a, store } = await fixture(1); await submit(a, store); const launch = vi.fn(), queued = await submit(a, store, launch)
    await a.close(); expect(await queued.run.outcome()).toMatchObject({ status: 'cancelled' }); await delay(220)
    expect(launch).not.toHaveBeenCalled(); expect(store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
  })
})
