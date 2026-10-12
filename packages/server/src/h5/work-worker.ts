import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { JsonValue, Outcome } from '@hunterzhu/pulse-runtime'
import type { AssistantEvent, LocalHost, LocalHostOptions, RunHandle, RunUsage, TaskOutcome } from '../index.js'

export const H5_WORKER_PROTOCOL_VERSION = 1 as const

type WorkerStart = { schemaVersion: 1; type: 'start'; requestId: string; conversationId: string; text: string; resume: boolean }
type WorkerConfigure = { schemaVersion: 1; type: 'configure'; runtimeOptions: WorkWorkerRuntimeOptions }
type WorkerRpc = { schemaVersion: 1; type: 'rpc'; requestId: string; method: 'cancel' | 'reply' | 'replyBatch' | 'pendingInteractions' | 'reviewApproval' | 'submitHumanInput'; args: unknown[] }
type WorkerShutdown = { schemaVersion: 1; type: 'shutdown' }
type ParentMessage = WorkerConfigure | WorkerStart | WorkerRpc | WorkerShutdown

type WorkerReady = { schemaVersion: 1; type: 'ready' } | { schemaVersion: 1; type: 'configured' }
type WorkerStarted = { schemaVersion: 1; type: 'started'; requestId: string; runId: string; conversationId: string }
type WorkerEvent = { schemaVersion: 1; type: 'event'; event: AssistantEvent }
type WorkerRpcResult = { schemaVersion: 1; type: 'rpcResult'; requestId: string; ok: true; value?: unknown } | { schemaVersion: 1; type: 'rpcResult'; requestId: string; ok: false; error: string }
type WorkerSettled = { schemaVersion: 1; type: 'settled'; outcome: Outcome & { text?: string }; usage: RunUsage; taskOutcome?: TaskOutcome }
type WorkerFatal = { schemaVersion: 1; type: 'fatal'; message: string }
type WorkerMessage = WorkerReady | WorkerStarted | WorkerEvent | WorkerRpcResult | WorkerSettled | WorkerFatal

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isObject(value) || value.schemaVersion !== H5_WORKER_PROTOCOL_VERSION || typeof value.type !== 'string') return false
  if (value.type === 'ready' || value.type === 'configured') return true
  if (value.type === 'settled') return isObject(value.outcome) && ['succeeded', 'failed', 'cancelled'].includes(String(value.outcome.status)) && isObject(value.usage) && value.usage.schemaVersion === 1 && Number.isInteger(value.usage.modelCalls)
  if (value.type === 'fatal') return typeof value.message === 'string'
  if (value.type === 'started') return typeof value.requestId === 'string' && typeof value.runId === 'string' && typeof value.conversationId === 'string'
  if (value.type === 'event') return isObject(value.event) && value.event.schemaVersion === 1 && typeof value.event.runId === 'string' && typeof value.event.conversationId === 'string' && Number.isFinite(value.event.seq) && typeof value.event.type === 'string'
  if (value.type === 'rpcResult') return typeof value.requestId === 'string' && typeof value.ok === 'boolean' && (value.ok || typeof value.error === 'string')
  return false
}

class EventQueue implements AsyncIterable<AssistantEvent>, AsyncIterator<AssistantEvent> {
  private values: AssistantEvent[] = []
  private waiters: Array<{ resolve: (value: IteratorResult<AssistantEvent>) => void; reject: (error: Error) => void }> = []
  private ended = false
  private failure: Error | undefined
  [Symbol.asyncIterator](): AsyncIterator<AssistantEvent> { return this }
  next(): Promise<IteratorResult<AssistantEvent>> {
    const value = this.values.shift()
    if (value) return Promise.resolve({ done: false, value })
    if (this.failure) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  push(value: AssistantEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else this.values.push(value)
  }
  close(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }
  fail(error: Error): void {
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface H5WorkWorkerLaunchOptions {
  entry: string
  dataDir: string
  configPath?: string
  approvalMode: LocalHostOptions['approvalMode']
  trustWorkspace?: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  /** Captured for this Run and sent through the private IPC channel, never argv. */
  runtimeOptions?: WorkWorkerRuntimeOptions
}

export type WorkWorkerRuntimeOptions = Omit<LocalHostOptions, 'capabilityPacks' | 'jarvisClient'>

/** Starts one isolated Pulse CLI process and adapts its versioned IPC to RunHandle. */
export async function startH5WorkWorker(
  options: H5WorkWorkerLaunchOptions,
  input: { conversationId: string; text: string; resume?: boolean }
): Promise<RunHandle> {
  const args = ['h5', 'work-worker', input.conversationId, '--data-dir', options.dataDir]
  if (options.configPath) args.push('--config', options.configPath)
  if (options.approvalMode) args.push('--approval-mode', options.approvalMode)
  if (options.trustWorkspace) args.push('--trust-workspace')
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PULSE_DATA_DIR: options.dataDir, PULSE_H5_WORKER_PROCESS: '1' }
  if (options.configPath) env.PULSE_CONFIG = options.configPath
  const child = fork(options.entry, args, { cwd: options.cwd ?? process.cwd(), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' })
  const run = new RemoteWorkRun(child, input.conversationId, options.startupTimeoutMs ?? 30_000, options.runtimeOptions)
  await run.start(input.text, input.resume === true)
  return run.handle
}

class RemoteWorkRun {
  private readonly events = new EventQueue()
  private readonly pendingRpc = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private startedResolve!: (message: WorkerStarted) => void
  private startedReject!: (error: Error) => void
  private configuredResolve!: () => void
  private configuredReject!: (error: Error) => void
  private settledResolve!: (message: WorkerSettled) => void
  private settledReject!: (error: Error) => void
  private readonly ready: Promise<void>
  private readonly configured: Promise<void>
  private readonly started: Promise<WorkerStarted>
  private readonly settled: Promise<WorkerSettled>
  private readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private startRequestId = randomUUID()
  private settledValue: WorkerSettled | undefined
  readonly handle: RunHandle

  constructor(private readonly child: ChildProcess, private readonly conversationId: string, timeoutMs: number, private readonly runtimeOptions?: WorkWorkerRuntimeOptions) {
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.configured = new Promise<void>((resolve, reject) => { this.configuredResolve = resolve; this.configuredReject = reject })
    this.started = new Promise<WorkerStarted>((resolve, reject) => { this.startedResolve = resolve; this.startedReject = reject })
    this.settled = new Promise<WorkerSettled>((resolve, reject) => { this.settledResolve = resolve; this.settledReject = reject })
    this.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    void this.ready.catch(() => undefined)
    void this.configured.catch(() => undefined)
    void this.started.catch(() => undefined)
    void this.settled.catch(() => undefined)
    const startupTimer = setTimeout(() => this.fail(new Error('WORKER_START_TIMEOUT')), timeoutMs)
    child.on('message', raw => this.onMessage(raw, startupTimer))
    child.once('error', error => { clearTimeout(startupTimer); this.fail(new Error(`WORKER_PROCESS_ERROR:${error.message}`)) })
    child.once('exit', (code, signal) => {
      clearTimeout(startupTimer)
      if (!this.settledValue) this.fail(new Error(`WORKER_EXITED:${signal ?? code ?? 'unknown'}`))
    })
    const self = this
    this.handle = {
      get id() { return self.runId },
      conversationId,
      events: this.events,
      outcome: async () => {
        const settled = await this.settled
        // Windows keeps a process's cwd locked until it exits. Delivery may
        // remove the worktree, so wait for host cleanup and process closure.
        const closed = await this.closed
        if (closed.code !== 0) throw new Error(`WORKER_EXITED:${closed.signal ?? closed.code ?? 'unknown'}`)
        return settled.outcome
      },
      usage: async () => (await this.settled).usage,
      taskOutcome: async () => (await this.settled).taskOutcome,
      cancel: async reason => { await this.rpc('cancel', [reason]) },
      reply: async (effectId, value) => { await this.rpc('reply', [effectId, value]) },
      replyBatch: async (groupId, answers) => { await this.rpc('replyBatch', [groupId, answers]) },
      pendingInteractions: async () => await this.rpc('pendingInteractions', []) as Awaited<ReturnType<RunHandle['pendingInteractions']>>,
      reviewApproval: async (effectId, signal) => {
        if (signal?.aborted) throw new Error('APPROVAL_REVIEW_ABORTED')
        return await this.rpc('reviewApproval', [effectId]) as Awaited<ReturnType<RunHandle['reviewApproval']>>
      },
      submitHumanInput: async (text, targetEffectId) => { await this.rpc('submitHumanInput', [text, targetEffectId]) },
      shutdown: async () => {
        if (!this.settledValue && this.child.connected) await this.rpc('cancel', ['H5_SERVER_SHUTDOWN'], 2_000).catch(() => undefined)
        const timer = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
        }, 3_000)
        try { await this.closed } finally { clearTimeout(timer) }
      },
    }
    this.runId = ''
  }

  private runId: string

  async start(text: string, resume: boolean): Promise<void> {
    try {
      await this.ready
      const runtimeOptions = JSON.parse(JSON.stringify(this.runtimeOptions ?? {})) as WorkWorkerRuntimeOptions
      await this.sendParent({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'configure', runtimeOptions })
      await this.configured
      const requestId = this.startRequestId
      await this.sendParent({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'start', requestId, conversationId: this.conversationId, text, resume })
      const started = await this.started
      this.runId = started.runId
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.fail(failure)
      throw failure
    }
  }

  private sendParent(message: WorkerConfigure | WorkerStart): Promise<void> {
    if (!this.child.connected) return Promise.reject(new Error('WORKER_NOT_CONNECTED'))
    return new Promise((resolve, reject) => this.child.send(message satisfies ParentMessage, error => error ? reject(error) : resolve()))
  }

  private onMessage(raw: unknown, startupTimer: NodeJS.Timeout): void {
    if (!isWorkerMessage(raw)) { this.fail(new Error('WORKER_PROTOCOL_INVALID')); return }
    if (raw.type === 'ready') {
      this.readyResolve()
    } else if (raw.type === 'configured') {
      this.configuredResolve()
    } else if (raw.type === 'fatal') {
      this.fail(new Error(raw.message))
    } else if (raw.type === 'started') {
      if (raw.requestId !== this.startRequestId || raw.conversationId !== this.conversationId) { this.fail(new Error('WORKER_START_RESPONSE_MISMATCH')); return }
      clearTimeout(startupTimer)
      this.runId = raw.runId
      this.startedResolve(raw)
    } else if (raw.type === 'event') {
      if (raw.event.conversationId !== this.conversationId || (this.runId && raw.event.runId !== this.runId)) { this.fail(new Error('WORKER_EVENT_SCOPE_MISMATCH')); return }
      this.events.push(raw.event)
    } else if (raw.type === 'rpcResult') {
      const pending = this.pendingRpc.get(raw.requestId)
      if (!pending) return
      this.pendingRpc.delete(raw.requestId)
      clearTimeout(pending.timer)
      raw.ok ? pending.resolve(raw.value) : pending.reject(new Error(raw.error))
    } else if (raw.type === 'settled') {
      this.settledValue = raw
      this.events.close()
      this.settledResolve(raw)
    }
  }

  private rpc(method: WorkerRpc['method'], args: unknown[], timeoutMs = 60_000): Promise<unknown> {
    if (!this.child.connected) return Promise.reject(new Error('WORKER_NOT_CONNECTED'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRpc.delete(requestId); reject(new Error('WORKER_RPC_TIMEOUT')) }, timeoutMs)
      this.pendingRpc.set(requestId, { resolve, reject, timer })
      this.child.send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'rpc', requestId, method, args } satisfies WorkerRpc, error => {
        if (error) {
          clearTimeout(timer)
          this.pendingRpc.delete(requestId)
          reject(error)
        }
      })
    })
  }

  private fail(error: Error): void {
    if (!this.child.killed && this.child.connected) this.child.kill('SIGTERM')
    this.readyReject(error)
    this.configuredReject(error)
    this.startedReject(error)
    this.settledReject(error)
    this.events.fail(error)
    for (const [id, pending] of this.pendingRpc) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRpc.delete(id)
    }
  }
}

/** Worker-side entry used only by the hidden `pulse h5 work-worker` CLI action. */
export async function runH5WorkWorker(host: LocalHost, conversationId: string): Promise<number> {
  if (typeof process.send !== 'function') throw new Error('WORKER_IPC_REQUIRED')
  const send = (message: WorkerMessage): Promise<void> => new Promise((resolve, reject) => process.send?.(message, error => error ? reject(error) : resolve()))
  await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'ready' })
  const configure = await new Promise<WorkerConfigure | undefined>(resolve => {
    const receive = (raw: unknown) => {
      if (!isObject(raw) || raw.schemaVersion !== H5_WORKER_PROTOCOL_VERSION) return
      if (raw.type === 'shutdown') { process.off('message', receive); resolve(undefined); return }
      if (raw.type === 'configure' && isObject(raw.runtimeOptions)) {
        process.off('message', receive)
        resolve(raw as WorkerConfigure)
      }
    }
    process.on('message', receive)
  })
  if (!configure) { await host.close(); process.disconnect?.(); return 0 }

  try {
    host.applyWorkerOptions(configure.runtimeOptions)
    await host.init()
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'configured' })
  } catch (error) {
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'fatal', message: errorText(error).slice(0, 400) }).catch(() => undefined)
    await host.close().catch(() => undefined)
    process.disconnect?.()
    return 1
  }

  const start = await new Promise<WorkerStart | undefined>(resolve => {
    const receive = (raw: unknown) => {
      if (!isObject(raw) || raw.schemaVersion !== H5_WORKER_PROTOCOL_VERSION) return
      if (raw.type === 'shutdown') { process.off('message', receive); resolve(undefined); return }
      if (raw.type === 'start' && raw.conversationId === conversationId && typeof raw.requestId === 'string' && typeof raw.text === 'string' && typeof raw.resume === 'boolean') {
        process.off('message', receive)
        resolve(raw as WorkerStart)
      }
    }
    process.on('message', receive)
  })
  if (!start) { await host.close(); process.disconnect?.(); return 0 }

  let handle: RunHandle
  try {
    handle = start.resume ? await host.resumeRun(conversationId) : await host.sendMessage(conversationId, { text: start.text })
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'started', requestId: start.requestId, runId: handle.id, conversationId })
  } catch (error) {
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'fatal', message: errorText(error).slice(0, 400) }).catch(() => undefined)
    await host.close()
    process.disconnect?.()
    return 1
  }

  let settled = false
  process.once('disconnect', () => {
    if (settled) return
    void handle.cancel('PARENT_DISCONNECTED').finally(async () => {
      await host.close().catch(() => undefined)
      process.exit(1)
    })
  })

  process.on('message', (raw: unknown) => {
    if (!isObject(raw) || raw.schemaVersion !== H5_WORKER_PROTOCOL_VERSION || raw.type !== 'rpc' || typeof raw.requestId !== 'string' || typeof raw.method !== 'string' || !Array.isArray(raw.args)) return
    const request = raw as WorkerRpc
    void (async () => {
      try {
        let value: unknown
        switch (request.method) {
          case 'cancel': await handle.cancel(typeof request.args[0] === 'string' ? request.args[0] : undefined); break
          case 'reply': await handle.reply(String(request.args[0] ?? ''), request.args[1] as JsonValue); break
          case 'replyBatch': await handle.replyBatch(String(request.args[0] ?? ''), request.args[1] as Array<{ effectId: string; value: JsonValue }>); break
          case 'pendingInteractions': value = await handle.pendingInteractions(); break
          case 'reviewApproval': value = await handle.reviewApproval(String(request.args[0] ?? '')); break
          case 'submitHumanInput': await handle.submitHumanInput(String(request.args[0] ?? ''), typeof request.args[1] === 'string' ? request.args[1] : undefined); break
          default: throw new Error('WORKER_RPC_UNSUPPORTED')
        }
        await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'rpcResult', requestId: request.requestId, ok: true, ...(value === undefined ? {} : { value }) })
      } catch (error) {
        await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'rpcResult', requestId: request.requestId, ok: false, error: errorText(error).slice(0, 400) }).catch(() => undefined)
      }
    })()
  })

  try {
    for await (const event of handle.events) await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'event', event })
    const [outcome, usage, taskOutcome] = await Promise.all([handle.outcome(), handle.usage(), handle.taskOutcome()])
    settled = true
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'settled', outcome, usage, ...(taskOutcome === undefined ? {} : { taskOutcome }) })
    await host.close()
    process.disconnect?.()
    return 0
  } catch (error) {
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'fatal', message: errorText(error).slice(0, 400) }).catch(() => undefined)
    await host.close().catch(() => undefined)
    process.disconnect?.()
    return 1
  }
}
