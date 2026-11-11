import { DeviceUseIpcParent, DeviceUseIpcClient, type DeviceUseWorkerBridgeOptions, type DeviceUseWorkerConfiguration } from '../device-use/worker-ipc.js'
import { currentWorkActor, withWorkActor, type WorkActor } from '../work-control.js'
import { waitForWorkerStop } from './worker-stop.js'
import type { RunRecoveryAuthorization } from '../run-recovery-preflight.js'
import type { RichContent } from '../rich-content.js'
import type { WebAttachment } from '../protocol.js'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { JsonValue, Outcome } from '@hunterzhu/pulse-runtime'
import type { AssistantEvent, LocalHost, LocalHostOptions, RunHandle, RunUsage, TaskOutcome, UserMessageInput } from '../index.js'

export const H5_WORKER_PROTOCOL_VERSION = 1 as const

type WorkerPayload = Pick<UserMessageInput, 'runId' | 'userMessageRecorded' | 'qualityReviewEnabled' | 'workOperation' | 'workResponse' | 'continueTask' | 'requirementUpdate'> & { budgetRenewal?: import('../model-budget.js').BudgetRenewalAuthorization; recoveryAuthorization?: RunRecoveryAuthorization; requestId?: string; attachments?: WebAttachment[]; skills?: string[]; richContent?: RichContent; mentionedFiles?: string[] }
type WorkerStart = { controller?: WorkActor } & Omit<WorkerPayload, 'requestId'> & { messageRequestId?: string } & { schemaVersion: 1; type: 'start'; requestId: string; conversationId: string; text: string; resume: boolean }
type WorkerConfigure = { schemaVersion: 1; type: 'configure'; runtimeOptions: WorkWorkerRuntimeOptions; deviceUse?: DeviceUseWorkerConfiguration }
type WorkerRpc = { controller?: WorkActor; schemaVersion: 1; type: 'rpc'; requestId: string; method: 'cancel' | 'reply' | 'replyBatch' | 'pendingInteractions' | 'reviewApproval' | 'submitHumanInput' | 'processes' | 'pollProcess' | 'cancelProcess' | 'checkpointForUpdate'; args: unknown[] }
type WorkerShutdown = { schemaVersion: 1; type: 'shutdown'; preserveRuns?: boolean }
type ParentMessage = WorkerConfigure | WorkerStart | WorkerRpc | WorkerShutdown

type WorkerReady = { schemaVersion: 1; type: 'ready' } | { schemaVersion: 1; type: 'configured' }
type WorkerStarted = { schemaVersion: 1; type: 'started'; requestId: string; runId: string; conversationId: string }
type WorkerEvent = { schemaVersion: 1; type: 'event'; event: AssistantEvent }
type WorkerRpcResult = { schemaVersion: 1; type: 'rpcResult'; requestId: string; ok: true; value?: unknown } | { schemaVersion: 1; type: 'rpcResult'; requestId: string; ok: false; error: string; code?: string }
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
  push(value: AssistantEvent): boolean {
    if (this.ended || this.failure) return false
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else if (this.values.length < 4096) this.values.push(value)
    else if (value.type === 'text' || value.type === 'notice') {
      const index = this.values.findLastIndex(item => item.type === value.type && item.runId === value.runId)
      if (index >= 0) this.values[index] = value
      else return false
    } else return false
    return true
  }
  close(terminal?: AssistantEvent): void {
    // Reserve one bounded terminal slot even when the progress queue is full.
    if (terminal) {
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve({ done: false, value: terminal })
      else this.values.push(terminal)
    }
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
  /** Maximum wait for host cleanup/process exit after the first terminal fact. */
  cleanupTimeoutMs?: number
  /** Captured for this Run and sent through the private IPC channel, never argv. */
  runtimeOptions?: WorkWorkerRuntimeOptions
  /** Trusted parent-only executor. Never serialized, and never created in the worker. */
  deviceUse?: DeviceUseWorkerBridgeOptions
}

export type WorkWorkerRuntimeOptions = Omit<LocalHostOptions, 'capabilityPacks' | 'jarvisClient'>

type WorkWorkerInput = WorkerPayload & { conversationId: string; text: string; resume?: boolean }

/** Production entry: reserve host capacity before creating any child process.
 * The host owns permissions, persistence, deduplication and recovery identity.
 * Already-admitted H5 launches carry their permit and must not queue twice.
 */
export async function startAdmittedH5WorkWorker(
  host: Pick<LocalHost, 'scheduleTask'> & Partial<Pick<LocalHost, 'deviceUse'>>,
  options: H5WorkWorkerLaunchOptions,
  input: WorkWorkerInput,
): Promise<RunHandle> {
  const launch = async (launchOptions: H5WorkWorkerLaunchOptions, launchInput: WorkWorkerInput) => {
    let deviceUse = launchOptions.deviceUse
    if (!deviceUse && host.deviceUse) {
      // Capture the epoch before awaiting activation: a settings change fails closed.
      const epoch = host.deviceUse.getEpoch()
      const activation = await host.deviceUse.activation()
      deviceUse = { tools: activation.tools.map(tool => tool.manifest), instructions: activation.instructions ?? [], execute: (name, value, context) => host.deviceUse!.executeTool(name, value, context, epoch) }
    }
    return startH5WorkWorker({ ...launchOptions, ...(deviceUse ? { deviceUse } : {}) }, launchInput)
  }
  if (options.runtimeOptions?.taskAdmissionPermit) return launch(options, input)
  return host.scheduleTask(input.conversationId, input, (admitted, permit) => launch({
    ...options,
    runtimeOptions: { ...options.runtimeOptions, taskAdmissionPermit: permit },
  }, { ...input, ...admitted }), input.resume === true)
}

/** Low-level IPC transport, without admission. Production callers use
 * startAdmittedH5WorkWorker or must already hold a host admission permit.
 * Kept explicit for protocol fixtures and existing raw transport consumers.
 */
export async function startH5WorkWorker(
  options: H5WorkWorkerLaunchOptions,
  input: WorkWorkerInput
): Promise<RunHandle> {
  const args = ['h5', 'work-worker', input.conversationId, '--data-dir', options.dataDir]
  if (options.configPath) args.push('--config', options.configPath)
  if (options.approvalMode) args.push('--approval-mode', options.approvalMode)
  if (options.trustWorkspace) args.push('--trust-workspace')
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PULSE_DATA_DIR: options.dataDir, PULSE_H5_WORKER_PROCESS: '1' }
  if (options.configPath) env.PULSE_CONFIG = options.configPath
  const child = fork(options.entry, args, { windowsHide: true, cwd: options.cwd ?? process.cwd(), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' })
  const run = new RemoteWorkRun(child, input.conversationId, options.startupTimeoutMs ?? 30_000, options.runtimeOptions, options.cleanupTimeoutMs ?? 30_000, options.deviceUse)
  await run.start(input.text, input.resume === true, input)
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
  private completion: AssistantEvent | undefined
  private failure: Error | undefined
  private stopped = false
  private cleanupTimer: NodeJS.Timeout | undefined
  readonly handle: RunHandle
  private readonly deviceBridge: DeviceUseIpcParent | undefined

  constructor(private readonly child: ChildProcess, private readonly conversationId: string, timeoutMs: number, private readonly runtimeOptions?: WorkWorkerRuntimeOptions, private readonly cleanupTimeoutMs = 30_000, private readonly deviceUse?: DeviceUseWorkerBridgeOptions) {
    this.deviceBridge = deviceUse ? new DeviceUseIpcParent(deviceUse.execute, message => new Promise<void>((resolve, reject) => { if (!child.connected) { reject(new Error('DEVICE_IPC_CLOSED')); return }; child.send(message, error => error ? reject(error) : resolve()) }), error => this.fail(error)) : undefined
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.configured = new Promise<void>((resolve, reject) => { this.configuredResolve = resolve; this.configuredReject = reject })
    this.started = new Promise<WorkerStarted>((resolve, reject) => { this.startedResolve = resolve; this.startedReject = reject })
    this.settled = new Promise<WorkerSettled>((resolve, reject) => { this.settledResolve = resolve; this.settledReject = reject })
    this.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    // A worker's complete/settled messages precede host cleanup. Neither is a
    // trustworthy terminal fact until the process has closed successfully.
    void this.closed.then(({ code, signal }) => {
      this.deviceBridge?.close()
      this.stopped = true
      clearTimeout(this.cleanupTimer)
      clearTimeout(startupTimer)
      if (!this.failure && (code !== 0 || !this.settledValue)) this.fail(new Error(`WORKER_EXITED:${signal ?? code ?? 'unknown'}`))
      if (!this.failure && this.completion && (this.completion.data as { status?: string })?.status !== this.settledValue?.outcome.status) this.fail(new Error('WORKER_OUTCOME_MISMATCH'))
      if (this.failure) {
        this.settledReject(this.failure)
        this.events.fail(this.failure)
      } else {
        this.events.close(this.completion)
        this.settledResolve(this.settledValue!)
      }
      for (const pending of this.pendingRpc.values()) { clearTimeout(pending.timer); pending.reject(this.failure ?? new Error('WORKER_NOT_CONNECTED')) }
      this.pendingRpc.clear()
    })
    void this.ready.catch(() => undefined)
    void this.configured.catch(() => undefined)
    void this.started.catch(() => undefined)
    void this.settled.catch(() => undefined)
    const startupTimer = setTimeout(() => this.fail(new Error('WORKER_START_TIMEOUT')), timeoutMs)
    child.on('message', raw => this.onMessage(raw, startupTimer))
    child.once('error', error => { clearTimeout(startupTimer); this.fail(new Error(`WORKER_PROCESS_ERROR:${error.message}`)) })
    const self = this
    this.handle = {
      get id() { return self.runId },
      conversationId,
      isActive: () => !this.stopped,
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
      cancel: async reason => { this.deviceBridge?.close(); await this.rpc('cancel', [reason]) },
      processes: async () => await this.rpc('processes', []) as Awaited<ReturnType<NonNullable<RunHandle['processes']>>>,
      pollProcess: async (id, offset) => await this.rpc('pollProcess', [id, offset ?? 0]) as Awaited<ReturnType<NonNullable<RunHandle['pollProcess']>>>,
      cancelProcess: async id => await this.rpc('cancelProcess', [id]) as Awaited<ReturnType<NonNullable<RunHandle['cancelProcess']>>>,
      reply: async (effectId, value) => { await this.rpc('reply', [effectId, value]) },
      replyBatch: async (groupId, answers) => { await this.rpc('replyBatch', [groupId, answers]) },
      pendingInteractions: async () => await this.rpc('pendingInteractions', []) as Awaited<ReturnType<RunHandle['pendingInteractions']>>,
      reviewApproval: async (effectId, signal) => {
        if (signal?.aborted) throw new Error('APPROVAL_REVIEW_ABORTED')
        return await this.rpc('reviewApproval', [effectId]) as Awaited<ReturnType<RunHandle['reviewApproval']>>
      },
      submitHumanInput: async (text, targetEffectId, options) => { await this.rpc('submitHumanInput', [text, targetEffectId, options]) },
      checkpointForUpdate: async () => { await this.rpc('checkpointForUpdate', []) },
      shutdown: async (options) => {
        this.deviceBridge?.close()
        if (!this.settledValue && this.child.connected) await this.sendParent({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'shutdown', ...(options?.preserveRuns ? { preserveRuns: true } : {}) }).catch(() => undefined)
        await waitForWorkerStop(this.child, this.closed)
      },
    }
    this.runId = ''
  }

  private runId: string

  async start(text: string, resume: boolean, input: WorkerPayload = {}): Promise<void> {
    try {
      await this.ready
      const runtimeOptions = JSON.parse(JSON.stringify(this.runtimeOptions ?? {})) as WorkWorkerRuntimeOptions
      await this.sendParent({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'configure', runtimeOptions, ...(this.deviceBridge && this.deviceUse ? { deviceUse: { sessionId: this.deviceBridge.sessionId, tools: this.deviceUse.tools, instructions: this.deviceUse.instructions } } : {}) })
      await this.configured
      const requestId = this.startRequestId
      await this.sendParent({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'start', controller: currentWorkActor(), requestId, conversationId: this.conversationId, text, resume, ...(input.runId ? { runId: input.runId } : {}), ...(input.userMessageRecorded === undefined ? {} : { userMessageRecorded: input.userMessageRecorded }), ...(input.qualityReviewEnabled === undefined ? {} : { qualityReviewEnabled: input.qualityReviewEnabled }), ...(input.budgetRenewal ? { budgetRenewal: input.budgetRenewal } : {}), ...(input.requestId ? { messageRequestId: input.requestId } : {}), ...(input.attachments ? { attachments: input.attachments } : {}), ...(input.skills ? { skills: input.skills } : {}), ...(input.mentionedFiles ? { mentionedFiles: input.mentionedFiles } : {}), ...(input.richContent ? { richContent: input.richContent } : {}), ...(input.recoveryAuthorization ? { recoveryAuthorization: input.recoveryAuthorization } : {}), ...(input.workOperation ? { workOperation: input.workOperation, continueTask: input.continueTask === true, ...(input.requirementUpdate ? { requirementUpdate: true } : {}), ...(input.workResponse ? { workResponse: input.workResponse } : {}) } : {}) })
      const started = await this.started
      this.runId = started.runId
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.fail(failure)
      await this.handle.shutdown?.()
      throw failure
    }
  }

  private sendParent(message: WorkerConfigure | WorkerStart | WorkerShutdown): Promise<void> {
    if (!this.child.connected) return Promise.reject(new Error('WORKER_NOT_CONNECTED'))
    return new Promise((resolve, reject) => this.child.send(message satisfies ParentMessage, error => error ? reject(error) : resolve()))
  }

  private onMessage(raw: unknown, startupTimer: NodeJS.Timeout): void {
    if (this.failure) return
    if (this.deviceBridge?.receive(raw)) return
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
      this.deviceBridge?.bindRun(raw.runId)
      this.startedResolve(raw)
    } else if (raw.type === 'event') {
      if (raw.event.conversationId !== this.conversationId || (this.runId && raw.event.runId !== this.runId)) { this.fail(new Error('WORKER_EVENT_SCOPE_MISMATCH')); return }
      if (raw.event.type === 'complete') { this.deviceBridge?.close(); this.completion = raw.event; this.watchCleanup() }
      else if (!this.events.push(raw.event)) this.fail(new Error('WORK_EVENT_QUEUE_OVERFLOW'))
    } else if (raw.type === 'rpcResult') {
      const pending = this.pendingRpc.get(raw.requestId)
      if (!pending) return
      this.pendingRpc.delete(raw.requestId)
      clearTimeout(pending.timer)
      raw.ok ? pending.resolve(raw.value) : pending.reject(Object.assign(new Error(raw.error), typeof raw.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw.code) ? { code: raw.code } : {}))
    } else if (raw.type === 'settled') {
      this.deviceBridge?.close()
      this.settledValue = raw
      this.watchCleanup()
    }
  }

  private rpc(method: WorkerRpc['method'], args: unknown[], timeoutMs = 60_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (!this.child.connected) return Promise.reject(new Error('WORKER_NOT_CONNECTED'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRpc.delete(requestId); reject(new Error('WORKER_RPC_TIMEOUT')) }, timeoutMs)
      this.pendingRpc.set(requestId, { resolve, reject, timer })
      this.child.send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'rpc', controller: currentWorkActor(), requestId, method, args } satisfies WorkerRpc, error => {
        if (error) {
          clearTimeout(timer)
          this.pendingRpc.delete(requestId)
          reject(error)
        }
      })
    })
  }

  private watchCleanup(): void {
    this.cleanupTimer ??= setTimeout(() => this.fail(new Error('WORKER_CLEANUP_TIMEOUT')), this.cleanupTimeoutMs)
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.deviceBridge?.close()
    clearTimeout(this.cleanupTimer)
    // Stop only our own worker, first cooperatively so its host can cancel and
    // persist outstanding work. Keep events/outcome pending until close: H5
    // must not discard the only handle while side effects may still be running.
    if (this.child.connected) void this.sendParent({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'shutdown' }).catch(() => undefined)
    void waitForWorkerStop(this.child, this.closed).catch(() => undefined)
    this.readyReject(error)
    this.configuredReject(error)
    this.startedReject(error)
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

  let deviceClient: DeviceUseIpcClient | undefined
  const receiveDevice = (raw: unknown) => { deviceClient?.receive(raw) }
  try {
    if (configure.deviceUse) {
      deviceClient = new DeviceUseIpcClient(configure.deviceUse.sessionId, message => new Promise<void>((resolve, reject) => process.send?.(message, error => error ? reject(error) : resolve())))
      process.on('message', receiveDevice)
      process.once('disconnect', () => { deviceClient?.close(); process.off('message', receiveDevice) })
      host.setDeviceUseRemoteExecutor((name, input, context) => deviceClient!.execute(name, input, context), configure.deviceUse.tools, configure.deviceUse.instructions)
    }
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
    handle = await withWorkActor(start.controller ?? { kind: 'user' }, async () => start.resume ? await host.resumeRun(conversationId, start.recoveryAuthorization) : await host.sendMessage(conversationId, { text: start.text, ...(start.runId ? { runId: start.runId } : {}), ...(start.userMessageRecorded === undefined ? {} : { userMessageRecorded: start.userMessageRecorded }), ...(start.qualityReviewEnabled === undefined ? {} : { qualityReviewEnabled: start.qualityReviewEnabled }), ...(start.budgetRenewal ? { budgetRenewal: start.budgetRenewal, continueTask: true } : {}), ...(start.messageRequestId ? { requestId: start.messageRequestId } : {}), ...(start.attachments ? { attachments: start.attachments } : {}), ...(start.skills ? { skills: start.skills } : {}), ...(start.mentionedFiles ? { mentionedFiles: start.mentionedFiles } : {}), ...(start.richContent ? { richContent: start.richContent } : {}), ...(start.workOperation ? { workOperation: start.workOperation, continueTask: start.continueTask === true, ...(start.requirementUpdate ? { requirementUpdate: true } : {}), ...(start.workResponse ? { workResponse: start.workResponse } : {}) } : {}) }))
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'started', requestId: start.requestId, runId: handle.id, conversationId })
    deviceClient?.bindRun(handle.id)
  } catch (error) {
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'fatal', message: errorText(error).slice(0, 400) }).catch(() => undefined)
    await host.close()
    process.disconnect?.()
    return 1
  }

  let settled = false
  let suspending = false
  process.once('disconnect', () => {
    if (settled) return
    suspending = true
    settled = true
    deviceClient?.close()
    void host.close({ preserveHumanWaits: true }).finally(() => process.exit(1))
  })

  process.on('message', (raw: unknown) => {
    if (isObject(raw) && raw.schemaVersion === H5_WORKER_PROTOCOL_VERSION && raw.type === 'shutdown') {
      if (suspending || settled) return
      suspending = true
      deviceClient?.close()
      settled = true // Parent disconnect is expected after the checkpoint closes.
      void host.close({ preserveHumanWaits: true, preserveRuns: raw.preserveRuns === true }).then(() => process.exit(0), () => process.exit(1))
      return
    }
    if (suspending || !isObject(raw) || raw.schemaVersion !== H5_WORKER_PROTOCOL_VERSION || raw.type !== 'rpc' || typeof raw.requestId !== 'string' || typeof raw.method !== 'string' || !Array.isArray(raw.args)) return
    const request = raw as WorkerRpc
    void withWorkActor(request.controller ?? { kind: 'user' }, async () => {
      try {
        let value: unknown
        switch (request.method) {
          case 'checkpointForUpdate': await host.close({ preserveRuns: true }); break
          case 'cancel': await handle.cancel(typeof request.args[0] === 'string' ? request.args[0] : undefined); break
          case 'processes': if (!handle.processes) throw new Error('WORKER_PROCESS_CONTROLS_UNAVAILABLE'); value = await handle.processes(); break
          case 'pollProcess': if (!handle.pollProcess) throw new Error('WORKER_PROCESS_CONTROLS_UNAVAILABLE'); value = await handle.pollProcess(String(request.args[0] ?? ''), Number(request.args[1] ?? 0)); break
          case 'cancelProcess': if (!handle.cancelProcess) throw new Error('WORKER_PROCESS_CONTROLS_UNAVAILABLE'); value = await handle.cancelProcess(String(request.args[0] ?? '')); break
          case 'reply': await handle.reply(String(request.args[0] ?? ''), request.args[1] as JsonValue); break
          case 'replyBatch': await handle.replyBatch(String(request.args[0] ?? ''), request.args[1] as Array<{ effectId: string; value: JsonValue }>); break
          case 'pendingInteractions': value = await handle.pendingInteractions(); break
          case 'reviewApproval': value = await handle.reviewApproval(String(request.args[0] ?? '')); break
          case 'submitHumanInput': await handle.submitHumanInput(String(request.args[0] ?? ''), typeof request.args[1] === 'string' ? request.args[1] : undefined, request.args[2] as import('../index.js').HumanInputOptions | undefined); break
          default: throw new Error('WORKER_RPC_UNSUPPORTED')
        }
        await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'rpcResult', requestId: request.requestId, ok: true, ...(value === undefined ? {} : { value }) })
      } catch (error) {
        const code = (error as { code?: unknown })?.code
        await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'rpcResult', requestId: request.requestId, ok: false, error: errorText(error).slice(0, 400), ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? { code } : {}) }).catch(() => undefined)
      }
    })
  })

  try {
    for await (const event of handle.events) await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'event', event })
    const [outcome, usage, taskOutcome] = await Promise.all([handle.outcome(), handle.usage(), handle.taskOutcome()])
    settled = true
    deviceClient?.close()
    await host.close()
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'settled', outcome, usage, ...(taskOutcome === undefined ? {} : { taskOutcome }) })
    process.disconnect?.()
    return 0
  } catch (error) {
    await host.close().catch(() => undefined)
    await send({ schemaVersion: H5_WORKER_PROTOCOL_VERSION, type: 'fatal', message: errorText(error).slice(0, 400) }).catch(() => undefined)
    process.disconnect?.()
    return 1
  }
}
