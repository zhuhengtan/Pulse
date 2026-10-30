import { describe, expect, it } from 'vitest'
import { humanRunPresentation, presentRun, publicShellProcessPreview, runCompletion, shellProcessPending } from '../packages/server/src/run-presentation.js'
import { H5Server } from '../packages/server/src/h5/server.js'
import { CliNotificationBridge } from '../packages/cli/src/utils/notification-bridge.js'

describe('shared execution and acceptance presentation', () => {
  it('never treats runtime success or an old missing result as accepted', () => {
    expect(presentRun({ state: 'succeeded' }).state).toBe('unverifiable')
    expect(presentRun({ state: 'succeeded', completion: { status: 'succeeded', taskRequired: true } }).state).toBe('unverifiable')
    expect(presentRun({ state: 'succeeded', completion: { status: 'succeeded', taskOutcome: { status: 'unverifiable' } } }).label).toBe('任务结果无法核验')
    expect(presentRun({ state: 'succeeded', completion: { status: 'succeeded', taskRequired: false } }).state).toBe('finished')
    expect(presentRun({ state: 'failed', completion: { status: 'failed', taskOutcome: { status: 'accepted' } } }).state).toBe('failed')
  })
  it('keeps each wait and interruption distinct from connection and acceptance', () => {
    expect(['input','approval','process'].map(waiting => presentRun({ state: 'running', waiting: waiting as 'input' | 'approval' | 'process' }).state)).toEqual(['waiting-input','waiting-approval','waiting-process'])
    expect(presentRun({ state: 'interrupted' }).terminal).toBe(false)
  })
  it('keeps acceptance through the actual H5 projector, saved snapshot and reopened history', async () => {
    const saved = new Map<string, unknown>()
    const host = { setAssistantWorkTools() {}, conversationData: { call: async (method: string, key: string, value?: unknown) => method === 'saveState' ? saved.set(key, structuredClone(value)) : saved.get(key) } }
    const server = new H5Server(host as never, { dataDir: '/tmp/pulse-presentation-unused' }) as any
    server.assistantInbox = { conversationId: 'assistant' }
    server.runEventBuffers.set('r', [])
    await server.publish('r', { schemaVersion: 1, type: 'complete', conversationId: 'c', runId: 'r', seq: 1, data: { status: 'succeeded', taskRequired: true, taskOutcome: { status: 'incomplete', note: 'private' } } })
    const live = await server.snapshotRun('r', [], false)
    expect(live.complete.data).toEqual({ status: 'succeeded', taskRequired: true, taskOutcome: { status: 'incomplete' } })
    const reopened = new H5Server(host as never, { dataDir: '/tmp/pulse-presentation-unused' }) as any
    expect((await reopened.snapshotRun('r', [], false)).complete.data).toEqual(live.complete.data)
    expect(presentRun({ state: live.state, completion: live.complete.data }).state).toBe('incomplete')
  })
  it('preserves only public allowlisted acceptance fields through the persisted CLI mailbox', async () => {
    const states = new Map<string, unknown>()
    const store = { call: async (method: string, key: string, value?: unknown) => method === 'readState' ? states.get(key) : states.set(key,value) }
    const run = { id: 'run', conversationId: 'conv', pendingInteractions: async () => [] }
    const bridge = new CliNotificationBridge(store as never, run as never)
    await bridge.event({ schemaVersion: 1, type: 'complete', conversationId: 'conv', runId: 'run', seq: 9, data: { status: 'succeeded', taskRequired: true, taskOutcome: { status: 'incomplete', note: 'private', criteria: ['private'] } } })
    const wire = states.get('cli-notice:run') as { snapshot: { complete: { data: unknown } } }
    expect(wire.snapshot.complete.data).toEqual({ status: 'succeeded', taskRequired: true, taskOutcome: { status: 'incomplete' } })
    expect(runCompletion({ status: 'succeeded', taskOutcome: { status: 'fake-accepted' } }).taskOutcome).toBeUndefined()
  })
  it('keeps a succeeded shell handle pending only while the process itself is running', () => {
    expect(shellProcessPending('shell.poll', 'succeeded', { status: 'running' })).toBe(true)
    expect(shellProcessPending('shell.start', 'running', undefined)).toBe(true)
    expect(shellProcessPending('shell.poll', 'succeeded', { status: 'exited' })).toBe(false)
    expect(shellProcessPending('shell.poll', 'succeeded', { status: 'unknown' })).toBe(false)
    expect(shellProcessPending('fs.read', 'running', { status: 'running' })).toBe(false)
    const preview = publicShellProcessPreview({ status: 'running', output: 'partial', processId: 'secret', command: 'rm -rf' })
    expect(preview).toEqual({ status: 'running', output: 'partial' })
    expect(preview).not.toHaveProperty('processId')
    expect(humanRunPresentation({ status: 'failed' }, { status: 'accepted' }).label).toBe('任务执行失败')
    expect(humanRunPresentation({ status: 'succeeded' }, null).label).toBe('回复完成')
    expect(humanRunPresentation({ status: 'succeeded' }, { status: 'incomplete' }).label).toBe('任务未完成')
  })
})
