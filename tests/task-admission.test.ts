import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskAdmissionStore, defaultHostTaskAdmissionDirectory } from '../packages/server/src/task-admission.js'

const directories: string[] = []
const stores: HostTaskAdmissionStore[] = []
function setup(options: { maxRunning?: number; maxQueued?: number; maxTerminal?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-admission-')); directories.push(directory)
  const store = new HostTaskAdmissionStore({ directory, ...options }); stores.push(store)
  return { directory, store }
}
const input = (jobId: string, projectKey = 'a', ownerToken = 'owner') => ({ jobId, projectKey, ownerToken, conversationKey: `conversation-${jobId}`, metadata: { digest: jobId } })
const release = (store: HostTaskAdmissionStore, id: string) => store.release(id, 'owner', { confirmed: true, outcome: 'completed' })
afterEach(() => { for (const store of stores.splice(0)) { try { store.close() } catch {} } for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

type AdmissionReply = { id: number; result: ReturnType<HostTaskAdmissionStore['claim']>; snapshot: ReturnType<HostTaskAdmissionStore['snapshot']> }
/** Keep null claimants alive: FIFO can reject an attempt while capacity is free. */
async function withAdmissionProcesses(store: HostTaskAdmissionStore, run: (workers: Array<{ request(action: 'enqueue' | 'claim'): Promise<AdmissionReply> }>) => Promise<void>) {
  const { readFileSync } = await import('node:fs')
  const ts = await import('typescript')
  const source = ts.transpileModule(readFileSync(new URL('../packages/server/src/task-admission.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('createRequire(import.meta.url)', `createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)})`)
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  // Leave time inside the existing test deadline for unconditional owned cleanup.
  const deadline = Date.now() + (process.platform === 'win32' ? 150_000 : 6500)
  const trace: unknown[] = []
  const record = (event: unknown) => { trace.push(event); if (trace.length > 32) trace.shift() }
  const workers: Array<ReturnType<typeof start>> = []
  function start(index: number) {
    const script = `import {HostTaskAdmissionStore} from ${JSON.stringify(moduleUrl)};
      const s = new HostTaskAdmissionStore({directory:${JSON.stringify(store.directory)}});
      process.on('message', ({id,action}) => {
        if (action === 'stop') { s.close(); process.exit(0); }
        const result = action === 'enqueue' ? s.enqueue(${JSON.stringify(input(String(index)))}) : s.claim(${JSON.stringify(String(index))},'owner');
        process.send({id,result,snapshot:s.snapshot()});
      });
      process.on('disconnect', () => { s.close(); process.exit(0); });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stdout = '', stderr = '', sequence = 0, stopping = false, failure: Error | undefined
    let pending: { id: number; resolve(reply: AdmissionReply): void; reject(error: Error): void } | undefined
    const fail = (error: Error) => { failure ??= error; pending?.reject(error) }
    child.stdout!.on('data', chunk => { stdout = (stdout + chunk).slice(-2048) })
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-2048) })
    child.on('error', fail)
    child.on('message', (message: AdmissionReply) => {
      record({ worker: index, reply: message })
      if (!message || !pending || message.id !== pending.id) { fail(new Error(`Unexpected admission child reply ${index}`)); return }
      pending.resolve(message)
    })
    // Observe lifecycle immediately, including exits before the first request.
    const closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
      record({ worker: index, code, signal })
      if (!stopping || code !== 0 || signal !== null) fail(new Error(`Admission child ${index} closed: ${code}/${signal}`))
      resolve()
    }))
    return {
      async request(action: 'enqueue' | 'claim'): Promise<AdmissionReply> {
        if (failure) throw failure
        if (stopping) throw new Error('Admission child is stopping')
        if (pending) throw new Error('Overlapping admission child requests')
        const id = ++sequence
        record({ worker: index, id, action })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await new Promise<AdmissionReply>((resolve, reject) => {
            pending = { id, resolve, reject: error => { clearTimeout(timer); reject(error) } }
            timer = setTimeout(() => reject(new Error(`Admission child ${index} timed out during ${action}`)), Math.max(1, deadline - Date.now()))
            child.send({ id, action }, error => { if (error) fail(error) })
          })
        } finally { clearTimeout(timer); pending = undefined }
      },
      async stop() {
        stopping = true
        // A sibling may have failed while this child still owes an ACK.
        // Settle that request even when graceful stop subsequently exits zero.
        pending?.reject(new Error(`Admission child ${index} stopped before its reply`))
        pending = undefined
        const wait = async (milliseconds: number) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try { return await Promise.race([closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })]) }
          finally { clearTimeout(timer) }
        }
        if (child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send({ action: 'stop' }, error => { if (error) fail(error) })
          if (!await wait(500)) {
            fail(new Error(`Admission child ${index} required forced cleanup`))
            child.kill('SIGKILL')
          }
        }
        if (!await wait(1000)) throw new Error(`Admission child ${index} did not close after cleanup`)
        if (failure) throw failure
      },
      diagnostics: () => ({ worker: index, pid: child.pid, stdout, stderr }),
    }
  }
  let failure: unknown
  try {
    for (let index = 0; index < 6; index++) workers.push(start(index))
    await run(workers)
  } catch (error) { failure = error }
  finally {
    const cleanup = await Promise.allSettled(workers.map(worker => worker.stop()))
    failure ??= cleanup.find(result => result.status === 'rejected')?.reason
  }
  if (failure) {
    let snapshot: unknown
    try { snapshot = store.snapshot() } catch (error) { snapshot = String(error) }
    throw new Error(`${String(failure)}\nAdmission diagnostics: ${JSON.stringify({ trace, snapshot, children: workers.map(worker => worker.diagnostics()) })}`, { cause: failure })
  }
}


describe('host task admission', () => {
  it('uses the same host path regardless of PULSE_HOME, without opening that path', () => {
    const before = defaultHostTaskAdmissionDirectory(), old = process.env.PULSE_HOME
    expect(before).toBe(join(homedir(), '.pulse', 'host-admission'))
    try {
      process.env.PULSE_HOME = join(tmpdir(), 'different-project')
      expect(defaultHostTaskAdmissionDirectory()).toBe(before)
    }
    finally { if (old === undefined) delete process.env.PULSE_HOME; else process.env.PULSE_HOME = old }
  })
  it('enforces defaults and persisted limits across independent connections', () => {
    const { store, directory } = setup()
    const peer = new HostTaskAdmissionStore({ directory }); stores.push(peer)
    for (let i = 0; i < 34; i++) { store.enqueue(input(String(i))); if (i < 2) expect(peer.claim(String(i), 'owner')).not.toBeNull() }
    expect(store.snapshot()).toMatchObject({ maxRunning: 2, maxQueued: 32, occupied: 2, queued: 32 })
    expect(() => peer.enqueue(input('overflow'))).toThrow(expect.objectContaining({ code: 'HOST_TASK_QUEUE_FULL' }))
    expect(peer.claim('2', 'owner')).toBeNull()
    expect(() => new HostTaskAdmissionStore({ directory, maxRunning: 3 })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_MISMATCH' }))
  })
  it('allows immediate work with maxQueued zero but rejects excess pending admissions', () => {
    const { store } = setup({ maxRunning: 1, maxQueued: 0 })
    store.enqueue(input('one'))
    expect(() => store.enqueue(input('two'))).toThrow(expect.objectContaining({ code: 'HOST_TASK_QUEUE_FULL' }))
    expect(store.claim('one', 'owner')).not.toBeNull()
    expect(() => store.enqueue(input('two'))).toThrow(expect.objectContaining({ code: 'HOST_TASK_QUEUE_FULL' }))
    release(store, 'one'); store.enqueue(input('two')); expect(store.claim('two', 'owner')).not.toBeNull()
  })
  it('round-robins projects and preserves FIFO within each project', () => {
    const { store } = setup({ maxRunning: 1 })
    for (const [id, project] of [['a1', 'a'], ['a2', 'a'], ['b1', 'b'], ['b2', 'b']]) store.enqueue(input(id!, project))
    expect(store.claim('a2', 'owner')).toBeNull()
    expect(store.claim('a1', 'owner')?.status).toBe('starting'); release(store, 'a1')
    expect(store.claim('a2', 'owner')).toBeNull()
    expect(store.claim('b1', 'owner')).not.toBeNull(); release(store, 'b1')
    expect(store.claim('a2', 'owner')).not.toBeNull()
  })
  it('deduplicates identical requests but rejects identity, digest and conversation conflicts', () => {
    const { store } = setup(); const job = input('one')
    expect(store.enqueue(job)).toEqual(store.enqueue(job))
    for (const changed of [{ ...job, ownerToken: 'other' }, { ...job, metadata: { digest: 'changed' } }]) expect(() => store.enqueue(changed)).toThrow(expect.objectContaining({ code: 'REQUEST_ID_REUSED' }))
    expect(() => store.enqueue({ ...input('two'), conversationKey: job.conversationKey })).toThrow(expect.objectContaining({ code: 'CONVERSATION_BUSY' }))
    expect(() => store.claim('one', 'other')).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }))
    expect(store.claim('one', 'owner')).not.toBeNull(); expect(store.claim('one', 'owner')).toBeNull()
  })
  it('holds cancelling/quarantined capacity until explicit closure confirmation', () => {
    const { store } = setup({ maxRunning: 1 })
    store.enqueue(input('one')); store.claim('one', 'owner'); store.cancel('one')
    expect(store.markRunning('one', 'owner', { pid: 123, bootId: 'old-boot' }).status).toBe('cancelling')
    store.enqueue(input('two')); store.quarantine('one', 'closure unknown')
    expect(store.claim('two', 'owner')).toBeNull()
    expect(() => store.release('one', 'owner', { confirmed: false as true, outcome: 'completed' })).toThrow()
    expect(store.snapshot().occupied).toBe(1)
    release(store, 'one'); expect(store.claim('two', 'owner')).not.toBeNull()
  })
  it('cancels queued work without consuming a slot', () => {
    const { store } = setup(); store.enqueue(input('one'))
    expect(store.cancel('one').status).toBe('cancelled'); expect(store.claim('one', 'owner')).toBeNull(); expect(store.snapshot().occupied).toBe(0)
  })
  it('persists restart state and reconciles only an explicitly lost owner, without TTL reclamation', () => {
    const { store, directory } = setup()
    store.enqueue(input('running')); store.claim('running', 'owner'); store.markRunning('running', 'owner', { pid: 999999, bootId: 'old' })
    store.enqueue(input('queued')); store.enqueue(input('other', 'b', 'live-owner'))
    store.close()
    const restarted = new HostTaskAdmissionStore({ directory }); stores.push(restarted)
    expect(restarted.get('running')?.status).toBe('running')
    restarted.reconcileOwner('owner')
    expect(restarted.get('running')?.status).toBe('quarantined'); expect(restarted.get('queued')?.status).toBe('interrupted'); expect(restarted.get('other')?.status).toBe('queued')
    expect(restarted.snapshot().occupied).toBe(1)
  })
  it('bounds terminal history without deleting unknown occupied jobs', () => {
    const { store } = setup({ maxTerminal: 2 })
    store.enqueue(input('unknown')); store.claim('unknown', 'owner'); store.quarantine('unknown', 'unknown')
    for (let i = 0; i < 8; i++) { store.enqueue(input(String(i))); store.cancel(String(i)) }
    expect(store.list()).toHaveLength(3); expect(store.get('unknown')?.status).toBe('quarantined')
  })
  it('applies administrator limits across connections without evicting existing work', () => {
    const { store, directory } = setup()
    const peer = new HostTaskAdmissionStore({ directory }); stores.push(peer)
    for (const id of ['one', 'two', 'three']) store.enqueue(input(id))
    store.claim('one', 'owner'); store.claim('two', 'owner')
    expect(peer.configure({ maxRunning: 1, maxQueued: 0 })).toMatchObject({ maxRunning: 1, maxQueued: 0 })
    expect(store.snapshot()).toMatchObject({ occupied: 2, queued: 1, maxRunning: 1 })
    expect(store.claim('three', 'owner')).toBeNull()
    release(store, 'one'); expect(store.claim('three', 'owner')).toBeNull()
    release(store, 'two'); expect(store.claim('three', 'owner')).not.toBeNull()
    peer.configure({ maxRunning: 2 }); store.enqueue(input('four')); expect(store.claim('four', 'owner')).not.toBeNull()
  })
  it('validates bounded administrator settings and constructor settings', () => {
    const { store, directory } = setup()
    for (const invalid of [{ maxRunning: 0 }, { maxRunning: 17 }, { maxRunning: 1.5 }, { maxQueued: -1 }, { maxQueued: 257 }]) {
      expect(() => store.configure(invalid)).toThrow(TypeError)
      expect(() => new HostTaskAdmissionStore({ directory, ...invalid })).toThrow(TypeError)
    }
    expect(store.snapshot()).toMatchObject({ maxRunning: 2, maxQueued: 32 })
    expect(store.configure({ maxRunning: 16, maxQueued: 256 })).toMatchObject({ maxRunning: 16, maxQueued: 256 })
  })
  it('recovers only a quarantined job matching the reviewed version', () => {
    const { store } = setup({ maxRunning: 1 })
    store.enqueue(input('one')); store.claim('one', 'owner')
    expect(() => store.recoverQuarantined('one', store.get('one')!.updatedAt)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    const reviewed = store.quarantine('one', 'unknown closure')
    const changed = store.quarantine('one', 'new evidence')
    expect(changed.updatedAt).toBeGreaterThan(reviewed.updatedAt)
    expect(() => store.recoverQuarantined('one', reviewed.updatedAt)).toThrow(expect.objectContaining({ code: 'STALE_ADMISSION' }))
    expect(store.snapshot().occupied).toBe(1)
    expect(store.recoverQuarantined('one', changed.updatedAt).status).toBe('interrupted')
    expect(store.snapshot()).toMatchObject({ occupied: 0, queued: 0 })
    expect(store.claim('one', 'owner')).toBeNull()
    expect(() => store.recoverQuarantined('one', changed.updatedAt)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
  })
  it('fails closed on structurally corrupted persisted admission state', () => {
    const { store, directory } = setup(); store.enqueue(input('one'))
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(join(directory, 'admission.sqlite'))
    try {
      const original = JSON.parse(db.prepare('SELECT state FROM host_admission WHERE id=1').get().state)
      for (const corrupt of [
        (state: any) => { delete state.limits.maxRunning },
        (state: any) => { state.limits.maxRunning = '2' },
        (state: any) => { state.jobs[0].status = 'unknown' },
        (state: any) => { state.jobs.push({ ...state.jobs[0] }) },
        (state: any) => { state.sequence = 1.5 },
        (state: any) => { state.jobs[0].metadata = [] },
      ]) {
        const state = structuredClone(original); corrupt(state)
        db.prepare('UPDATE host_admission SET state=? WHERE id=1').run(JSON.stringify(state))
        expect(() => store.claim('one', 'owner')).toThrow('Invalid host admission ledger')
        expect(() => new HostTaskAdmissionStore({ directory })).toThrow('Invalid host admission ledger')
      }
    } finally { db.close() }
  })
  it('keeps independent FIFO claimants waiting when their first attempt is out of order', async () => {
    const { store, directory } = setup({ maxQueued: 32 })
    await withAdmissionProcesses(store, async workers => {
      for (const [index, worker] of workers.entries()) {
        const reply = await worker.request('enqueue')
        expect(reply.result).toMatchObject({ jobId: String(index), sequence: index + 1, status: 'queued' })
      }
      // Reproduce the legal interleaving that broke the old one-shot fixture.
      for (const worker of workers.slice(1)) expect((await worker.request('claim')).result).toBeNull()
      expect((await workers[0]!.request('claim')).result?.jobId).toBe('0')
      expect(store.snapshot()).toMatchObject({ occupied: 1, queued: 5 })
      expect((await workers[1]!.request('claim')).result?.jobId).toBe('1')
      const repeated = await Promise.all(workers.map(worker => worker.request('claim')))
      expect(repeated.every(reply => reply.result === null)).toBe(true)
      expect(store.snapshot()).toMatchObject({ occupied: 2, queued: 4 })
    })
    const reopened = new HostTaskAdmissionStore({ directory }); stores.push(reopened)
    expect(reopened.snapshot()).toEqual(store.snapshot())
    expect(reopened.snapshot()).toMatchObject({ occupied: 2, queued: 4 })
  })
  it('serializes admissions from real independent processes', async () => {
    const { store, directory } = setup({ maxQueued: 32 })
    await withAdmissionProcesses(store, async workers => {
      await Promise.all(workers.map(worker => worker.request('enqueue')))
      const queued = store.list().sort((a, b) => a.sequence - b.sequence)
      expect(queued).toHaveLength(6)
      const claimed = new Set<string>()
      // Broadcast genuine concurrent claims. In each completed round at least
      // the FIFO head can advance; two rounds suffice to fill two slots.
      for (let round = 0; round < 2; round++) {
        const replies = await Promise.all(workers.filter((_, index) => !claimed.has(String(index))).map(worker => worker.request('claim')))
        for (const reply of replies) {
          expect(reply.snapshot.occupied).toBeLessThanOrEqual(2)
          expect(reply.snapshot.occupied + reply.snapshot.queued).toBe(6)
          if (reply.result) {
            expect(reply.result.status).toBe('starting')
            expect(claimed.has(reply.result.jobId)).toBe(false)
            claimed.add(reply.result.jobId)
          }
        }
      }
      expect([...claimed].sort()).toEqual(queued.slice(0, 2).map(job => job.jobId).sort())
      expect(claimed.size).toBe(2)
      expect(store.snapshot()).toMatchObject({ occupied: 2, queued: 4 })
      expect((await Promise.all(workers.map(worker => worker.request('claim')))).every(reply => reply.result === null)).toBe(true)
    })
    const reopened = new HostTaskAdmissionStore({ directory }); stores.push(reopened)
    expect(reopened.snapshot()).toEqual(store.snapshot())
    expect(reopened.snapshot()).toMatchObject({ occupied: 2, queued: 4 })
  })
})
