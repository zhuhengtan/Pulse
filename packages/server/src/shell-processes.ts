import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { replaceStateFile } from './atomic-file.js'

export interface ShellCommand { command: string; args?: string[] | undefined; cwd?: string | undefined; timeoutMs?: number | undefined; pty?: boolean | undefined }
export interface ProcessReceipt {
  processId: string
  agentId: string
  laneId: string
  status: 'running' | 'exited' | 'unknown'
  command: ShellCommand
  result?: Record<string, unknown>
  error?: string
  stdinReady?: boolean
  inputUncertain?: boolean
}
type InputWriter = (data: string) => void | Promise<void>
export interface ShellInputReceipt { processId: string; effectId: string; agentId: string; laneId: string; digest: string; bytes: number; status: 'pending' | 'delivered' | 'unknown' }
type Runner = (command: ShellCommand, context: ToolContext, onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => void, ready: (write: InputWriter) => void) => Promise<Record<string, unknown>>
interface LiveProcess { record: ProcessReceipt; controller: AbortController; done: Promise<void>; write?: InputWriter; outputBytes: number; inputSeen: boolean; changed: Set<() => void> }
const notifyProcess = (live: LiveProcess) => { for (const listener of live.changed) listener() }
// Keep an incomplete UTF-8 suffix in the raw log, but do not expose/consume it
// before its remaining bytes arrive. Invalid complete bytes retain normal
// Buffer decoding semantics and cannot grow this suffix beyond three bytes.
function incompleteSuffix(bytes: Buffer): Buffer {
  if (!bytes.length) return Buffer.alloc(0)
  let lead = bytes.length - 1
  while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80 && bytes.length - lead < 4) lead--
  const first = bytes[lead]!
  const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1
  return width > bytes.length - lead ? Buffer.from(bytes.subarray(lead)) : Buffer.alloc(0)
}
const managers = new Map<string, ShellProcesses>()
const failure = (code: string) => Object.assign(new Error(code), { code, retryable: false })

/** Only the persisted continuous program blocks acceptance on a live or unknown shell. */
export function shellAcceptanceGate(programVersion: string | undefined): boolean {
  return programVersion === '57'
}

export async function blockAcceptanceIfShellBusy(programVersion: string | undefined, runDirectory: string | undefined): Promise<void> {
  if (!shellAcceptanceGate(programVersion)) {
    if (!runDirectory) return
    const input = JSON.parse(await readFile(join(runDirectory, 'input.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error })) as { shellSurfaceVersion?: unknown }
    if (input.shellSurfaceVersion !== 1) return
  }
  if (!runDirectory) throw failure('SHELL_PROCESS_STATE_UNKNOWN')
  await shellProcesses(runDirectory).assertIdle()
}

/** Keep cursors and status visible even when the original command receipt is large. */
export function summarizeShellProcess(value: unknown): Record<string, unknown> {
  const record = value as Record<string, any>
  let output = '', bytes = 0
  for (const char of String(record.output ?? '')) {
    const size = Buffer.byteLength(char)
    if (bytes + size > 1024) break
    bytes += size; output += char
  }
  return {
    processId: record.processId, status: record.status,
    ...(typeof record.stdinReady === 'boolean' ? { stdinReady: record.stdinReady, inputUncertain: record.inputUncertain === true } : {}),
    ...(typeof record.code === 'number' || record.code === null ? { code: record.code, aborted: record.aborted, timedOut: record.timedOut } : {}),
    ...(record.output === undefined ? {} : { offset: record.offset, nextOffset: record.offset + bytes, output, truncated: record.truncated || output.length < record.output.length }),
    ...(record.error ? { error: record.error } : {}),
    originalReceiptAvailable: true,
  }
}

/** Host-owned process handles. No process or Promise is stored in Runtime state. */
export class ShellProcesses {
  private admission = Promise.resolve()
  private readonly live = new Map<string, LiveProcess>()
  private inputTail = Promise.resolve()
  private readonly inputs = new Map<string, { identity: string; promise: Promise<ShellInputReceipt> }>()
  constructor(readonly directory: string) {}
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw failure('INVALID_SHELL_PROCESS_ID')
    return join(this.directory, `${id}.json`)
  }
  private async persist(record: ProcessReceipt): Promise<void> {
    await this.persistJson(this.path(record.processId), record)
  }
  private async persistJson(path: string, record: unknown): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp'
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
    await replaceStateFile(temporary, path)
    const directory = await open(this.directory, 'r').catch(() => undefined)
    if (directory) { try { await directory.sync() } catch { /* Some filesystems cannot sync a directory. */ } finally { await directory.close() } }
  }
  private async saved(id: string): Promise<ProcessReceipt> {
    const record = JSON.parse(await readFile(this.path(id), 'utf8')) as ProcessReceipt
    if (record.processId !== id) throw failure('INVALID_SHELL_PROCESS_RECEIPT')
    return record
  }
  private async owned(id: string, context: Pick<ToolContext, 'agentId' | 'laneId'>): Promise<ProcessReceipt> {
    const record = this.live.get(id)?.record ?? await this.saved(id)
    if (record.agentId !== context.agentId || record.laneId !== context.laneId) throw failure('RESULT_NOT_VISIBLE')
    // A PID from another process lifetime is not authority to poll, kill or restart it.
    return record.status === 'running' && !this.live.has(id) ? { ...record, status: 'unknown' } : record
  }
  async assertIdle(): Promise<void> {
    for (const file of await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      if (/^stdin-[a-f0-9]{64}\.json$/.test(file)) {
        const receipt = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as ShellInputReceipt
        if (receipt.status !== 'delivered') throw failure('SHELL_STDIN_STATE_UNKNOWN')
        continue
      }
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const id = file.slice(0, -5), record = this.live.get(id)?.record ?? await this.saved(id)
      if (record.status === 'running' || record.status === 'unknown') throw failure(this.live.has(id) ? 'SHELL_PROCESS_ACTIVE' : 'SHELL_PROCESS_STATE_UNKNOWN')
    }
  }
  async start(command: ShellCommand, context: ToolContext, run: Runner): Promise<ProcessReceipt> {
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await this.startOwned(command, context, run) } finally { release() }
  }
  private async startOwned(command: ShellCommand, context: ToolContext, run: Runner): Promise<ProcessReceipt> {
    context.signal.throwIfAborted()
    const processId = createHash('sha256').update(context.effectId).digest('hex')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const old = await this.owned(processId, context)
      if (JSON.stringify(old.command) !== JSON.stringify(command)) throw failure('SHELL_PROCESS_OPERATION_CHANGED')
      return old
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await this.assertIdle()
    const record: ProcessReceipt = { processId, agentId: context.agentId, laneId: context.laneId, status: 'running', command }
    // Commit intent before invoking the runner; uncertain intent is never replayed.
    await this.persist(record)
    const controller = new AbortController()
    const live: LiveProcess = { record, controller, done: Promise.resolve(), outputBytes: 0, inputSeen: false, changed: new Set() }
    this.live.set(processId, live)
    let output = Promise.resolve(), bytes = 0, durableBytes = 0
    let suffix: Buffer = Buffer.alloc(0)
    const onOutput = (_stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const part = Buffer.from(chunk.subarray(0, Math.max(0, 16 * 1024 * 1024 - bytes)))
      bytes += part.length
      if (part.length) {
        output = output.then(async () => {
          await appendFile(join(this.directory, `${processId}.log`), part, { mode: 0o600 })
          const previous = live.outputBytes
          durableBytes += part.length
          suffix = incompleteSuffix(Buffer.concat([suffix, part]))
          live.outputBytes = durableBytes - suffix.length
          if (live.outputBytes > previous) notifyProcess(live)
        })
        void output.catch(() => undefined)
      }
    }
    live.done = (async () => {
      let terminal: ProcessReceipt
      try {
        const result = await run(command, { ...context, signal: controller.signal }, onOutput, write => {
          if (command.pty !== true || controller.signal.aborted || live.record.status !== 'running') throw failure('SHELL_STDIN_NOT_READY')
          live.write = write
          notifyProcess(live)
        })
        await output
        terminal = { ...record, status: 'exited', result }
      } catch (cause) {
        await output.catch(() => undefined)
        terminal = { ...record, status: 'unknown', error: String((cause as { code?: string }).code ?? 'SHELL_PROCESS_FAILED') }
      }
      // Publish completion only after its receipt is durable for cold readers.
      try {
        await this.persist(terminal)
        live.record = terminal
      } catch (error) {
        live.record = { ...record, status: 'unknown', error: 'SHELL_RECEIPT_PERSIST_FAILED' }
        throw error
      }
    })()
    // Keep rejection observed even when the caller is cancelled before polling.
    void live.done.catch(() => undefined)
    return { ...record }
  }
  async poll(id: string, context: ToolContext, offset = 0, limit = 4096, waitMs = 0): Promise<ProcessReceipt & { output: string; offset: number; nextOffset: number; truncated: boolean }> {
    context.signal.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192 || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30000) throw failure('SHELL_OUTPUT_RANGE_INVALID')
    let record = await this.owned(id, context)
    const live = this.live.get(id)
    if (record.status === 'running' && live && waitMs > 0) {
      const wait = new AbortController()
      let changed!: () => void
      const update = new Promise<void>(resolve => { changed = resolve })
      live.changed.add(changed)
      try {
        // Register before checking to avoid losing a transition between the
        // snapshot and subscription. Readiness remains actionable until the
        // first input intent; afterwards a quiet PTY must not cause a busy loop.
        if (live.outputBytes <= offset && !(live.write && !live.inputSeen)) await Promise.race([live.done, update, delay(waitMs, undefined, { signal: AbortSignal.any([context.signal, wait.signal]) })])
        context.signal.throwIfAborted()
      } finally { live.changed.delete(changed); wait.abort() }
      record = await this.owned(id, context)
    }
    const log = await readFile(join(this.directory, `${id}.log`)).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
    const available = record.status === 'running' && live ? Math.min(log.length, live.outputBytes) : log.length
    let end = Math.min(available, offset + limit)
    if (offset < log.length && (log[offset]! & 0xc0) === 0x80) throw failure('SHELL_OUTPUT_OFFSET_INVALID')
    while (end > offset && end < available && (log[end]! & 0xc0) === 0x80) end--
    if (end === offset && end < available) { end++; while (end < available && (log[end]! & 0xc0) === 0x80) end++ }
    if (offset > available) throw failure('SHELL_OUTPUT_OFFSET_INVALID')
    return { ...record, ...(record.command.pty === undefined ? {} : { stdinReady: record.status === 'running' && live?.write !== undefined, inputUncertain: await this.inputUncertain(id) }), ...(record.status === 'exited' ? record.result : {}), output: log.subarray(offset, end).toString('utf8'), offset, nextOffset: end, truncated: end < log.length }
  }
  private inputPath(effectId: string): string { return join(this.directory, `stdin-${createHash('sha256').update(effectId).digest('hex')}.json`) }
  private async inputUncertain(id: string): Promise<boolean> {
    for (const name of await readdir(this.directory)) {
      if (!/^stdin-[a-f0-9]{64}\.json$/.test(name)) continue
      const receipt = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as ShellInputReceipt
      if (receipt.processId === id && receipt.status !== 'delivered') return true
    }
    return false
  }
  async input(id: string, data: string, context: ToolContext): Promise<ShellInputReceipt> {
    context.signal.throwIfAborted()
    const bytes = Buffer.byteLength(data)
    if (!bytes || bytes > 8192 || Buffer.from(data).toString('utf8') !== data) throw failure('SHELL_STDIN_RANGE_INVALID')
    await this.owned(id, context)
    const digest = createHash('sha256').update(data).digest('hex')
    const identity = JSON.stringify([id, context.effectId, context.agentId, context.laneId, digest, bytes])
    const prior = this.inputs.get(context.effectId)
    if (prior) { if (prior.identity !== identity) throw failure('SHELL_STDIN_OPERATION_CHANGED'); return prior.promise }
    const work = this.inputTail.then(async () => {
      context.signal.throwIfAborted()
      const path = this.inputPath(context.effectId)
      const saved = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (saved !== undefined) {
        const receipt = JSON.parse(saved) as ShellInputReceipt
        if (JSON.stringify([receipt.processId, receipt.effectId, receipt.agentId, receipt.laneId, receipt.digest, receipt.bytes]) !== identity) throw failure('SHELL_STDIN_OPERATION_CHANGED')
        return receipt.status === 'delivered' ? receipt : { ...receipt, status: 'unknown' as const }
      }
      const record = await this.owned(id, context), live = this.live.get(id)
      if (record.status === 'unknown') throw failure('SHELL_PROCESS_STATE_UNKNOWN')
      if (await this.inputUncertain(id)) throw failure('SHELL_STDIN_DELIVERY_UNKNOWN')
      if (record.command.pty !== true || record.status !== 'running' || !live?.write) throw failure('SHELL_STDIN_NOT_READY')
      const receipt: ShellInputReceipt = { processId: id, effectId: context.effectId, agentId: context.agentId, laneId: context.laneId, digest, bytes, status: 'pending' }
      await this.persistJson(path, receipt)
      live.inputSeen = true
      notifyProcess(live)
      try {
        context.signal.throwIfAborted()
        if (live.controller.signal.aborted || live.record.status !== 'running') throw failure('SHELL_STDIN_NOT_READY')
        await live.write(data)
        receipt.status = 'delivered'
        await this.persistJson(path, receipt)
        notifyProcess(live)
        return receipt
      } catch {
        receipt.status = 'unknown'
        await this.persistJson(path, receipt).catch(() => undefined)
        notifyProcess(live)
        return receipt
      }
    })
    this.inputs.set(context.effectId, { identity, promise: work })
    this.inputTail = work.then(() => undefined, () => undefined)
    return work
  }
  async inputReceipt(id: string, effectId: string, context: Pick<ToolContext, 'agentId' | 'laneId'>): Promise<ShellInputReceipt | undefined> {
    await this.owned(id, context)
    const text = await readFile(this.inputPath(effectId), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!text) return undefined
    const record = JSON.parse(text) as ShellInputReceipt
    if (record.processId !== id || record.effectId !== effectId || record.agentId !== context.agentId || record.laneId !== context.laneId) throw failure('RESULT_NOT_VISIBLE')
    return record.status === 'delivered' ? record : { ...record, status: 'unknown' }
  }
  /** Human run controls derive ownership internally; they never accept a PID or lane override. */
  private viewContext(record: ProcessReceipt): ToolContext {
    return { agentId: record.agentId, laneId: record.laneId, effectId: 'human-process-view', toolCallId: 'human-process-view', attemptId: 'human-process-view', signal: new AbortController().signal, emit() {} }
  }
  async list(): Promise<ProcessReceipt[]> {
    const files = await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const result: ProcessReceipt[] = []
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const id = name.slice(0, -5), saved = this.live.get(id)?.record ?? await this.saved(id)
      const record = await this.owned(id, this.viewContext(saved))
      const { result: output, ...meta } = record
      result.push({ ...meta, ...(output ? { result: { code: output.code, aborted: output.aborted, timedOut: output.timedOut } } : {}), ...(record.command.pty === undefined ? {} : { stdinReady: record.status === 'running' && this.live.get(id)?.write !== undefined, inputUncertain: await this.inputUncertain(id) }) })
    }
    return result
  }
  async readForUser(id: string, offset = 0) {
    const record = this.live.get(id)?.record ?? await this.saved(id)
    return this.poll(id, this.viewContext(record), offset, 8192, 0)
  }
  async cancelForUser(id: string) {
    const record = this.live.get(id)?.record ?? await this.saved(id)
    return this.cancel(id, this.viewContext(record))
  }
  async cancel(id: string, context: ToolContext): Promise<ProcessReceipt> {
    const record = await this.owned(id, context)
    if (record.status === 'unknown') throw failure('SHELL_PROCESS_STATE_UNKNOWN')
    const live = this.live.get(id)
    if (live?.record.status === 'running') { live.controller.abort(); await live.done }
    return this.owned(id, context)
  }
  async close(): Promise<void> {
    for (const live of this.live.values()) if (live.record.status === 'running') live.controller.abort()
    await Promise.all([...this.live.values()].map(live => live.done))
  }
}
export function shellProcesses(runDirectory: string): ShellProcesses {
  const directory = join(runDirectory, 'shell-processes')
  let manager = managers.get(directory)
  if (!manager) { manager = new ShellProcesses(directory); managers.set(directory, manager) }
  return manager
}

export async function closeShellProcesses(runDirectory: string): Promise<void> {
  const key = join(runDirectory, 'shell-processes'), manager = managers.get(key)
  if (!manager) return
  try { await manager.close() } finally { managers.delete(key) }
}
