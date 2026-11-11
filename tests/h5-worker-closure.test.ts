import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { startH5WorkWorker } from '../packages/server/src/h5/work-worker.js'
import { acceptWorkRequests } from './helpers/work-intent.js'

const dirs: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/h5-work-worker.mjs', import.meta.url))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'pulse-worker-closure-')); dirs.push(dir); return dir }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(20) } throw new Error('CLOSURE_TEST_TIMEOUT') }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

it('publishes one successful completion only after worker cleanup and process closure', async () => {
  const dir = await directory()
  const handle = await startH5WorkWorker({ entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask' }, { conversationId: 'conv-cleanup-success', text: 'succeed' })
  try {
    const events: Array<{ type: string }> = []
    const completionChecks: Array<{ active: boolean | undefined; cleaned: boolean }> = []
    const consuming = (async () => { for await (const event of handle.events) { if (event.type === 'complete') completionChecks.push({ active: handle.isActive?.(), cleaned: await access(join(dir, 'worker-cleanup-complete.txt')).then(() => true, () => false) }); events.push(event) } })()
    await pause(100)
    expect(events.map(event => event.type)).toEqual(['text'])
    await consuming
    expect(events.filter(event => event.type === 'complete')).toHaveLength(1)
    expect(completionChecks).toEqual([{ active: false, cleaned: true }])
    await expect(handle.outcome()).resolves.toMatchObject({ status: 'succeeded' })
  } finally { await handle.shutdown?.() }
})

it('projects cleanup failure as interrupted without a successful completion or notification', async () => {
  const dir = await directory()
  const host = createLocalHost({ cwd: dir, dataDir: dir, provider: { provider: 'mock', defaultModel: 'mock' }, jarvis: { enabled: false } })
  acceptWorkRequests(host)
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: dir, workWorker: { entry: fixture, dataDir: dir, cwd: dir, approvalMode: 'ask' } })
  try {
    await server.start()
    const conversation = await host.createConversation({ cwd: dir })
    const internals = server as any
    const handle = await internals.startConversationRun(conversation.id, 'fail during cleanup')
    await expect(handle.outcome()).rejects.toThrow('WORKER_EXITED:1')
    await until(() => !internals.activeRuns.has(handle.id))
    const snapshot = internals.runSnapshots.get(handle.id)
    expect(snapshot.state).toBe('interrupted')
    expect(snapshot.complete).toBeUndefined()
    expect(internals.runEventBuffers.get(handle.id).some((event: any) => event.type === 'error')).toBe(true)
    expect((await internals.taskNotices.list()).some((notice: any) => notice.runId === handle.id && notice.kind === 'complete')).toBe(false)
    expect(await host.conversationData.call('readState', `run:${handle.id}`)).toMatchObject({ state: 'interrupted' })
  } finally { await server.stop(); await host.close() }
})

it.each([false, true])('contains an overflowing worker before losing its handle (ignores shutdown=%s)', async ignoresShutdown => {
  const dir = await directory()
  const entry = join(dir, 'flood-worker.mjs')
  await writeFile(entry, `import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    ${ignoresShutdown ? "process.on('SIGTERM',()=>{});" : ''}
    process.send({schemaVersion:1,type:'ready'});
    process.on('message',m=>{
      if(m.type==='configure')process.send({schemaVersion:1,type:'configured'});
      if(m.type==='shutdown'){${ignoresShutdown ? 'return' : "setTimeout(()=>{writeFileSync(join(process.cwd(),'stopped.txt'),'closed');process.disconnect()},100);return"}}
      if(m.type==='start'){
        writeFileSync(join(process.cwd(),'starts.txt'),'once');
        process.send({schemaVersion:1,type:'started',requestId:m.requestId,runId:'run-flood',conversationId:m.conversationId});
        for(let i=0;i<4300;i++)process.send({schemaVersion:1,type:'event',event:{schemaVersion:1,type:'tool',runId:'run-flood',conversationId:m.conversationId,seq:i+1,data:{activityId:String(i),status:'running',tool:'fake'}}});
      }
    });`)
  const handle = await startH5WorkWorker({ entry, dataDir: dir, cwd: dir, approvalMode: 'ask', startupTimeoutMs: 2000 }, { conversationId: 'conv-flood', text: 'mock only' })
  try {
    await pause(350)
    const consuming = (async () => { let count = 0; for await (const event of handle.events) { expect(event.type).toBe('tool'); count++ } return count })()
    await expect(consuming).rejects.toThrow('WORK_EVENT_QUEUE_OVERFLOW')
    expect(handle.isActive?.()).toBe(false)
    await expect(handle.outcome()).rejects.toThrow('WORK_EVENT_QUEUE_OVERFLOW')
    expect(await readFile(join(dir, 'starts.txt'), 'utf8')).toBe('once')
    if (!ignoresShutdown) expect(await readFile(join(dir, 'stopped.txt'), 'utf8')).toBe('closed')
  } finally { await handle.shutdown?.() }
}, 25000)


it.each(['complete', 'settled'] as const)('bounds worker cleanup that hangs after %s without publishing success', async terminal => {
  const dir = await directory()
  const entry = join(dir, 'hung-cleanup.mjs')
  await writeFile(entry, `process.send({schemaVersion:1,type:'ready'});process.on('message',m=>{
    if(m.type==='configure')process.send({schemaVersion:1,type:'configured'});
    if(m.type==='shutdown'){process.disconnect();return}
    if(m.type==='start'){
      process.send({schemaVersion:1,type:'started',requestId:m.requestId,runId:'run-hang',conversationId:m.conversationId});
      ${terminal === 'complete' ? "process.send({schemaVersion:1,type:'event',event:{schemaVersion:1,type:'complete',runId:'run-hang',conversationId:m.conversationId,seq:1,data:{status:'succeeded'}}});" : ''}
      ${terminal === 'settled' ? "process.send({schemaVersion:1,type:'settled',outcome:{status:'succeeded'},usage:{schemaVersion:1,modelCalls:0}});" : ''}
    }
  });`)
  const handle = await startH5WorkWorker({ entry, dataDir: dir, cwd: dir, approvalMode: 'ask', cleanupTimeoutMs: 100 }, { conversationId: 'conv-hang', text: 'mock cleanup only' })
  try {
    const seen = []
    await expect((async () => { for await (const event of handle.events) seen.push(event) })()).rejects.toThrow('WORKER_CLEANUP_TIMEOUT')
    expect(seen).toEqual([])
    expect(handle.isActive?.()).toBe(false)
    await expect(handle.outcome()).rejects.toThrow('WORKER_CLEANUP_TIMEOUT')
  } finally { await handle.shutdown?.() }
})

it('reserves one terminal slot when the bounded progress queue is exactly full', async () => {
  const dir = await directory()
  const entry = join(dir, 'full-progress.mjs')
  await writeFile(entry, `process.send({schemaVersion:1,type:'ready'});process.on('message',m=>{
    if(m.type==='configure')process.send({schemaVersion:1,type:'configured'});
    if(m.type==='shutdown'){process.disconnect();return}
    if(m.type==='start'){
      process.send({schemaVersion:1,type:'started',requestId:m.requestId,runId:'run-full',conversationId:m.conversationId});
      for(let i=0;i<4096;i++)process.send({schemaVersion:1,type:'event',event:{schemaVersion:1,type:'tool',runId:'run-full',conversationId:m.conversationId,seq:i+1,data:{activityId:String(i),status:'running',tool:'fake'}}});
      process.send({schemaVersion:1,type:'event',event:{schemaVersion:1,type:'complete',runId:'run-full',conversationId:m.conversationId,seq:4097,data:{status:'succeeded'}}});
      process.send({schemaVersion:1,type:'settled',outcome:{status:'succeeded'},usage:{schemaVersion:1,modelCalls:0}},()=>process.disconnect());
    }
  });`)
  const handle = await startH5WorkWorker({ entry, dataDir: dir, cwd: dir, approvalMode: 'ask' }, { conversationId: 'conv-full', text: 'mock progress only' })
  try {
    await handle.outcome()
    const seen = []
    for await (const event of handle.events) seen.push(event)
    expect(seen).toHaveLength(4097)
    expect(seen.filter(event => event.type === 'complete')).toHaveLength(1)
    expect(seen.at(-1)?.type).toBe('complete')
  } finally { await handle.shutdown?.() }
})
