import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTaskStore, ScheduledTaskWorker } from '../packages/server/src/scheduled-tasks.js'

const roots: string[] = []

async function setup(now = 10_000, isProcessAlive?: (pid: number) => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-scheduled-tasks-'))
  roots.push(root)
  let clock = now
  const file = join(root, 'nested', 'tasks.json')
  const store = new ScheduledTaskStore(file, { now: () => clock, ...(isProcessAlive ? { isProcessAlive } : {}) })
  return { root, file, store, setNow: (value: number) => { clock = value } }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ScheduledTaskStore', () => {
  it('persists validated tasks and supports list, pause, resume, and remove', async () => {
    const { root, file, store } = await setup()
    const task = await store.create({ name: 'daily check', instruction: 'Check project health', intervalMs: 1_000 })
    expect(task.nextRunAt).toBe(11_000)
    expect(await new ScheduledTaskStore(file).get(task.id)).toMatchObject({ id: task.id, name: 'daily check' })
    expect(await store.pause(task.id)).toMatchObject({ paused: true })
    expect(await store.pause(task.id, false)).toMatchObject({ paused: false })
    expect(await store.list()).toHaveLength(1)
    expect(await store.remove(task.id)).toBe(true)
    expect(await store.list()).toEqual([])
    expect((await readdir(join(root, 'nested'))).some((name) => name.includes('.tmp-'))).toBe(false)
    expect((await readdir(join(root, 'nested'))).some((name) => name.endsWith('.lock'))).toBe(false)
  })

  it('rejects invalid intervals and malformed inputs before persistence', async () => {
    const { store } = await setup()
    await expect(store.create({ name: 'bad', instruction: 'x', intervalMs: 0 })).rejects.toMatchObject({ code: 'INVALID_SCHEDULED_TASK_INPUT' })
    await expect(store.create({ name: 'bad', instruction: 'x', intervalMs: 1_000, extra: true } as never)).rejects.toMatchObject({ code: 'INVALID_SCHEDULED_TASK_INPUT' })
    expect(await store.list()).toEqual([])
  })

  it('runs only when due, records success and advances from the interval cadence', async () => {
    const { store, setNow } = await setup()
    const task = await store.create({ name: 'poll', instruction: 'Inspect', intervalMs: 1_000 })
    const runs: string[] = []
    const worker = new ScheduledTaskWorker(store, async (claimed) => { runs.push(claimed.id) })
    setNow(10_999)
    expect(await worker.runOnce()).toMatchObject({ claimed: 0 })
    setNow(11_000)
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 })
    expect(runs).toEqual([task.id])
    expect(await store.get(task.id)).toMatchObject({ runCount: 1, nextRunAt: 12_000, lastRun: { status: 'succeeded' } })
    setNow(12_000)
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 })
  })

  it('records failures and keeps the next interval scheduled', async () => {
    const { store, setNow } = await setup()
    const task = await store.create({ name: 'fail once', instruction: 'Run', intervalMs: 1_000 })
    const worker = new ScheduledTaskWorker(store, async () => { throw new Error('request failed API_KEY=hidden') })
    setNow(11_000)
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, failed: 1 })
    const afterFailure = await store.get(task.id)
    expect(afterFailure?.lastRun).toMatchObject({ status: 'failed', error: { message: 'request failed API_KEY=[REDACTED]' } })
    expect(afterFailure?.nextRunAt).toBe(12_000)
    setNow(12_000)
    expect(await new ScheduledTaskWorker(store, async () => undefined).runOnce()).toMatchObject({ claimed: 1, succeeded: 1 })
  })

  it('recovers an abandoned claim after a worker process exits', async () => {
    const { file, store, setNow } = await setup(10_000)
    const task = await store.create({ name: 'recover', instruction: 'Run', intervalMs: 1_000 })
    setNow(11_000)
    const [claimed] = await store.claimDue()
    expect(claimed?.run).toBeDefined()
    const restarted = new ScheduledTaskStore(file, { now: () => 11_500, isProcessAlive: () => false })
    expect(await restarted.get(task.id)).toMatchObject({ runCount: 1, lastRun: { status: 'interrupted', error: { code: 'WORKER_PROCESS_EXITED' } }, nextRunAt: 12_000 })
  })

  it('serializes mutations from separate store instances on the shared file', async () => {
    const { file, store } = await setup()
    const peer = new ScheduledTaskStore(file)
    const created = await Promise.all([
      store.create({ name: 'first', instruction: 'Run', intervalMs: 1_000 }),
      peer.create({ name: 'second', instruction: 'Run', intervalMs: 1_000 }),
    ])
    expect(new Set(created.map((task) => task.id)).size).toBe(2)
    expect((await store.list()).map((task) => task.name).sort()).toEqual(['first', 'second'])
  })

  it('deduplicates concurrent worker polls and rejects corrupt persisted schemas', async () => {
    const { store, setNow } = await setup()
    const task = await store.create({ name: 'one', instruction: 'Run', intervalMs: 1_000 })
    setNow(11_000)
    let calls = 0
    const worker = new ScheduledTaskWorker(store, async () => { calls++ })
    const summaries = await Promise.all([worker.runOnce(), worker.runOnce()])
    expect(summaries.reduce((total, summary) => total + summary.claimed, 0)).toBe(1)
    expect(calls).toBe(1)
    expect(await store.get(task.id)).toMatchObject({ runCount: 1 })

    const invalid = await setup()
    await invalid.store.create({ name: 'valid', instruction: 'Run', intervalMs: 1_000 })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(invalid.file, JSON.stringify({ schemaVersion: 999, tasks: [] }))
    await expect(invalid.store.list()).rejects.toMatchObject({ code: 'SCHEDULED_TASK_STORE_SCHEMA_INVALID' })
  })

  it('replaces existing stores with a Windows-style no-overwrite rename primitive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-scheduled-windows-rename-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    const windowsRename: typeof rename = async (source, destination) => {
      if (await stat(destination).then(() => true, () => false)) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' })
      return rename(source, destination)
    }
    const store = new ScheduledTaskStore(file, { renameFile: windowsRename })
    const task = await store.create({ name: 'replace', instruction: 'Run', intervalMs: 1_000 })
    await expect(store.pause(task.id)).resolves.toMatchObject({ paused: true })
    await expect(store.pause(task.id, false)).resolves.toMatchObject({ paused: false })
  })

  it('retains expired live-owner claims and prevents removal or concurrent reclaim', async () => {
    const { store, setNow } = await setup()
    await store.create({ name: 'first', instruction: 'Run', intervalMs: 1_000 })
    await store.create({ name: 'second', instruction: 'Run', intervalMs: 1_000 })
    await expect(store.claimDue(2)).rejects.toMatchObject({ code: 'INVALID_SCHEDULED_TASK_CLAIM_LIMIT' })
    setNow(11_000)
    const [first] = await store.claimDue()
    expect(first?.run).toBeDefined()
    setNow(72_000)
    expect(await store.claimDue()).toEqual([])
    await expect(store.remove(first!.id)).rejects.toMatchObject({ code: 'SCHEDULED_TASK_STILL_RUNNING' })
    expect((await store.get(first!.id))?.run?.id).toBe(first!.run?.id)
  })

  it('aborts and records a timed-out scheduled executor', async () => {
    const { store, setNow } = await setup()
    await store.create({ name: 'hang', instruction: 'Run', intervalMs: 1_000 })
    setNow(11_000)
    const worker = new ScheduledTaskWorker(store, async (_task, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), { executionTimeoutMs: 100 })
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 })
    await expect(store.list()).resolves.toMatchObject([{ lastRun: { status: 'failed', error: { code: 'SCHEDULED_TASK_EXECUTION_TIMEOUT' } } }])
  })

  it('waits for delayed cancellation before allowing the next task', async () => {
    const { store, setNow } = await setup()
    await store.create({ name: 'first', instruction: 'Run', intervalMs: 1000 })
    setNow(10001)
    await store.create({ name: 'second', instruction: 'Run', intervalMs: 1000 })
    setNow(11001)
    let active = false
    let overlap = false
    const worker = new ScheduledTaskWorker(store, async (task) => {
      if (task.name === 'first') { active = true; await new Promise(resolve => setTimeout(resolve, 150)); active = false }
      else overlap = active
    }, { executionTimeoutMs: 100, cancellationGraceMs: 200 })
    expect(await worker.runOnce()).toEqual({ claimed: 2, succeeded: 1, failed: 1 })
    expect(overlap).toBe(false)
  })

  it('quarantines unconfirmed cancellation, including late writes and later workers', async () => {
    const { store, file, setNow } = await setup()
    const first = await store.create({ name: 'first', instruction: 'Run', intervalMs: 1000 })
    setNow(10001)
    await store.create({ name: 'second', instruction: 'Run', intervalMs: 1000 })
    setNow(11001)
    let release!: () => void
    let lateWrite = false
    const worker = new ScheduledTaskWorker(store, async () => {
      await new Promise<void>(resolve => { release = resolve })
      lateWrite = true
    }, { executionTimeoutMs: 100, cancellationGraceMs: 10 })
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' })
    setNow(100000)
    expect(await store.claimDue()).toEqual([])
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lateWrite).toBe(true)
    expect((await store.get(first.id))?.run).toBeDefined()
    expect(await new ScheduledTaskWorker(store, async () => { throw new Error('must not execute') }).runOnce()).toEqual({ claimed: 0, succeeded: 0, failed: 0 })
    const deadOwner = new ScheduledTaskStore(file, { now: () => 100000, isProcessAlive: () => false })
    expect((await deadOwner.get(first.id))?.run).toMatchObject({ quarantined: true })
    await expect(deadOwner.claimDue()).resolves.toEqual([])
    const quarantined = (await deadOwner.get(first.id))?.run
    expect(quarantined).toBeDefined()
    const recovered = await deadOwner.recoverQuarantined(first.id, quarantined!.id)
    expect(recovered?.lastRun).toMatchObject({ status: 'interrupted', error: { code: 'OPERATOR_RECOVERED_QUARANTINED_RUN' } })
  })

  it('retains ownership when lease renewal fails and cancellation hangs', async () => {
    const { store, setNow } = await setup()
    await store.create({ name: 'lease failure', instruction: 'Run', intervalMs: 1000 })
    setNow(11000)
    vi.useFakeTimers()
    const renew = vi.spyOn(store, 'renew').mockRejectedValue(new Error('disk unavailable'))
    try {
      let started!: () => void
      const ready = new Promise<void>(resolve => { started = resolve })
      const worker = new ScheduledTaskWorker(store, async () => { started(); return new Promise(() => {}) }, { executionTimeoutMs: 60000, cancellationGraceMs: 10 })
      const pending = worker.runOnce()
      const assertion = expect(pending).rejects.toMatchObject({ code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' })
      await ready
      await vi.advanceTimersByTimeAsync(20020)
      await assertion
      expect(renew).toHaveBeenCalled()
      expect((await store.list())[0]?.run).toBeDefined()
    } finally { vi.useRealTimers(); renew.mockRestore() }
  })

  it('retains claims when an executor reports detached effects after settling', async () => {
    const { store, setNow } = await setup()
    await store.create({ name: 'detached', instruction: 'Run', intervalMs: 1000 })
    setNow(11000)
    const worker = new ScheduledTaskWorker(store, async () => { throw Object.assign(new Error('still cancelling'), { code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' }) })
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' })
    expect((await store.list())[0]?.run).toBeDefined()
  })

  it('preserves an unconfirmed-cancellation error arriving during the grace period', async () => {
    const { store, setNow } = await setup()
    await store.create({ name: 'late cancellation report', instruction: 'Run', intervalMs: 1000 })
    setNow(11000)
    const worker = new ScheduledTaskWorker(store, async (_task, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('tools still running'), { code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' })), 10), { once: true })
    }), { executionTimeoutMs: 100, cancellationGraceMs: 200 })
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED' })
    expect((await store.list())[0]?.run).toBeDefined()
  })

})
