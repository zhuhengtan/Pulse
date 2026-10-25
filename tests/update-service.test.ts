import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ConversationData } from '../packages/data/src/index.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { ScheduledTaskStore, ScheduledTaskWorker } from '../packages/server/src/scheduled-tasks.js'
import { UpdateManager } from '../packages/server/src/updates/manager.js'
import { supervise } from '../packages/server/src/updates/coordinator.js'
import { atomicJson, readState, statePath } from '../packages/server/src/updates/store.js'
import { serviceRuntime, updateFixture } from './update-fixtures.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); vi.unstubAllEnvs() })
async function waitFor<T>(work: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000
  while (true) { try { const value = await work(); if (predicate(value)) return value } catch {} if (Date.now() > deadline) throw new Error('UPDATE_TEST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 50)) }
}
async function fixture() { const f = await updateFixture(); cleanup.push(async () => { await f.close(); await rm(f.root, { recursive: true, force: true }) }); return f }

describe('update service admission', () => {
  it('defers schedules during maintenance without consuming their due execution', async () => {
    const f = await fixture(); let now = 1000
    const store = new ScheduledTaskStore(join(f.dataDir, 'scheduled-tasks.json'), { now: () => now })
    const task = await store.create({ name: 'due', workspace: f.root, instruction: 'test', intervalMs: 1000 }); now = 3000
    await atomicJson(join(f.dataDir, '.update-maintenance.json'), { pid: process.pid, token: randomUUID() })
    const execute = vi.fn(async () => {})
    expect(await new ScheduledTaskWorker(store, execute).runOnce()).toMatchObject({ claimed: 0, failed: 0 })
    expect(execute).not.toHaveBeenCalled()
    await rm(join(f.dataDir, '.update-maintenance.json'))
    const retry = new ScheduledTaskWorker(store, async () => { throw new Error('SERVICE_UPDATING') })
    expect(await retry.runOnce()).toMatchObject({ claimed: 0, failed: 0 })
    expect(await store.get(task.id)).toMatchObject({ runCount: 0 })
    expect(await new ScheduledTaskWorker(store, execute).runOnce()).toMatchObject({ claimed: 1, succeeded: 1 })
  })
  it('protects modification routes and exposes only frontend notices to paired H5 clients', async () => {
    const f = await fixture()
    const host = createLocalHost({ cwd: f.root, dataDir: f.dataDir, provider: { provider: 'mock', defaultModel: 'mock' }, jarvis: { enabled: false } })
    const server = new H5Server(host, { dataDir: f.dataDir, port: 0, host: '127.0.0.1', updates: { root: f.root, development: true, indexUrl: f.base + 'index.json', keys: f.keys } })
    await host.init(); const started = await server.start(); server.updates.stop()
    cleanup.push(async () => { await server.stop(); await host.close() })
    const base = `http://127.0.0.1:${started.port}`
    const auth = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } }), cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    expect((await fetch(base + '/api/updates/check', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403)
    const qr = await (await fetch(base + '/api/pair/qr')).json() as { code: string }
    const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: qr.code, name: 'test-phone' }) }), phoneCookie = paired.headers.get('set-cookie')!.split(';')[0]!
    const view = await (await fetch(base + '/api/updates', { headers: { Cookie: phoneCookie } })).json()
    expect(view).toMatchObject({ frontend: 'bundled' }); expect(view.running).toBeUndefined(); expect(view.available).toBeUndefined()
    expect((await fetch(base + '/api/updates/check', { method: 'POST', headers: { Cookie: phoneCookie, Origin: base } })).status).toBe(403)
    ;(server as any).maintenance = true
    expect((await fetch(base + '/api/conversations', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(503)
    expect((await fetch(base + '/api/updates', { headers: { Cookie: cookie } })).status).toBe(200)
  })
  it('waits for starting tasks, HTTP requests, terminal sessions and other data clients', async () => {
    const f = await fixture(), host = createLocalHost({ cwd: f.root, dataDir: f.dataDir, provider: { provider: 'mock', defaultModel: 'mock' }, jarvis: { enabled: false } })
    const server = new H5Server(host, { dataDir: f.dataDir, port: 0, host: '127.0.0.1', updates: { root: f.root, development: true } })
    await host.init(); await server.start(); server.updates.stop(); cleanup.push(async () => { await server.stop(); await host.close() })
    const state = await readState(f.root, f.dataDir), manifest = await f.add('0.9.0', 'backend', {})
    state.staged = { backend: { directory: '/not-executed', manifest } }; state.pending = true
    await atomicJson(statePath(f.root, f.dataDir), state)
    ;(server as any).pendingWorkStarts.set(Promise.resolve(), 'starting')
    ;(server as any).updateRequests = 1
    ;(server as any).terminals.set('terminal', { process: { kill() {} } })
    await (server as any).tryApplyUpdate()
    expect((await readState(f.root, f.dataDir)).blocked).toEqual(expect.arrayContaining(['TASKS_OR_MESSAGES_ACTIVE', 'DATA_REQUESTS_ACTIVE', 'TERMINAL_ACTIVE']))
    expect((server as any).maintenance).toBe(false)
    ;(server as any).pendingWorkStarts.clear(); (server as any).terminals.clear(); (server as any).updateRequests = 0
  })
  it('uses a writer lease to stop CLI writes during the actual handoff', async () => {
    const f = await fixture(), a = new ConversationData(f.dataDir), b = new ConversationData(f.dataDir), token = randomUUID()
    cleanup.push(async () => { await rm(join(f.dataDir, '.update-maintenance.json'), { force: true }); await b.close(); await a.close() })
    await a.call('save', { id: 'a', updatedAt: '2026-01-01' }); await b.call('revision')
    await expect(a.call('acquireUpdateLease', process.pid, token)).rejects.toThrow('UPDATE_OTHER_DATA_CLIENTS')
    await b.close(); await a.call('acquireUpdateLease', process.pid, token)
    await expect(a.call('patch', 'a', { title: 'wrong-client' })).rejects.toThrow('SERVICE_UPDATING')
    vi.stubEnv('PULSE_UPDATE_TOKEN', token)
    await a.call('patch', 'a', { title: 'authorized-upgrade' })
    expect(await a.call('get', 'a')).toMatchObject({ title: 'authorized-upgrade' })
  })
  it('closes the old writer when its owner socket disappears and blocks external clients until the new writer starts', async () => {
    const f = await fixture(), owner = new ConversationData(f.dataDir), token = randomUUID()
    let replacement: ConversationData | undefined
    cleanup.push(async () => { await rm(join(f.dataDir, '.update-maintenance.json'), { force: true }); await replacement?.close(); await owner.close() })
    await owner.call('save', { id: 'keep', updatedAt: '2026-01-01' })
    await owner.call('acquireUpdateLease', process.pid, token)
    const outsider = new ConversationData(f.dataDir)
    try { await expect(outsider.call('revision')).rejects.toThrow('SERVICE_UPDATING') } finally { await outsider.close() }
    ;(owner as any).socket.destroy()
    await waitFor(() => readFile(join(f.dataDir, '.writer.lock'), 'utf8').catch(() => ''), value => value === '')
    vi.stubEnv('PULSE_UPDATE_TOKEN', token)
    replacement = new ConversationData(f.dataDir)
    expect(await replacement.call('get', 'keep')).toMatchObject({ id: 'keep' })
  })
})

describe('headless external coordinator', () => {
  for (const fail of [false, true]) it(fail ? 'restores the old process after a candidate crashes before health confirmation' : 'switches backend with the shell closed, preserving its listening port', async () => {
    const f = await fixture(), baseRuntime = join(f.root, 'base')
    await serviceRuntime(baseRuntime, '0.8.0')
    const candidate = join(f.root, 'candidate'), values = await serviceRuntime(candidate, '0.9.0', fail)
    await f.add('0.9.0', 'backend', values); f.index()
    const manager = new UpdateManager({ root: f.root, dataDir: f.dataDir, backendVersion: '0.8.0', development: true, indexUrl: f.base + 'index.json', keys: f.keys })
    await manager.check(); await manager.download(); await manager.requestApply()
    vi.stubEnv('PULSE_DATA_DIR', f.dataDir)
    const running = supervise({ node: process.execPath, entry: join(baseRuntime, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), args: ['h5', 'start', '--port', '0'], dataDir: f.dataDir, root: f.root, runtimeDirectory: baseRuntime }, f.keys)
    const descriptor = await waitFor(() => readFile(join(f.dataDir, 'service.json'), 'utf8').then(JSON.parse), value => value.port > 0)
    const url = `http://127.0.0.1:${descriptor.port}`
    cleanup.push(async () => { await fetch(url + '/stop').catch(() => {}); await running })
    await fetch(url + '/ready')
    const state = await waitFor(() => readState(f.root, f.dataDir), value => !value.pending && (fail ? value.phase === 'failed' : value.active.backend?.manifest.version === '0.9.0'))
    const response = await waitFor(() => fetch(url).then(value => value.json()), value => value.version === (fail ? '0.8.0' : '0.9.0'))
    expect(response.pid).not.toBe(descriptor.pid)
    expect((JSON.parse(await readFile(join(f.dataDir, 'service.json'), 'utf8'))).port).toBe(descriptor.port)
    if (fail) expect(state.failed).toHaveLength(1)
    await fetch(url + '/stop'); expect(await running).toBe(0)
  }, 60000)
})
