import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calendarScheduleSchema, nextCalendarOccurrence } from '../packages/server/src/scheduled-calendar.js'
import { ScheduledTaskStore, ScheduledTaskWorker } from '../packages/server/src/scheduled-tasks.js'
import { runScheduledCommand } from '../packages/cli/src/commands/scheduled.js'
import { parse } from '../packages/cli/src/bin.js'

const roots: string[] = []
const ts = (value: string) => Date.parse(value)
async function setup(at = '2026-11-08T00:00:00Z', bootId = 'boot-a') {
  const root = await mkdtemp(join(tmpdir(), 'pulse-calendar-')); roots.push(root)
  let clock = ts(at)
  const file = join(root, 'scheduled-tasks.json')
  const store = new ScheduledTaskStore(file, { now: () => clock, bootId })
  return { root, file, store, now: () => clock, setNow: (value: string) => { clock = ts(value) } }
}
const input = { name: 'calendar', instruction: 'Check status' }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks() })

describe('calendar occurrence calculation', () => {
  it('uses explicit IANA zones, including half and quarter hour offsets', () => {
    for (const [timeZone, expected] of [['Asia/Shanghai', '2026-11-08T01:00:00Z'], ['Asia/Kathmandu', '2026-11-08T03:15:00Z'], ['Australia/Adelaide', '2026-11-08T22:30:00Z']]) {
      expect(nextCalendarOccurrence({ kind: 'daily', time: '09:00', timeZone: timeZone! }, ts('2026-11-08T00:00:00Z'))).toBe(ts(expected!))
    }
  })
  it('skips nonexistent DST wall times and uses only the first repeated time', () => {
    const timeZone = 'America/New_York'
    expect(nextCalendarOccurrence({ kind: 'daily', time: '02:30', timeZone }, ts('2026-03-08T05:00:00Z'))).toBe(ts('2026-03-09T06:30:00Z'))
    const fold = { kind: 'daily' as const, time: '01:30', timeZone }
    expect(nextCalendarOccurrence(fold, ts('2026-11-01T00:00:00Z'))).toBe(ts('2026-11-01T05:30:00Z'))
    expect(nextCalendarOccurrence(fold, ts('2026-11-01T05:30:00Z'))).toBe(ts('2026-11-02T06:30:00Z'))
    expect(nextCalendarOccurrence({ kind: 'once', date: '2026-03-08', time: '02:30', timeZone }, ts('2026-03-07T00:00:00Z'))).toBeUndefined()
  })
  it('handles weekly DST boundaries, non-hour transitions, and skipped civil dates', () => {
    expect(nextCalendarOccurrence({ kind: 'weekly', days: [0], time: '02:30', timeZone: 'America/New_York' }, ts('2026-03-08T00:00:00Z'))).toBe(ts('2026-03-15T06:30:00Z'))
    expect(nextCalendarOccurrence({ kind: 'weekly', days: [1], time: '10:00', timeZone: 'Asia/Shanghai' }, ts('2026-11-08T00:00:00Z'))).toBe(ts('2026-11-09T02:00:00Z'))
    expect(nextCalendarOccurrence({ kind: 'daily', time: '02:15', timeZone: 'Australia/Lord_Howe' }, ts('2026-10-03T12:00:00Z'))).toBe(ts('2026-10-04T15:15:00Z'))
    expect(nextCalendarOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Pacific/Apia' }, ts('2011-12-29T20:00:00Z'))).toBe(ts('2011-12-30T19:00:00Z'))
  })
  it('rejects malformed times, dates, zones, and duplicate/invalid weekdays', () => {
    for (const schedule of [
      { kind: 'once', date: '2027-02-29', time: '09:00', timeZone: 'UTC' },
      { kind: 'daily', time: '24:00', timeZone: 'UTC' },
      { kind: 'daily', time: '09:00', timeZone: 'Mars/Olympus' },
      { kind: 'weekly', days: [1, 1], time: '09:00', timeZone: 'UTC' },
      { kind: 'weekly', days: [7], time: '09:00', timeZone: 'UTC' },
    ]) expect(calendarScheduleSchema.safeParse(schedule).success).toBe(false)
  })
})

describe('durable calendar scheduling', () => {
  it('runs one-shot tasks once across repeated polls, restart and pause/resume', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'once', date: '2026-11-08', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-08T01:00:00Z')
    const execute = vi.fn(async () => {})
    const worker = new ScheduledTaskWorker(f.store, execute)
    expect(await worker.runOnce()).toMatchObject({ succeeded: 1 })
    expect(await worker.runOnce()).toMatchObject({ claimed: 0 })
    const restart = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-b' })
    expect(await restart.pause(task.id, false)).toMatchObject({ completed: true })
    expect(await new ScheduledTaskWorker(restart, execute).runOnce()).toMatchObject({ claimed: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('skips offline occurrences by default, records why, and never drains a backlog', async () => {
    const f = await setup()
    const daily = await f.store.create({ ...input, schedule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } })
    const once = await f.store.create({ ...input, schedule: { kind: 'once', date: '2026-11-08', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-12T05:00:00Z')
    expect(await f.store.claimDue()).toEqual([])
    expect(await f.store.get(daily.id)).toMatchObject({ nextRunAt: ts('2026-11-13T01:00:00Z'), runCount: 0, lastSkipped: { scheduledFor: ts('2026-11-08T01:00:00Z') } })
    expect(await f.store.get(once.id)).toMatchObject({ completed: true, runCount: 0 })
  })
  it('retains the current occurrence within the 60 second grace after skipping older offline dates', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-12T01:00:30Z')
    const [claim] = await f.store.claimDue()
    expect(claim).toMatchObject({ id: task.id, run: { scheduledFor: ts('2026-11-12T01:00:00Z') }, nextRunAt: ts('2026-11-13T01:00:00Z') })
  })
  it('does not duplicate a fold occurrence after reboot or a backward clock change', async () => {
    const f = await setup('2026-11-01T00:00:00Z')
    const task = await f.store.create({ ...input, schedule: { kind: 'daily', time: '01:30', timeZone: 'America/New_York' } })
    f.setNow('2026-11-01T05:30:00Z')
    const [claim] = await f.store.claimDue()
    await f.store.finish(task.id, claim!.run!.id, 'succeeded')
    const reboot = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-b' })
    f.setNow('2026-11-01T04:30:00Z')
    expect(await reboot.claimDue()).toEqual([])
    f.setNow('2026-11-01T06:30:00Z')
    expect(await reboot.claimDue()).toEqual([])
    expect(await reboot.get(task.id)).toMatchObject({ runCount: 1, nextRunAt: ts('2026-11-02T06:30:00Z') })
  })
  it('keeps ambiguous legacy owners blocked when no matching boot identity is available', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-08T01:00:00Z')
    await f.store.claimDue()
    const document = JSON.parse(await readFile(f.file, 'utf8'))
    delete document.tasks[0].run.ownerBootId
    await writeFile(f.file, JSON.stringify(document))
    const reboot = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-b', isProcessAlive: () => true })
    expect(await reboot.claimDue()).toEqual([])
    expect((await reboot.get(task.id))?.run).toBeDefined()
  })
  it('permits an explicit single catch-up and keeps the recurring wall clock', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, missedRun: 'run-once', schedule: { kind: 'weekly', days: [1], time: '10:00', timeZone: 'Asia/Shanghai' } })
    f.setNow('2026-12-01T00:00:00Z')
    const execute = vi.fn(async () => {})
    await new ScheduledTaskWorker(f.store, execute).runOnce()
    expect(await f.store.get(task.id)).toMatchObject({ nextRunAt: ts('2026-12-07T02:00:00Z'), runCount: 1 })
    expect(await f.store.claimDue()).toEqual([])
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('recovers a reboot even when the old PID is reused without retrying side effects', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'once', date: '2026-11-08', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-08T01:00:00Z')
    const [claimed] = await f.store.claimDue()
    expect(claimed?.run?.ownerBootId).toBe('boot-a')
    const restart = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-b', isProcessAlive: () => true })
    expect(await restart.get(task.id)).toMatchObject({ completed: true, lastRun: { status: 'interrupted' } })
    expect(await restart.claimDue()).toEqual([])
  })
  it('recovers a reboot-stale file lock while failing closed for same-boot claims', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-08T01:00:00Z')
    await f.store.claimDue()
    const sameBoot = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-a', isProcessAlive: () => true })
    f.setNow('2026-11-09T01:00:00Z')
    expect(await sameBoot.claimDue()).toEqual([])
    await writeFile(`${f.file}.lock`, JSON.stringify({ pid: process.pid, token: 'old', bootId: 'boot-a' }))
    const reboot = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-b', isProcessAlive: () => true })
    expect(await reboot.get(task.id)).toMatchObject({ lastRun: { status: 'interrupted' }, nextRunAt: ts('2026-11-10T01:00:00Z') })
  })
  it('deduplicates competing workers and rejects late completions', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-08T01:00:00Z')
    const peer = new ScheduledTaskStore(f.file, { now: f.now, bootId: 'boot-a' })
    const results = await Promise.all([f.store.claimDue(), peer.claimDue()])
    expect(results.flat()).toHaveLength(1)
    const claim = results.flat()[0]!
    await f.store.finish(task.id, claim.run!.id, 'succeeded')
    await expect(peer.finish(task.id, claim.run!.id, 'succeeded')).rejects.toMatchObject({ code: 'SCHEDULED_TASK_RUN_MISMATCH' })
  })
  it('defers one-shot admission for updates without consuming it', async () => {
    const f = await setup()
    const task = await f.store.create({ ...input, schedule: { kind: 'once', date: '2026-11-08', time: '01:00', timeZone: 'UTC' } })
    f.setNow('2026-11-08T01:00:00Z')
    const [claim] = await f.store.claimDue()
    await f.store.deferForUpdate(task.id, claim!.run!.id)
    expect((await f.store.claimDue())[0]).toMatchObject({ id: task.id, runCount: 1 })
  })
  it('rejects ambiguous schedule inputs, past dates and nonexistent one-shot times', async () => {
    const f = await setup('2026-03-07T00:00:00Z')
    await expect(f.store.create({ ...input, intervalMs: 1000, schedule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } })).rejects.toMatchObject({ code: 'INVALID_SCHEDULED_TASK_INPUT' })
    for (const date of ['2026-03-06', '2026-03-08']) {
      await expect(f.store.create({ ...input, schedule: { kind: 'once', date, time: '02:30', timeZone: 'America/New_York' } })).rejects.toMatchObject({ code: 'SCHEDULE_DATE_PAST_OR_NONEXISTENT' })
    }
  })
})

describe('calendar CLI', () => {
  it('creates all calendar kinds through the real flag parser and lists persisted details', async () => {
    const f = await setup()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    for (const flags of [
      ['--at', '2090-11-09T10:00'], ['--daily', '10:00'], ['--weekly', 'mon,wed', '--time', '10:00'],
    ]) {
      const parsed = parse(['schedule', 'add', ...flags, '--timezone', 'Asia/Shanghai', '--missed-run', 'run-once', 'Check status'])
      expect(await runScheduledCommand({ cwd: f.root, dataDir: f.root }, parsed.positionals, parsed.options)).toBe(0)
    }
    const tasks = await f.store.list()
    expect(tasks.map(task => task.schedule?.kind)).toEqual(expect.arrayContaining(['once', 'daily', 'weekly']))
    expect(tasks.every(task => task.missedRun === 'run-once' && task.schedule?.timeZone === 'Asia/Shanghai')).toBe(true)
    expect(JSON.parse(await readFile(f.file, 'utf8')).tasks).toHaveLength(3)
  })
  it('executes a persisted one-shot through the real CLI worker and does not repeat it', async () => {
    const f = await setup()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runScheduledCommand({ cwd: f.root, dataDir: f.root }, ['add', 'Write the scheduled report'], { at: '2090-11-09T10:00', timezone: 'Asia/Shanghai' })
    // Isolate the due instant without waiting or touching user task records.
    const document = JSON.parse(await readFile(f.file, 'utf8'))
    document.tasks[0].nextRunAt = Date.now() - 1000
    await writeFile(f.file, JSON.stringify(document))
    const options = { cwd: f.root, dataDir: f.root, approvalMode: 'auto' as const, mockToolCalls: [{ name: 'fs.write', input: { path: 'scheduled-report.txt', content: 'one-shot output' } }], mockAfterToolResponse: 'Created scheduled-report.txt with one-shot output.', mockTaskAssessments: [{ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'The report file receipt confirms the write.' }] }] }
    const result = await runScheduledCommand(options, ['run-once'], {})
    expect(result, JSON.stringify(await f.store.list())).toBe(0)
    expect(await readFile(join(f.root, 'scheduled-report.txt'), 'utf8')).toBe('one-shot output')
    expect(await runScheduledCommand(options, ['run-once'], {})).toBe(0)
    expect((await f.store.list())[0]).toMatchObject({ completed: true, runCount: 1, lastRun: { status: 'succeeded' } })
  })
  it('requires a zone and exactly one schedule, and rejects invalid calendar options', async () => {
    const f = await setup()
    for (const flags of [{ daily: '10:00' }, { daily: '10:00', every: '1h', timezone: 'UTC' }, { weekly: 'monday', time: '10:00', timezone: 'UTC' }, { every: '1h', timezone: 'UTC' }, { at: '2090-11-09T10:00Z', timezone: 'UTC' }, { daily: '10:00', timezone: 'UTC', 'missed-run': 'replay' }]) {
      await expect(runScheduledCommand({ cwd: f.root, dataDir: f.root }, ['add', 'Check'], flags)).rejects.toThrow()
    }
    expect(await f.store.list()).toEqual([])
  })
})
