import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import type { ToolContext } from '@hunterzhu/pulse-tool-sdk'
import { replaceStateFile } from './atomic-file.js'

export interface ShellCommand { command: string; args?: string[] | undefined; cwd?: string | undefined; timeoutMs?: number | undefined }
export interface ProcessReceipt {
  processId: string
  agentId: string
  laneId: string
  status: 'running' | 'exited' | 'unknown'
  command: ShellCommand
  result?: Record<string, unknown>
  error?: string
}
type Runner = (command: ShellCommand, context: ToolContext, onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => void) => Promise<Record<string, unknown>>
interface LiveProcess { record: ProcessReceipt; controller: AbortController; done: Promise<void> }
const managers = new Map<string, ShellProcesses>()
const failure = (code: string) => Object.assign(new Error(code), { code, retryable: false })

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
  constructor(readonly directory: string) {}
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw failure('INVALID_SHELL_PROCESS_ID')
    return join(this.directory, `${id}.json`)
  }
  private async persist(record: ProcessReceipt): Promise<void> {
    const path = this.path(record.processId), temporary = path + '.tmp'
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await replaceStateFile(temporary, path)
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
    const live: LiveProcess = { record, controller, done: Promise.resolve() }
    this.live.set(processId, live)
    let output = Promise.resolve(), bytes = 0
    const onOutput = (_stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const part = Buffer.from(chunk.subarray(0, Math.max(0, 16 * 1024 * 1024 - bytes)))
      bytes += part.length
      if (part.length) { output = output.then(() => appendFile(join(this.directory, `${processId}.log`), part, { mode: 0o600 })); void output.catch(() => undefined) }
    }
    live.done = (async () => {
      try {
        const result = await run(command, { ...context, signal: controller.signal }, onOutput)
        await output
        live.record = { ...record, status: 'exited', result }
      } catch (cause) {
        await output.catch(() => undefined)
        live.record = { ...record, status: 'unknown', error: String((cause as { code?: string }).code ?? 'SHELL_PROCESS_FAILED') }
      }
      await this.persist(live.record)
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
      try { await Promise.race([live.done, delay(waitMs, undefined, { signal: AbortSignal.any([context.signal, wait.signal]) })]) }
      finally { wait.abort() }
      record = await this.owned(id, context)
    }
    const log = await readFile(join(this.directory, `${id}.log`)).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
    let end = Math.min(log.length, offset + limit)
    if (offset < log.length && (log[offset]! & 0xc0) === 0x80) throw failure('SHELL_OUTPUT_OFFSET_INVALID')
    while (end > offset && end < log.length && (log[end]! & 0xc0) === 0x80) end--
    if (end === offset && end < log.length) { end++; while (end < log.length && (log[end]! & 0xc0) === 0x80) end++ }
    if (offset > log.length) throw failure('SHELL_OUTPUT_OFFSET_INVALID')
    return { ...record, ...(record.status === 'exited' ? record.result : {}), output: log.subarray(offset, end).toString('utf8'), offset, nextOffset: end, truncated: end < log.length }
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
