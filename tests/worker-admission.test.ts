import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLocalHost, type LocalHost } from '../packages/server/src/index.js'
import { startAdmittedH5WorkWorker, startH5WorkWorker } from '../packages/server/src/h5/work-worker.js'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-worker-admission-')); directories.push(dir)
  const entry = join(dir, 'worker.mjs')
  await writeFile(entry, `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
writeFileSync(join(dir, 'fork-' + process.pid), 'forked');
let permit;
process.on('message', m => {
  if (m.type === 'configure') { permit = m.runtimeOptions.taskAdmissionPermit; process.send({schemaVersion:1,type:'configured'}); }
  if (m.type === 'shutdown') { process.exit(0); }
  if (m.type !== 'start') return;
  writeFileSync(join(dir, 'input-' + m.conversationId + '.json'), JSON.stringify(m));
  const runId = permit?.runId ?? 'raw-worker-id';
  process.send({schemaVersion:1,type:'started',requestId:m.requestId,runId,conversationId:m.conversationId});
  const timer = setInterval(() => {
    if (!existsSync(join(dir, 'release')) && !existsSync(join(dir, 'release-' + m.conversationId))) return;
    clearInterval(timer);
    process.send({schemaVersion:1,type:'settled',outcome:{status:'succeeded'},usage:{schemaVersion:1,modelCalls:0}}, () => process.disconnect());
  }, 10);
});
process.send({schemaVersion:1,type:'ready'});
`)
  return { dir, options: { entry, dataDir: dir, cwd: dir, approvalMode: 'ask' as const, startupTimeoutMs: 2000 } }
}

it('keeps raw fixture run identity and forwards admission input fields over IPC', async () => {
  const { dir, options } = await fixture()
  const run = await startH5WorkWorker(options, { conversationId: 'raw', text: 'work', runId: 'requested', userMessageRecorded: true })
  try {
    expect(run.id).toBe('raw-worker-id')
    expect(JSON.parse(await readFile(join(dir, 'input-raw.json'), 'utf8'))).toMatchObject({ runId: 'requested', userMessageRecorded: true })
    await writeFile(join(dir, 'release'), '')
    await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
  } finally { await run.shutdown?.() }
})

it('admits only two forks and cancels queued work before spawning', async () => {
  const { dir, options } = await fixture()
  const host = createLocalHost({ cwd: dir, dataDir: dir, taskAdmissionDirectory: join(dir, 'ledger'), taskAdmission: { maxRunning: 2 }, taskController: false })
  const runs = []
  try {
    const conversations = await Promise.all(Array.from({ length: 3 }, () => host.createConversation()))
    for (const conversation of conversations) runs.push(await startAdmittedH5WorkWorker(host, options, { conversationId: conversation.id, text: 'fixture only' }))
    await expect.poll(async () => (await readdir(dir)).filter(name => name.startsWith('fork-')).length).toBe(2)
    expect(runs[2].admission?.().phase).toBe('queued')
    await runs[2].cancel('USER_REQUESTED')
    await expect(runs[2].outcome()).resolves.toMatchObject({ status: 'cancelled' })
    expect((await readdir(dir)).filter(name => name.startsWith('fork-'))).toHaveLength(2)
    for (let i = 0; i < 2; i++) {
      const received = JSON.parse(await readFile(join(dir, `input-${conversations[i].id}.json`), 'utf8'))
      expect(received).toMatchObject({ runId: runs[i].id })
      expect(received.userMessageRecorded).toBeUndefined()
      // Immediate claims leave recording to the real worker. This transport
      // fixture does not execute LocalHost.sendMessage or append a transcript.
      expect((await host.getConversationMessages(conversations[i].id)).filter(m => m.role === 'user')).toHaveLength(0)
    }
    expect((await host.getConversationMessages(conversations[2].id)).filter(m => m.role === 'user')).toEqual([
      expect.objectContaining({ text: 'fixture only', runId: runs[2].id }),
    ])
    await writeFile(join(dir, 'release'), '')
    await Promise.all(runs.map(run => run.outcome()))
    expect(host.taskAdmissionSnapshot().occupied).toBe(0)
  } finally {
    await writeFile(join(dir, 'release'), '')
    await Promise.all(runs.map(run => run.shutdown?.()))
    await host.close()
  }
})

it('records a queued request once and forwards its recorded flag when capacity becomes available', async () => {
  const { dir, options } = await fixture()
  const host = createLocalHost({ cwd: dir, dataDir: dir, taskAdmissionDirectory: join(dir, 'ledger'), taskAdmission: { maxRunning: 1 }, taskController: false })
  const runs = []
  try {
    const first = await host.createConversation(), queued = await host.createConversation()
    runs.push(await startAdmittedH5WorkWorker(host, options, { conversationId: first.id, text: 'immediate', requestId: 'immediate-request' }))
    runs.push(await startAdmittedH5WorkWorker(host, options, { conversationId: queued.id, text: 'queued', requestId: 'queued-request' }))
    expect(runs[1].admission?.().phase).toBe('queued')
    const recorded = () => host.getConversationMessages(queued.id).then(messages => messages.filter(message => message.role === 'user'))
    expect(await recorded()).toEqual([expect.objectContaining({ id: 'msg-queued-request', runId: runs[1].id, text: 'queued' })])
    await writeFile(join(dir, 'release-' + first.id), '')
    await runs[0].outcome()
    await expect.poll(async () => readFile(join(dir, `input-${queued.id}.json`), 'utf8').then(JSON.parse, () => undefined)).toMatchObject({ runId: runs[1].id, messageRequestId: 'queued-request', userMessageRecorded: true })
    expect(await recorded()).toHaveLength(1)
    await writeFile(join(dir, 'release-' + queued.id), '')
    await runs[1].outcome()
    expect(await recorded()).toHaveLength(1)
    expect((await readdir(dir)).filter(name => name.startsWith('fork-'))).toHaveLength(2)
    expect(host.taskAdmissionSnapshot().occupied).toBe(0)
  } finally {
    await writeFile(join(dir, 'release'), '')
    await Promise.all(runs.map(run => run.shutdown?.()))
    await host.close()
  }
})

it('does not schedule twice when the parent already supplies a permit', async () => {
  const { dir, options } = await fixture()
  const host: Pick<LocalHost, 'scheduleTask'> = { scheduleTask: async () => { throw new Error('DOUBLE_ADMISSION') } }
  const permit = { directory: join(dir, 'ledger'), jobId: 'job', ownerToken: 'owner', runId: 'admitted-run', conversationKey: `${dir}:existing` }
  const run = await startAdmittedH5WorkWorker(host, { ...options, runtimeOptions: { taskAdmissionPermit: permit } }, { conversationId: 'existing', text: 'work', runId: permit.runId, userMessageRecorded: true })
  try {
    expect(run.id).toBe(permit.runId)
    await writeFile(join(dir, 'release'), '')
    await expect(run.outcome()).resolves.toMatchObject({ status: 'succeeded' })
  } finally { await run.shutdown?.() }
})
