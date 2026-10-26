import { describe, it, expect, vi } from 'vitest'
import { CliNotificationBridge, withCliNotifications } from '../packages/cli/src/utils/notification-bridge.js'
import { CliNotificationReader } from '../packages/server/src/h5/cli-notifications.js'
import { TaskNoticeInbox } from '../packages/server/src/h5/notifications.js'
import { H5Server } from '../packages/server/src/h5/server.js'
import type { LocalHost, RunHandle } from '../packages/server/src/index.js'

function fixture() {
  const values = new Map<string, any>(), changes: Array<{ seq: number; kind: string; item: string }> = []
  let time = 100_000
  const runId = 'run-cli12345678', conversationId = 'conv-cli12345678'
  const group = { groupId: 'group-original', kind: 'ask' as const, items: [{ effectId: 'effect-original', input: { kind: 'ask', type: 'input', prompt: 'CLI question' } }] }
  let groups: any[] = [group]
  const call = vi.fn(async (method: string, ...args: any[]) => {
    if (method === 'readState') return structuredClone(values.get(args[0]))
    if (method === 'saveState') { values.set(args[0], structuredClone(args[1])); changes.push({ seq: changes.length + 1, kind: 'state', item: args[0] }); return }
    if (method === 'list') return [{ id: conversationId, updatedAt: '2026-10-25', runs: [runId], activeRunId: runId }]
    if (method === 'changes') return { reset: false, revision: changes.length, items: changes.filter(item => item.seq > args[0]) }
    throw new Error('Unexpected store method: ' + method)
  })
  const store = { call } as LocalHost['conversationData']
  const run = { id: runId, conversationId, pendingInteractions: vi.fn(async () => structuredClone(groups)), replyBatch: vi.fn(async () => { groups = [] }), cancel: vi.fn(async () => { groups = [] }) } as unknown as RunHandle
  const pending = vi.fn()
  const producer = new CliNotificationBridge(store, run, pending, () => time)
  const reader = new CliNotificationReader(store, () => time, async ms => { time += ms; await producer.tick() })
  const command = { requestId: 'notification_original', runId, conversationId, method: 'reply' as const, groupId: group.groupId, answers: [{ effectId: group.items[0]!.effectId, value: { text: 'answer' } }] }
  return { producer, reader, store, values, run, group, command, pending, now: () => time, advance: (ms: number) => { time += ms }, groups: (value: any[]) => { groups = value } }
}

describe('CLI notification bridge without a server or socket', () => {
  it('projects CLI waits into the existing H5 inbox and snapshot without changing ordinary H5 runs', async () => {
    const f = fixture(); await f.producer.tick()
    const host = { conversationData: f.store, setAssistantWorkTools: vi.fn() } as unknown as LocalHost
    // Construct the adapters only: never start/listen on the HTTP server.
    const server = new H5Server(host, { dataDir: '/tmp/pulse-unused-cli-notice-test' }) as any
    server.cliNotices = f.reader
    server.assistantInbox = { conversationId: 'assistant' }
    server.finishStream = vi.fn()
    await server.syncCliNotifications()
    expect((await server.taskNotices.list())[0]).toMatchObject({ runId: f.run.id, kind: 'ask', groupId: f.group.groupId })
    const snapshot = await server.snapshotRun(f.run.id, [], false)
    expect(snapshot.state).toBe('running')
    expect(snapshot.interactions[0].items[0].input.prompt).toBe('CLI question')
    server.runEventBuffers.set('run-h5-original', [])
    server.pushEvent('run-h5-original', { type: 'interactions', runId: 'run-h5-original', conversationId: 'conv-h5-original', seq: 1, data: { interactions: [f.group] } })
    expect((await server.snapshotRun('run-h5-original', [], true)).interactions[0].groupId).toBe(f.group.groupId)
    // A normal H5 run remains active while its independent CLI neighbour ends.
    server.activeRuns.set('run-h5-original', {})
    await f.producer.event({ schemaVersion: 1, type: 'complete', runId: f.run.id, conversationId: f.run.conversationId, seq: 2, data: { status: 'cancelled' } })
    await server.syncCliNotifications()
    expect((await server.taskNotices.list()).map((item: any) => [item.runId, item.kind])).toEqual([['run-h5-original', 'ask'], [f.run.id, 'complete']])
    expect(server.finishStream).toHaveBeenCalledWith(f.run.id)
  })
  it('discovers an independent CLI wait and completion through the shared data service and restores after H5 restart', async () => {
    const f = fixture(); await f.producer.tick()
    const pending = await f.reader.sync()
    expect(pending[0]?.snapshot.interactions?.[0]?.groupId).toBe(f.group.groupId)
    expect((await new CliNotificationReader(f.store, f.now).sync())[0]?.snapshot.state).toBe('running')
    expect(await f.reader.sync()).toEqual([])
    let notices: any[] = []
    const inbox = new TaskNoticeInbox(async () => notices, async value => { notices = value })
    await inbox.record({ type: 'interactions', runId: f.run.id, conversationId: f.run.conversationId, seq: 1, data: { interactions: pending[0]!.snapshot.interactions! } })
    await f.producer.event({ schemaVersion: 1, type: 'complete', conversationId: f.run.conversationId, runId: f.run.id, seq: 2, data: { status: 'succeeded' } })
    const completed = await f.reader.sync()
    expect(completed[0]?.snapshot.state).toBe('succeeded')
    await inbox.record(completed[0]!.snapshot.complete!)
    expect((await inbox.list()).map(item => item.kind)).toEqual(['complete'])
    expect((await new CliNotificationReader(f.store).sync())[0]?.snapshot.state).toBe('succeeded')
  })
  it('binds single-question replies to the original CLI run, group and effect and deduplicates concurrent retries', async () => {
    const f = fixture(); await f.producer.tick()
    await Promise.all([f.reader.request(f.command), f.reader.request(f.command)])
    expect(f.run.replyBatch).toHaveBeenCalledTimes(1)
    expect(f.run.replyBatch).toHaveBeenCalledWith(f.group.groupId, f.command.answers)
    expect((await f.reader.snapshot(f.run.id))?.snapshot.interactions).toEqual([])
    expect(f.pending).toHaveBeenLastCalledWith(new Set())
    const restarted = new CliNotificationReader(f.store)
    await restarted.request(f.command)
    expect(f.run.replyBatch).toHaveBeenCalledTimes(1)
    await expect(restarted.request({ ...f.command, answers: [{ effectId: 'effect-original', value: { text: 'different' } }] })).rejects.toThrow('REQUEST_ID_REUSED')
  })
  it('clears stale CLI pending without recording completion and restores it when heartbeats recover', async () => {
    const f = fixture(); await f.producer.tick()
    const server = new H5Server({ conversationData: f.store, setAssistantWorkTools: vi.fn() } as unknown as LocalHost, { dataDir: '/tmp/pulse-unused-cli-notice-test' }) as any
    server.cliNotices = f.reader; server.assistantInbox = { conversationId: 'assistant' }; server.finishStream = vi.fn()
    await server.syncCliNotifications()
    f.advance(16_000); await server.syncCliNotifications()
    expect(await server.taskNotices.list()).toEqual([])
    expect((await server.snapshotRun(f.run.id, [], false)).state).toBe('interrupted')
    await f.producer.tick(); await server.syncCliNotifications()
    expect((await server.taskNotices.list()).map((item: any) => item.kind)).toEqual(['ask'])
    expect(server.finishStream).not.toHaveBeenCalled()
  })
  it('keeps heartbeats moving after a reused reply id and during a slow reply', async () => {
    const f = fixture(); await f.producer.tick(); await f.reader.request(f.command)
    const before = f.values.get(`cli-notice:${f.run.id}`).updatedAt
    await f.store.call('saveState', `cli-notice-command:${f.run.id}`, { ...f.command, answers: [{ effectId: 'effect-original', value: { text: 'different' } }] })
    f.advance(2_000); await f.producer.tick()
    expect(f.values.get(`cli-notice-result:${f.run.id}`).error).toBe('REQUEST_ID_REUSED')
    const reused = f.values.get(`cli-notice:${f.run.id}`)
    expect(reused.snapshot.state).toBe('running')
    expect(reused.updatedAt).toBeGreaterThan(before)
    f.groups([f.group])
    let release!: () => void
    const started = new Promise<void>(resolve => { f.run.replyBatch.mockImplementationOnce(async () => { resolve(); await new Promise<void>(done => { release = done }) }) })
    await f.store.call('saveState', `cli-notice-command:${f.run.id}`, { ...f.command, requestId: 'notification_slow_retry' })
    const tick = f.producer.tick()
    await started
    f.advance(2_000); await f.producer.heartbeat()
    expect(f.values.get(`cli-notice:${f.run.id}`).snapshot.state).toBe('running')
    expect(f.values.get(`cli-notice:${f.run.id}`).updatedAt).toBe(f.now())
    release(); await tick
    expect(f.run.replyBatch).toHaveBeenCalledTimes(2)
  })
  it('retires the CLI snapshot after H5 resumes the run, retaining its terminal state across restart', async () => {
    const f = fixture(); await f.producer.tick(); await f.producer.close()
    const host = { conversationData: f.store, setAssistantWorkTools: vi.fn(), prepareAutomation: vi.fn(async () => {}), getTransferBinding: vi.fn(async () => undefined), resumeRun: vi.fn(async () => f.run) } as unknown as LocalHost
    const create = () => {
      const server = new H5Server(host, { dataDir: '/tmp/pulse-unused-cli-takeover' }) as any
      server.cliNotices = new CliNotificationReader(f.store, f.now)
      server.assistantInbox = { conversationId: 'assistant' }
      server.consumeRun = vi.fn()
      return server
    }
    const server = create()
    // Retain a batch fetched before the handover, then apply it afterwards.
    const staleBatch = await server.cliNotices.sync()
    await server.resumeConversationRun(f.run.conversationId)
    expect(await server.cliNotices.snapshot(f.run.id)).toBeUndefined()
    const old = f.values.get(`cli-notice:${f.run.id}`)
    expect(old).toMatchObject({ supersededBy: 'h5', snapshot: { state: 'interrupted' } })
    server.pushEvent(f.run.id, { type: 'complete', runId: f.run.id, conversationId: f.run.conversationId, seq: 100, data: { status: 'succeeded' } })
    server.activeRuns.delete(f.run.id)
    vi.spyOn(server.cliNotices, 'sync').mockResolvedValueOnce(staleBatch)
    await server.syncCliNotifications()
    expect(await server.snapshotRun(f.run.id, [], false)).toMatchObject({ state: 'succeeded', seq: 100 })
    await server.projectionWrites.get(f.run.id)
    const restarted = create()
    await restarted.syncCliNotifications()
    expect(await restarted.snapshotRun(f.run.id, [], false)).toMatchObject({ state: 'succeeded', seq: 100 })
    server.inhibitor.dispose(); restarted.inhibitor.dispose()
    // A subsequent real CLI owner publishes a fresh record, rather than
    // inheriting the tombstone or the old reader's deduplication entry.
    const next = new CliNotificationBridge(f.store, f.run, undefined, f.now)
    await next.tick()
    expect((await restarted.cliNotices.sync())[0]?.snapshot.state).toBe('running')
    await next.close()
  })
  it.each(['answered', 'replaced', 'cancelled', 'offline'] as const)('rejects %s replies before touching the CLI effect', async state => {
    const f = fixture(); await f.producer.tick()
    if (state === 'answered') { f.groups([]); f.advance(2000); await f.producer.tick() }
    if (state === 'replaced') { f.groups([{ ...f.group, items: [{ effectId: 'replacement', input: { kind: 'ask', type: 'input' } }] }]); await f.producer.tick() }
    if (state === 'cancelled') await f.producer.event({ schemaVersion: 1, type: 'complete', conversationId: f.run.conversationId, runId: f.run.id, seq: 2, data: { status: 'cancelled' } })
    if (state === 'offline') f.advance(16_000)
    await expect(f.reader.request(f.command)).rejects.toThrow(/INTERACTION_GROUP_MISMATCH|RUN_NOT_ACTIVE/)
    expect(f.run.replyBatch).not.toHaveBeenCalled()
  })
  it('revalidates the group in the owning CLI when it changes after the H5 snapshot', async () => {
    const f = fixture(); await f.producer.tick(); f.groups([])
    await expect(f.reader.request(f.command)).rejects.toThrow('INTERACTION_GROUP_MISMATCH')
    expect(f.run.replyBatch).not.toHaveBeenCalled()
  })
  it('expires unprocessed commands and deduplicates cancellation', async () => {
    const f = fixture(); await f.producer.tick()
    await f.store.call('saveState', `cli-notice-command:${f.run.id}`, { ...f.command, expiresAt: 1 })
    await f.producer.tick()
    expect(f.values.get(`cli-notice-result:${f.run.id}`).error).toBe('QUESTION_EXPIRED')
    expect(f.run.replyBatch).not.toHaveBeenCalled()
    const cancel = { requestId: 'cancel_original', runId: f.run.id, conversationId: f.run.conversationId, method: 'cancel' as const }
    await f.reader.request(cancel); await f.reader.request(cancel)
    expect(f.run.cancel).toHaveBeenCalledTimes(1)
  })
  it('preserves multi-question and choice groups for the existing H5 batch UI', async () => {
    const f = fixture()
    const items = ['one', 'two'].map(effectId => ({ effectId, input: { kind: 'ask', type: 'choice', options: ['a', 'b'] } }))
    f.groups([{ ...f.group, items }]); await f.producer.tick()
    expect((await f.reader.snapshot(f.run.id))?.snapshot.interactions?.[0]?.items).toEqual(items)
    await f.reader.request({ ...f.command, answers: items.map(item => ({ effectId: item.effectId, value: { value: 'a' } })) })
    expect(f.run.replyBatch).toHaveBeenCalledWith(f.group.groupId, items.map(item => ({ effectId: item.effectId, value: { value: 'a' } })))
    await f.reader.request({ ...f.command, answers: [...items].reverse().map(item => ({ effectId: item.effectId, value: { value: 'a' } })) })
    expect(f.run.replyBatch).toHaveBeenCalledTimes(1)
  })
  it('wraps the ordinary CLI event stream and persists completion without consuming it twice', async () => {
    const f = fixture()
    const complete = { schemaVersion: 1 as const, type: 'complete' as const, conversationId: f.run.conversationId, runId: f.run.id, seq: 2, data: { status: 'succeeded' } }
    const wrapped = await withCliNotifications({ conversationData: f.store } as LocalHost, { ...f.run, events: (async function* () { yield complete })() })
    const events = []; for await (const event of wrapped.events) events.push(event)
    expect(events).toEqual([complete])
    expect(f.values.get(`cli-notice:${f.run.id}`).snapshot.state).toBe('succeeded')
  })
})
