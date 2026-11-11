import { acceptWorkRequests } from './helpers/work-intent.js'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveShellIdentity } from '@hunterzhu/pulse-adapters'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'

it.skipIf(process.platform === 'win32')('authenticates run-owned read/cancel routes and forwards them to the actual live worker PTY', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-process-http-')))
  const script = join(root, 'interactive.cjs')
  await writeFile(script, "console.log(process.stdin.isTTY?'worker-tty-ready':'NOT_TTY');setInterval(()=>{},1000)")
  const identity = await resolveShellIdentity('node', [script], root)
  const host = createLocalHost({ cwd: root, dataDir: root, taskController: false, jarvis: { enabled: false }, provider: { provider: 'mock' }, approvalMode: 'ask', execPolicy: { rules: [{ pattern: [identity.path, script], decision: 'allow' }] } })
  acceptWorkRequests(host)
  const server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0, workWorker: { entry: fileURLToPath(new URL('./fixtures/agent-process-worker.mjs', import.meta.url)), dataDir: root, cwd: root, approvalMode: 'ask', runtimeOptions: host.getWorkWorkerOptions() } })
  await host.init()
  const info = await server.start(), base = `http://127.0.0.1:${info.port}`
  try {
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } }), cookie = session.headers.get('set-cookie') ?? ''
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
    const conversation = await host.createConversation({ cwd: root })
    const sent = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Start the local interactive fixture and wait for a choice.' }) })
    expect(sent.status).toBe(200)
    const { runId } = await sent.json(), path = `${base}/api/runs/${runId}/processes`
    expect((await fetch(path)).status).toBe(401)
    let processId = ''
    await expect.poll(async () => {
      const response = await fetch(path, { headers }); expect(response.status).toBe(200)
      const { items } = await response.json()
      processId = items[0]?.processId ?? ''
      return items[0]?.stdinReady
    }, { timeout: 10000, interval: 40 }).toBe(true)
    // The parent Host has no native capability and must not be used in place of RPC.
    expect((await host.listRunProcesses(conversation.id, runId))[0]?.status).toBe('unknown')
    await expect.poll(async () => (await fetch(`${path}/${processId}`, { headers }).then(response => response.json())).output, { timeout: 5000 }).toContain('worker-tty-ready')
    expect((await fetch(`${path}/${processId}?offset=-1`, { headers })).status).toBe(400)
    expect((await fetch(`${path}/${'f'.repeat(64)}`, { headers })).status).toBe(404)
    expect((await fetch(`${path}/${processId}/stdin`, { method: 'POST', headers, body: '{}' })).status).toBe(404)
    expect((await fetch(`${path}/${processId}/cancel`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
    expect((await fetch(`${path}/${processId}`, { headers }).then(response => response.json())).status).toBe('exited')
    expect((await fetch(`${base}/api/runs/run-missing/processes`, { headers })).status).toBe(404)
    await expect(host.readRunProcess(conversation.id, 'run-missing', processId)).rejects.toThrow('RUN_NOT_FOUND')
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 25000)
