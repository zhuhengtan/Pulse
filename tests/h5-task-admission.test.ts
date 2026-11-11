import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import ts from 'typescript'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { acceptWorkRequests } from './helpers/work-intent.js'

it('preserves host admission over real H5 HTTP, SSE and child-process boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-h5-admission-'))
  const entry = join(dir, 'worker.mjs'), directory = join(dir, 'ledger')
  // The fixture runs real IPC and the real ledger, but never imports a provider.
  const source = ts.transpileModule(await readFile(new URL('../packages/server/src/task-admission.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('createRequire(import.meta.url)', `createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)})`)
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  await writeFile(entry, `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HostTaskAdmissionStore } from ${JSON.stringify(moduleUrl)};
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
writeFileSync(join(dir, 'fork-' + process.pid), 'forked');
let permit;
process.on('message', m => {
  if (m.type === 'configure') { permit = m.runtimeOptions.taskAdmissionPermit; process.send({schemaVersion:1,type:'configured'}); }
  if (m.type === 'shutdown') process.exit(0);
  if (m.type === 'rpc') { process.send({schemaVersion:1,type:'rpcResult',requestId:m.requestId,ok:true,value:[]}); return; }
  if (m.type !== 'start') return;
  const store = new HostTaskAdmissionStore({directory:permit.directory});
  store.markRunning(permit.jobId, permit.ownerToken, {pid:process.pid}); store.close();
  writeFileSync(join(dir, 'input-' + m.conversationId + '.json'), JSON.stringify(m));
  process.send({schemaVersion:1,type:'started',requestId:m.requestId,runId:permit.runId,conversationId:m.conversationId});
  const timer = setInterval(() => {
    if (!existsSync(join(dir, 'release-' + m.conversationId))) return;
    clearInterval(timer);
    process.send({schemaVersion:1,type:'event',event:{schemaVersion:1,type:'complete',runId:permit.runId,conversationId:m.conversationId,seq:1,data:{status:'succeeded'}}});
    process.send({schemaVersion:1,type:'settled',outcome:{status:'succeeded'},usage:{schemaVersion:1,modelCalls:0}}, () => process.disconnect());
  }, 10);
});
process.send({schemaVersion:1,type:'ready'});
`)
  const host = createLocalHost({ cwd: dir, dataDir: dir, taskAdmissionDirectory: directory, taskAdmission: { maxRunning: 1 }, jarvis: { enabled: false } })
  acceptWorkRequests(host)
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir: dir, workWorker: { entry, dataDir: dir, cwd: dir, approvalMode: 'ask', startupTimeoutMs: 2000 } })
  const streamAbort = new AbortController()
  let consuming: Promise<void> | undefined
  const conversations = await Promise.all(Array.from({ length: 3 }, () => host.createConversation()))
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    expect(session.status).toBe(200)
    const headers = { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const send = async (index: number) => {
      const response = await fetch(`${base}/api/conversations/${conversations[index]!.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'fixture only', requestId: `admission-http-${index}` }), signal: AbortSignal.timeout(2000) })
      const body = await response.json() as { runId: string }
      expect(response.status, JSON.stringify(body)).toBe(200); expect(body.runId).toBeTruthy(); return body.runId
    }
    const snapshot = async (runId: string) => {
      const response = await fetch(`${base}/api/runs/${runId}/state`, { headers, signal: AbortSignal.timeout(2500) }); expect(response.status).toBe(200)
      return response.json() as Promise<{ state: string; admission?: { phase: string; queuedAt: number; startedAt?: number } }>
    }
    const forks = async () => (await readdir(dir)).filter(name => name.startsWith('fork-')).length
    const first = await send(0), second = await send(1), third = await send(2)
    expect(new Set([first, second, third]).size).toBe(3)
    expect(await forks()).toBe(1)
    expect(host.taskAdmissionSnapshot()).toMatchObject({ occupied: 1, queued: 2 })
    for (const runId of [second, third]) {
      const state = await snapshot(runId)
      expect(state).toMatchObject({ state: 'running', admission: { phase: 'queued' } })
      expect(state.admission?.startedAt).toBeUndefined()
    }
    expect(await send(1)).toBe(second)
    expect(await forks()).toBe(1)
    expect((await host.getConversationMessages(conversations[1]!.id)).filter(message => message.role === 'user')).toHaveLength(1)

    const events: Array<{ type: string; runStartedAt?: number; data?: { admission?: { phase: string; queuedAt: number; startedAt?: number } } }> = []
    const response = await fetch(`${base}/api/runs/${second}/events`, { headers, signal: streamAbort.signal })
    expect(response.status).toBe(200)
    consuming = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = ''
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break
          pending += decoder.decode(chunk.value, { stream: true })
          let end: number
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2)
            const data = frame.split('\n').find(line => line.startsWith('data: '))
            if (data) events.push(JSON.parse(data.slice(6)))
          }
        }
      } catch (error) { if (!streamAbort.signal.aborted) throw error }
      finally { reader.releaseLock() }
    })()
    await expect.poll(() => events.some(event => event.type === 'status' && event.data?.admission?.phase === 'queued')).toBe(true)
    const queuedEvent = events.find(event => event.type === 'status' && event.data?.admission?.phase === 'queued')!
    expect(queuedEvent.data?.admission?.startedAt).toBeUndefined()
    // Queue arrival must not start the elapsed execution clock.
    expect.soft(queuedEvent.runStartedAt).toBeUndefined()

    const cancel = await fetch(`${base}/api/runs/${third}/cancel`, { method: 'POST', headers })
    expect(cancel.status).toBe(200);
    await expect.poll(async () => (await snapshot(third)).state).toBe('cancelled')
    expect(await forks()).toBe(1)
    await delay(100)
    const releasedAt = Date.now()
    await writeFile(join(dir, `release-${conversations[0]!.id}`), '')
    await expect.poll(forks).toBe(2)
    await expect.poll(() => events.some(event => event.type === 'status' && event.data?.admission?.phase === 'running')).toBe(true)
    const running = await snapshot(second)
    expect(running).toMatchObject({ state: 'running', admission: { phase: 'running' } })
    expect(running.admission!.startedAt!).toBeGreaterThanOrEqual(releasedAt)
    expect(running.admission!.startedAt!).toBeGreaterThan(running.admission!.queuedAt)
    const runningEvent = events.find(event => event.type === 'status' && event.data?.admission?.phase === 'running')!
    expect.soft(runningEvent.runStartedAt).toBe(running.admission!.startedAt)
    expect(await send(1)).toBe(second)
    expect(await forks()).toBe(2)
    expect((await host.getConversationMessages(conversations[1]!.id)).filter(message => message.role === 'user')).toHaveLength(1)
    const input = JSON.parse(await readFile(join(dir, `input-${conversations[1]!.id}.json`), 'utf8'))
    expect(input).toMatchObject({ runId: second, userMessageRecorded: true })
    expect((await readdir(dir)).some(name => name === `input-${conversations[2]!.id}.json`)).toBe(false)
    await writeFile(join(dir, `release-${conversations[1]!.id}`), '')
    await expect.poll(async () => (await snapshot(second)).state).toBe('succeeded')
    await consuming
    expect(await forks()).toBe(2)
    expect(host.taskAdmissionSnapshot()).toMatchObject({ occupied: 0, queued: 0 })
  } finally {
    streamAbort.abort(); await consuming?.catch(() => undefined)
    for (const conversation of conversations) await writeFile(join(dir, `release-${conversation.id}`), '')
    await server.stop(); await host.close(); await rm(dir, { recursive: true, force: true })
  }
}, 15000)
