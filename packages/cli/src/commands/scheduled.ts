import { realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createLocalHost, MAX_SCHEDULED_TASK_INTERVAL_MS, MIN_SCHEDULED_TASK_INTERVAL_MS, ScheduledTaskStore, ScheduledTaskWorker, pulseDataPath, type LocalHostOptions, type CreateScheduledTaskInput } from '@hunterzhu/pulse-server'

function parseInterval(raw: string | undefined): number {
  if (!raw) throw new Error('SCHEDULE_EVERY_REQUIRED')
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(raw.trim())
  if (!match) throw new Error('INVALID_SCHEDULE_INTERVAL: use 30s, 15m, 2h, or 1d')
  const value = Number(match[1])
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000
  const intervalMs = value * multiplier
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_SCHEDULED_TASK_INTERVAL_MS || intervalMs > MAX_SCHEDULED_TASK_INTERVAL_MS) throw new Error('SCHEDULE_INTERVAL_OUT_OF_RANGE')
  return intervalMs
}

function scheduleFromFlags(flags: Record<string, string | boolean>): Pick<CreateScheduledTaskInput, 'intervalMs' | 'schedule' | 'missedRun'> {
  const kinds = ['every', 'at', 'daily', 'weekly'].filter(key => flags[key] !== undefined)
  if (kinds.length !== 1) throw new Error('SCHEDULE_KIND_REQUIRED: choose exactly one of --every, --at, --daily, --weekly')
  const kind = kinds[0]!
  const value = flags[kind]
  if (typeof value !== 'string') throw new Error('SCHEDULE_VALUE_REQUIRED')
  const missedRun = flags['missed-run']
  if (missedRun !== undefined && missedRun !== 'skip' && missedRun !== 'run-once') throw new Error('INVALID_MISSED_RUN_POLICY')
  if (kind === 'every') {
    if (flags.time !== undefined || flags.timezone !== undefined || missedRun !== undefined) throw new Error('SCHEDULE_CALENDAR_OPTIONS_REQUIRE_CALENDAR')
    return { intervalMs: parseInterval(value) }
  }
  const timeZone = flags.timezone
  if (typeof timeZone !== 'string') throw new Error('SCHEDULE_TIMEZONE_REQUIRED: use an IANA zone such as Asia/Shanghai')
  const policy = missedRun === 'run-once' ? 'run-once' : 'skip'
  if (kind === 'at') {
    if (flags.time !== undefined) throw new Error('SCHEDULE_AT_INCLUDES_TIME')
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
    if (!match) throw new Error('INVALID_SCHEDULE_AT: use YYYY-MM-DDTHH:mm with --timezone')
    return { schedule: { kind: 'once', date: match[1]!, time: match[2]!, timeZone }, missedRun: policy }
  }
  if (kind === 'daily') {
    if (flags.time !== undefined) throw new Error('SCHEDULE_DAILY_INCLUDES_TIME')
    return { schedule: { kind: 'daily', time: value, timeZone }, missedRun: policy }
  }
  if (typeof flags.time !== 'string') throw new Error('SCHEDULE_WEEKLY_TIME_REQUIRED')
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const days = value.toLowerCase().split(',').map(day => names.indexOf(day.trim()))
  if (days.some(day => day < 0)) throw new Error('INVALID_SCHEDULE_DAYS: use mon,wed,fri')
  return { schedule: { kind: 'weekly', days, time: flags.time, timeZone }, missedRun: policy }
}

function storeFor(options: LocalHostOptions): ScheduledTaskStore {
  return new ScheduledTaskStore(join(resolve(options.dataDir ?? pulseDataPath()), 'scheduled-tasks.json'))
}

function output(value: unknown, format: string): void {
  process.stdout.write(format === 'jsonl' ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`)
}

export async function runScheduledCommand(options: LocalHostOptions, args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [action, id] = args
  if (!action) throw new Error('SCHEDULE_ACTION_REQUIRED')
  const store = storeFor(options)
  if (action === 'add') {
    const name = typeof flags.name === 'string' ? flags.name : undefined
    const instruction = args.slice(1).join(' ').trim()
    if (!instruction) throw new Error('SCHEDULE_TASK_REQUIRED')
    const task = await store.create({ workspace: await realpath(resolve(options.cwd ?? process.cwd())), name: name ?? instruction.slice(0, 120), instruction, ...scheduleFromFlags(flags) })
    output(task, typeof flags.format === 'string' ? flags.format : 'text')
    return 0
  }
  if (action === 'list') {
    output(await store.list(), typeof flags.format === 'string' ? flags.format : 'text')
    return 0
  }
  if (action === 'recover') {
    if (!id) throw new Error('SCHEDULE_RECOVER_REQUIRES_ID')
    if (flags['confirm-stopped'] !== true) throw new Error('SCHEDULE_RECOVER_REQUIRES_CONFIRMATION: stop the worker and child processes, then pass --confirm-stopped')
    const task = await store.get(id)
    if (!task?.run?.quarantined) throw new Error(`SCHEDULED_TASK_NOT_QUARANTINED:${id}`)
    const recovered = await store.recoverQuarantined(id, task.run.id)
    if (!recovered) throw new Error('SCHEDULED_TASK_RECOVERY_RACE')
    output(recovered, typeof flags.format === 'string' ? flags.format : 'text')
    return 0
  }
  if (action === 'pause' || action === 'resume' || action === 'remove') {
    if (!id) throw new Error(`SCHEDULE_${action.toUpperCase()}_REQUIRES_ID`)
    const result = action === 'remove' ? await store.remove(id) : await store.pause(id, action === 'pause')
    if (!result) throw new Error(`SCHEDULED_TASK_NOT_FOUND:${id}`)
    output(result, typeof flags.format === 'string' ? flags.format : 'text')
    return 0
  }
  if (action !== 'daemon' && action !== 'run-once') throw new Error(`UNKNOWN_SCHEDULE_ACTION:${action}`)
  if (options.approvalMode !== 'read-only' && options.approvalMode !== 'auto') throw new Error('SCHEDULED_EXECUTION_REQUIRES_READ_ONLY_OR_AUTO_APPROVAL')

  let currentHost: ReturnType<typeof createLocalHost> | undefined
  let currentRun: Awaited<ReturnType<ReturnType<typeof createLocalHost>['sendMessage']>> | undefined
  const worker = new ScheduledTaskWorker(store, async (task, signal) => {
    if (signal.aborted) throw Object.assign(new Error('SCHEDULED_RUN_ABORTED'), { code: 'SCHEDULED_RUN_ABORTED' })
    if (!task.workspace) throw new Error('SCHEDULED_TASK_WORKSPACE_REQUIRED: recreate this legacy task')
    const host = currentHost = createLocalHost(options)
    let run: Awaited<ReturnType<typeof host.sendMessage>> | undefined
    try {
    await host.init()
    const conversation = await host.createConversation({ cwd: task.workspace, title: `Scheduled: ${task.name}` })
    run = await host.sendMessage(conversation.id, { text: task.instruction })
    currentRun = run
    const ownedRun = run
    const abort = (): void => { void ownedRun.cancel('SCHEDULED_WORKER_STOPPING').catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      for await (const _event of run.events) {
        if (signal.aborted) { await run.cancel('SCHEDULED_WORKER_STOPPING'); throw Object.assign(new Error('SCHEDULED_RUN_ABORTED'), { code: 'SCHEDULED_RUN_ABORTED' }) }
      }
      const outcome = await run.outcome()
      const taskOutcome = await run.taskOutcome()
      if (signal.aborted) throw new Error('SCHEDULED_RUN_ABORTED')
      if (outcome.status !== 'succeeded') throw Object.assign(new Error(`RUNTIME_${outcome.status.toUpperCase()}`), { code: `RUNTIME_${outcome.status.toUpperCase()}` })
      if (taskOutcome?.status !== 'accepted') throw Object.assign(new Error(`TASK_${(taskOutcome?.status ?? 'unverified').toUpperCase()}`), { code: `TASK_${(taskOutcome?.status ?? 'unverified').toUpperCase()}` })
    } catch (error) {
      // Runtime cancellation may settle before an uncooperative tool stops.
      // Keep the durable claim until this worker process has exited.
      if (signal.aborted) throw Object.assign(new Error('SCHEDULED_TASK_CANCELLATION_UNCONFIRMED'), { code: 'SCHEDULED_TASK_CANCELLATION_UNCONFIRMED', cause: error })
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      if (currentRun === run) currentRun = undefined
    }
    } finally { await host.close(); if (currentHost === host) currentHost = undefined }
  })
  const controller = new AbortController()
  const stop = (): void => { controller.abort(); void currentRun?.cancel('SCHEDULED_WORKER_STOPPING') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let runOnceSummary: Awaited<ReturnType<typeof worker.runOnce>> | undefined
  try {
    if (action === 'run-once') { runOnceSummary = await worker.runOnce(controller.signal); output(runOnceSummary, typeof flags.format === 'string' ? flags.format : 'text') }
    else await worker.start(controller.signal)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await currentHost?.close()
  }
  return runOnceSummary && runOnceSummary.failed > 0 ? 1 : 0
}
