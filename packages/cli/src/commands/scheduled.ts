import { realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createLocalHost, MAX_SCHEDULED_TASK_INTERVAL_MS, MIN_SCHEDULED_TASK_INTERVAL_MS, ScheduledTaskStore, ScheduledTaskWorker, pulseDataPath, type LocalHostOptions } from '@hunterzhu/pulse-server'

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
    const task = await store.create({ workspace: await realpath(resolve(options.cwd ?? process.cwd())), name: name ?? instruction.slice(0, 120), instruction, intervalMs: parseInterval(typeof flags.every === 'string' ? flags.every : undefined) })
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

  const host = createLocalHost(options)
  await host.init()
  let currentRun: Awaited<ReturnType<typeof host.sendMessage>> | undefined
  const worker = new ScheduledTaskWorker(store, async (task, signal) => {
    if (signal.aborted) throw Object.assign(new Error('SCHEDULED_RUN_ABORTED'), { code: 'SCHEDULED_RUN_ABORTED' })
    if (!task.workspace) throw new Error('SCHEDULED_TASK_WORKSPACE_REQUIRED: recreate this legacy task')
    const conversation = await host.createConversation({ cwd: task.workspace, title: `Scheduled: ${task.name}` })
    const run = await host.sendMessage(conversation.id, { text: task.instruction })
    currentRun = run
    const abort = (): void => { void run.cancel('SCHEDULED_WORKER_STOPPING').catch(() => {}) }
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
    await host.close()
  }
  return runOnceSummary && runOnceSummary.failed > 0 ? 1 : 0
}
