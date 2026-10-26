import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { TaskNoticeInbox } from '../packages/server/src/h5/notifications.js'
import { TaskNotifications } from '../packages/desktop/src/task-notifications.mjs'
import { isOwnedService, restoreOwnedService, cliShellCommand, cliWindowsScript, serviceMonitorAction } from '../packages/desktop/src/background-service.mjs'

class Notice extends EventEmitter {
  static instances: Notice[] = []
  static isSupported() { return true }
  constructor(public options: any) { super(); Notice.instances.push(this) }
  show() {} close() {}
}
const item = { id: 'interaction:run-12345678:group', runId: 'run-12345678', conversationId: 'conv-12345678', kind: 'ask', groupId: 'group' }
const group = { groupId: 'group', kind: 'ask', items: [{ effectId: 'effect-1', input: { type: 'input' } }] }
function setup() {
  Notice.instances = []
  let feed: any[] = [], snapshot: any = { state: 'running', interactions: [group] }
  const request = vi.fn(async (path: string, init?: any) => path === '/api/notifications' ? feed : path.endsWith('/state') ? snapshot : { ok: true })
  const open = vi.fn(), save = vi.fn(async () => {})
  const controller = new TaskNotifications({ Notification: Notice, request, open, load: async () => [], save, platform: 'darwin' })
  return { controller, request, open, save, feed: (value: any[]) => { feed = value }, snapshot: (value: any) => { snapshot = value } }
}
describe('task notification lifecycle', () => {
  it('retains live pending across 200 history entries and restores the legacy array format', async () => {
    let saved: any[] = [{ ...item, createdAt: 1 }]
    const inbox = new TaskNoticeInbox(async () => structuredClone(saved), async value => { saved = structuredClone(value) }, async () => true)
    for (let index = 0; index < 205; index++) await inbox.record({ type: 'complete', runId: `other-${index}`, conversationId: 'c', seq: 1, data: { status: 'succeeded' } })
    const restored = await new TaskNoticeInbox(async () => saved, async value => { saved = value }, async () => true).list()
    expect(restored.filter(item => item.kind === 'complete')).toHaveLength(200)
    expect(restored.find(notice => notice.id === item.id)).toBeTruthy()
  })
  it('clears answered groups, deduplicates cancellation and reconciles interrupted runs after restart', async () => {
    let saved: any[] = []
    const inbox = new TaskNoticeInbox(async () => saved, async value => { saved = value })
    const event = { type: 'interactions' as const, runId: item.runId, conversationId: item.conversationId, seq: 1, data: { interactions: [group] } }
    await inbox.record(event); await inbox.record({ ...event, data: { interactions: [] } }); await inbox.record({ ...event, data: { interactions: [] } })
    expect(await inbox.list()).toEqual([])
    await inbox.record(event)
    const cancelled = { ...event, type: 'complete' as const, data: { status: 'cancelled' as const } }
    await inbox.record(cancelled); await inbox.record(cancelled)
    expect((await inbox.list()).map(item => item.kind)).toEqual(['complete'])
    saved = [{ ...item, createdAt: 1 }]
    const restored = new TaskNoticeInbox(async () => saved, async value => { saved = value }, async () => false)
    expect(await restored.list()).toEqual([])
    expect(saved).toEqual([])
  })
  it('serializes and deduplicates durable events and can be restored', async () => {
    let saved: any[] = []
    const read = async () => structuredClone(saved), write = async (value: any[]) => { saved = structuredClone(value) }
    const inbox = new TaskNoticeInbox(read, write)
    const event = { type: 'complete' as const, runId: 'r', conversationId: 'c', seq: 1, data: { status: 'succeeded' as const } }
    await Promise.all([inbox.record(event), inbox.record(event), inbox.record({ ...event, runId: 'r2' })])
    expect((await new TaskNoticeInbox(read, write).list()).map(item => item.id)).toEqual(['complete:r', 'complete:r2'])
  })
  it('baselines old completions and notifies new completions once', async () => {
    const t = setup(); t.feed([{ ...item, id: 'complete:old', kind: 'complete' }]); await t.controller.sync()
    expect(Notice.instances).toHaveLength(0)
    t.feed([{ ...item, id: 'complete:new', kind: 'complete' }]); await t.controller.sync(); await t.controller.sync()
    expect(Notice.instances).toHaveLength(1)
  })
  it('binds text replies to the original group and effect, never the open conversation', async () => {
    const t = setup(); t.feed([item]); await t.controller.sync()
    expect(Notice.instances[0]!.options.hasReply).toBe(true)
    await t.controller.reply({ ...item, group }, 'My answer')
    const sent = t.request.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(sent[1].body)).toMatchObject({ conversationId: item.conversationId, groupId: 'group', answers: [{ effectId: 'effect-1', value: { text: 'My answer' } }] })
  })
  it('keeps approval and stale questions out of inline replies; dismissal sends nothing', async () => {
    const t = setup(); t.feed([{ ...item, kind: 'approval' }]); t.snapshot({ state: 'running', interactions: [{ ...group, kind: 'approval' }] }); await t.controller.sync()
    expect(Notice.instances[0]!.options.hasReply).toBe(false)
    Notice.instances[0]!.emit('close'); expect(t.request.mock.calls.some(([, init]) => init)).toBe(false)
    t.snapshot({ state: 'succeeded', interactions: [] })
    await expect(t.controller.reply({ ...item, group }, 'late answer')).rejects.toThrow('QUESTION_EXPIRED')
    expect(t.request.mock.calls.some(([, init]) => init)).toBe(false)
  })
  it('keeps inbox pending when native notification delivery fails', async () => {
    const t = setup(); t.feed([item]); await t.controller.sync()
    Notice.instances[0]!.emit('failed', {}, 'permission denied')
    expect(t.controller.disabled).toBe(true)
    expect(t.controller.deliveryError).toBe('permission denied')
    expect(t.controller.pending.size).toBe(1)
    expect(t.request.mock.calls.some(([, init]) => init)).toBe(false)
    await vi.waitFor(() => expect(t.save.mock.calls.at(-1)?.[0]?.some((id: string) => id.startsWith(item.id))).toBe(false))
  })
  it('restores ownership across tray restart only for the authenticated service instance', () => {
    const descriptor = { protocol: 1, pid: 2, instanceId: 'instance-a' }, saved = { pid: 2, launchedPid: 2, instanceId: 'instance-a' }
    expect(restoreOwnedService(descriptor, saved, 2, 'instance-a')).toBe(2)
    expect(restoreOwnedService({ ...descriptor, instanceId: 'instance-b' }, saved, 2, 'instance-b')).toBeUndefined()
    expect(restoreOwnedService(descriptor, undefined, 2, 'instance-a')).toBeUndefined()
  })
  it('does not claim externally launched services and quotes CLI paths', () => {
    expect(isOwnedService({ protocol: 1, pid: 2 }, undefined, 2)).toBe(false)
    expect(isOwnedService({ protocol: 1, pid: 2, supervisorPid: 1 }, 1, 2)).toBe(true)
    expect(isOwnedService({ protocol: 1, pid: 3, supervisorPid: 1 }, 1, 2)).toBe(false)
    expect(cliShellCommand('/my node', '/my cli', { PULSE_DATA_DIR: '/my data' })).toContain("PULSE_DATA_DIR='/my data'")
    const script = cliWindowsScript('C:\\Program Files\\node.exe', 'C:\\pulse\\cli.js', { PULSE_HOME: 'C:\\pulse', PULSE_DATA_DIR: 'C:\\my data', PULSE_CONFIG: 'C:\\cfg' })
    expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(script).toContain('set "PULSE_DATA_DIR=C:\\my data"')
    expect(script).toContain('set "PULSE_HOME=C:\\pulse"')
    expect(script).toContain('set "PULSE_CONFIG=C:\\cfg"')
    expect(script).toContain('"C:\\Program Files\\node.exe" "C:\\pulse\\cli.js"')
    expect(serviceMonitorAction({ stoppedByUser: true, setupPending: false, base: '' })).toBe('wait')
    expect(serviceMonitorAction({ stoppedByUser: false, setupPending: true, base: 'http://127.0.0.1' })).toBe('wait')
    expect(serviceMonitorAction({ stoppedByUser: false, setupPending: false, base: '' })).toBe('reconnect')
    expect(serviceMonitorAction({ stoppedByUser: false, setupPending: false, base: 'http://127.0.0.1' })).toBe('probe')
  })
})
