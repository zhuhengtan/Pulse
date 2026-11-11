import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createLocalHost, H5Server, HostTaskAdmissionStore } from '../packages/server/src/index.js'

it('requires local administration, same origin and a current stopped confirmation for recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-admission-admin-'))
  const ledger = join(dir, 'ledger')
  const host = createLocalHost({ cwd: dir, dataDir: dir, taskAdmissionDirectory: ledger })
  const server = new H5Server(host, { dataDir: dir, port: 0, host: '127.0.0.1' })
  const store = new HostTaskAdmissionStore({ directory: ledger })
  try {
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const local = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: local.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' }
    const paired = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.createPairingCode().code, name: 'Paired phone' }) })
    expect((await fetch(`${base}/api/task-admission`, { headers: { Cookie: paired.headers.get('set-cookie')! } })).status).toBe(403)
    expect((await fetch(`${base}/api/task-admission`, { method: 'PATCH', headers: { ...headers, Origin: 'http://evil.invalid' }, body: JSON.stringify({ maxRunning: 1 }) })).status).toBe(403)
    expect((await fetch(`${base}/api/task-admission`, { method: 'PATCH', headers, body: JSON.stringify({ maxRunning: 0 }) })).status).toBe(409)
    expect((await fetch(`${base}/api/task-admission`, { method: 'PATCH', headers, body: JSON.stringify({ maxRunning: 1, maxQueued: 3 }) })).status).toBe(200)
    expect(store.snapshot()).toMatchObject({ maxRunning: 1, maxQueued: 3 })
    store.enqueue({ jobId: 'uncertain-job', ownerToken: 'private-owner-token', projectKey: 'project', conversationKey: 'conversation', metadata: { dataDir: dir, runId: 'run-uncertain' } })
    store.claim('uncertain-job', 'private-owner-token')
    const quarantined = store.quarantine('uncertain-job', 'test-only unknown startup')
    const snapshot = await fetch(`${base}/api/task-admission`, { headers }).then(response => response.text())
    expect(snapshot).not.toContain('private-owner-token')
    const recover = (body: object) => fetch(`${base}/api/task-admission/uncertain-job/recover`, { method: 'POST', headers, body: JSON.stringify(body) })
    expect((await recover({ expectedUpdatedAt: quarantined.updatedAt })).status).toBe(409)
    expect((await recover({ expectedUpdatedAt: quarantined.updatedAt - 1, confirmedStopped: true })).status).toBe(409)
    expect(store.snapshot().occupied).toBe(1)
    expect((await recover({ expectedUpdatedAt: quarantined.updatedAt, confirmedStopped: true })).status).toBe(200)
    expect(store.get('uncertain-job')?.status).toBe('interrupted')
    expect(store.snapshot().occupied).toBe(0)
    expect((await recover({ expectedUpdatedAt: quarantined.updatedAt, confirmedStopped: true })).status).toBe(409)
    const intent = new HostTaskAdmissionStore({ directory: join(ledger, 'intent') })
    try {
      for (const jobId of ['intent-a', 'intent-b']) {
        intent.enqueue({ jobId, ownerToken: 'private-dead-owner', conversationKey: jobId, projectKey: 'intent', metadata: { ownerPid: 2147483647 } }); intent.claim(jobId, 'private-dead-owner')
      }
      intent.reconcileOwner('private-dead-owner')
      const view = await fetch(`${base}/api/task-admission?channel=intent`, { headers }).then(response => response.json())
      expect(view.quarantined).toBe(2)
      expect(JSON.stringify(view)).not.toContain('private-dead-owner')
      for (const job of view.jobs) {
        const response = await fetch(`${base}/api/task-admission/${job.jobId}/recover`, { method: 'POST', headers, body: JSON.stringify({ channel: 'intent', confirmedStopped: true, expectedUpdatedAt: job.updatedAt }) })
        expect(response.status).toBe(200)
      }
      expect(intent.snapshot().occupied).toBe(0)
      let called = false
      await (host as any).withWorkIntent(async () => { called = true })
      expect(called).toBe(true)
    } finally { intent.close() }
  } finally { store.close(); await server.stop(); await host.close(); await rm(dir, { recursive: true, force: true }) }
})

it('bounds the pre-task intent channel independently of occupied background slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-admission-intent-'))
  const hosts = [0, 1, 2].map(index => createLocalHost({ cwd: dir, dataDir: join(dir, String(index)), taskAdmissionDirectory: join(dir, 'ledger') }))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let running = 0, peak = 0
  const operation = async () => { running++; peak = Math.max(peak, running); try { await held } finally { running-- } }
  const calls = hosts.map(host => (host as any).withWorkIntent(operation))
  try {
    await expect.poll(() => running).toBe(2)
    expect(peak).toBe(2)
    release()
    await Promise.all(calls)
    expect(peak).toBe(2)
    expect(hosts[0]!.taskAdmissionSnapshot().occupied).toBe(0)
  } finally { release(); await Promise.allSettled(calls); await Promise.all(hosts.map(host => host.close())); await rm(dir, { recursive: true, force: true }) }
})
